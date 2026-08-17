// Package sim answers "what would this balancer do if …".
//
// It runs the REAL strategy code from app/router against a frozen observation, using
// the simulation seam added by the patch series. Nothing is reimplemented here: a
// simulator that predicts leastLoad's behaviour is only worth trusting if it executes
// the same code that will actually run, and every setting (costs, baselines, expected,
// maxRTT, tolerance) interacts in ways a parallel implementation gets subtly wrong.
package sim

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/xtls/xray-core/app/observatory"
	"github.com/xtls/xray-core/app/router"
	"github.com/xtls/xray-core/common/serial"
	"github.com/xtls/xray-core/features/extension"
	"github.com/xtls/xray-core/xraytrace"
	"google.golang.org/protobuf/proto"

	"xraystudio/sidecar/trace"
)

// Request describes a hypothetical.
type Request struct {
	BalancerTag string   `json:"balancerTag"`
	Strategy    string   `json:"strategy"` // random | roundRobin | leastPing | leastLoad
	FallbackTag string   `json:"fallbackTag,omitempty"`
	Candidates  []string `json:"candidates"`

	// Observation is the starting point, normally captured from the live run.
	Observation []trace.ObsRow `json:"observation"`

	// Overrides mutate individual outbounds: "what if proxy-de were 40ms faster, or
	// dead?" Applied on top of Observation.
	Overrides []Override `json:"overrides,omitempty"`

	// leastLoad settings. Absent fields mean "unset", matching the config semantics.
	Expected   int32      `json:"expected,omitempty"`
	MaxRTTMs   int64      `json:"maxRttMs,omitempty"`
	Tolerance  float64    `json:"tolerance,omitempty"`
	BaselineMs []int64    `json:"baselineMs,omitempty"`
	Costs      []CostRule `json:"costs,omitempty"`

	// Trials drives the Monte-Carlo pass. random and leastLoad finish with a uniform
	// draw, so a single run reports one sample of a distribution rather than "the"
	// answer. Default 1000.
	Trials int `json:"trials,omitempty"`
}

// Override adjusts one outbound's observed state.
type Override struct {
	Tag     string `json:"tag"`
	Dead    bool   `json:"dead,omitempty"`
	DelayMs *int64 `json:"delayMs,omitempty"`
	DevNs   *int64 `json:"devNs,omitempty"`
	FailPct *int   `json:"failPct,omitempty"`
	Remove  bool   `json:"remove,omitempty"` // drop from the observation entirely
}

// CostRule mirrors routing.balancers[].strategy.settings.costs[].
type CostRule struct {
	Regexp bool    `json:"regexp,omitempty"`
	Match  string  `json:"match"`
	Value  float32 `json:"value,omitempty"`
}

// Response is one simulated decision plus the distribution over repeated draws.
type Response struct {
	Trace         trace.BalancerEval `json:"trace"`
	Distribution  []Outcome          `json:"distribution"`
	Trials        int                `json:"trials"`
	Deterministic bool               `json:"deterministic"`
}

// Outcome is one possible pick and how often it won.
type Outcome struct {
	Tag   string  `json:"tag"`
	Count int     `json:"count"`
	Share float64 `json:"share"`
}

// frozen is an Observatory that always returns the same snapshot.
type frozen struct {
	result *observatory.ObservationResult
}

func (f *frozen) Type() interface{} { return extension.ObservatoryType() }
func (f *frozen) Start() error      { return nil }
func (f *frozen) Close() error      { return nil }
func (f *frozen) GetObservation(context.Context) (proto.Message, error) {
	return f.result, nil
}

// Run executes the hypothetical.
func Run(req Request) (*Response, error) {
	if len(req.Candidates) == 0 {
		return nil, errors.New("no candidates")
	}
	trials := req.Trials
	if trials <= 0 {
		trials = 1000
	}

	rule, err := buildRule(req)
	if err != nil {
		return nil, err
	}
	obs := &frozen{result: buildObservation(req)}

	// One traced run for the funnel.
	bal, err := router.NewSimulationBalancer(rule, req.Candidates)
	if err != nil {
		return nil, err
	}
	bal.InjectObservatoryForSimulation(context.Background(), obs)

	// PickOutboundSimulated returns the trace instead of publishing it. Swapping the
	// global hook here would race with live traffic and would also flood the event
	// stream with a thousand decisions that never actually happened.
	_, captured, pickErr := bal.PickOutboundSimulated()
	if captured == nil {
		return nil, fmt.Errorf("simulation produced no trace (pick error: %v)", pickErr)
	}

	// Monte-Carlo for the distribution. A fresh balancer per trial keeps round-robin
	// from carrying its rotation index across runs, which would bias the result.
	counts := map[string]int{}
	for i := 0; i < trials; i++ {
		b, err := router.NewSimulationBalancer(rule, req.Candidates)
		if err != nil {
			return nil, err
		}
		b.InjectObservatoryForSimulation(context.Background(), obs)
		tag, _, _ := b.PickOutboundSimulated()
		counts[tag]++
	}

	dist := make([]Outcome, 0, len(counts))
	for tag, n := range counts {
		label := tag
		if label == "" {
			label = "(no tag — connection fails)"
		}
		dist = append(dist, Outcome{Tag: label, Count: n, Share: float64(n) / float64(trials)})
	}
	sort.Slice(dist, func(i, j int) bool {
		if dist[i].Count != dist[j].Count {
			return dist[i].Count > dist[j].Count
		}
		return dist[i].Tag < dist[j].Tag
	})

	return &Response{
		Trace:         toWire(captured),
		Distribution:  dist,
		Trials:        trials,
		Deterministic: len(dist) == 1,
	}, nil
}

func buildRule(req Request) (*router.BalancingRule, error) {
	rule := &router.BalancingRule{
		Tag:              req.BalancerTag,
		OutboundSelector: []string{""}, // unused: NewSimulationBalancer supplies candidates
		Strategy:         req.Strategy,
		FallbackTag:      req.FallbackTag,
	}
	if req.Strategy != "leastLoad" && req.Strategy != "leastload" {
		return rule, nil
	}

	cfg := &router.StrategyLeastLoadConfig{
		Expected:  req.Expected,
		MaxRTT:    int64(time.Duration(req.MaxRTTMs) * time.Millisecond),
		Tolerance: float32(req.Tolerance),
	}
	for _, b := range req.BaselineMs {
		cfg.Baselines = append(cfg.Baselines, int64(time.Duration(b)*time.Millisecond))
	}
	for _, c := range req.Costs {
		cfg.Costs = append(cfg.Costs, &router.StrategyWeight{
			Regexp: c.Regexp, Match: c.Match, Value: c.Value,
		})
	}
	rule.StrategySettings = serial.ToTypedMessage(cfg)
	return rule, nil
}

func buildObservation(req Request) *observatory.ObservationResult {
	byTag := map[string]*observatory.OutboundStatus{}
	order := make([]string, 0, len(req.Observation))
	for _, r := range req.Observation {
		s := &observatory.OutboundStatus{
			OutboundTag: r.Tag, Alive: r.Alive, Delay: r.DelayMs, LastErrorReason: r.LastErr,
		}
		if r.HasHP {
			s.HealthPing = &observatory.HealthPingMeasurementResult{
				All: r.All, Fail: r.Fail, Average: r.AvgNs,
				Deviation: r.DevNs, Max: r.MaxNs, Min: r.MinNs,
			}
		}
		byTag[r.Tag] = s
		order = append(order, r.Tag)
	}

	for _, o := range req.Overrides {
		s, ok := byTag[o.Tag]
		if !ok {
			continue
		}
		if o.Remove {
			delete(byTag, o.Tag)
			continue
		}
		if o.Dead {
			s.Alive = false
			// The plain observatory writes this sentinel rather than leaving delay
			// unset, and leastLoad's maxRTT filter compares against it — so a
			// simulation that left the old delay in place would misreport which
			// filter rejected the outbound.
			s.Delay = 99999999
		}
		if o.DelayMs != nil {
			s.Delay = *o.DelayMs
		}
		if o.DevNs != nil && s.HealthPing != nil {
			s.HealthPing.Deviation = *o.DevNs
		}
		if o.FailPct != nil && s.HealthPing != nil && s.HealthPing.All > 0 {
			s.HealthPing.Fail = s.HealthPing.All * int64(*o.FailPct) / 100
		}
	}

	out := &observatory.ObservationResult{}
	for _, tag := range order {
		if s, ok := byTag[tag]; ok {
			out.Status = append(out.Status, s)
		}
	}
	return out
}

func toWire(t *xraytrace.Trace) trace.BalancerEval {
	ev := trace.BalancerEval{
		BalancerTag: t.BalancerTag, Strategy: t.Strategy,
		Selectors: t.Selectors, Candidates: t.Candidates,
		Selected: t.Selected, Source: t.Source, FallbackTag: t.FallbackTag,
		Err: t.Err, DurationNs: t.DurationNs,
	}
	for _, r := range t.Observation {
		ev.Observation = append(ev.Observation, trace.ObsRow{
			Tag: r.Tag, Alive: r.Alive, DelayMs: r.DelayMs, HasHP: r.HasHP,
			All: r.All, Fail: r.Fail, AvgNs: r.AvgNs, DevNs: r.DevNs,
			MaxNs: r.MaxNs, MinNs: r.MinNs, LastErr: r.LastErr,
		})
	}
	for _, s := range t.Stages {
		st := trace.Stage{
			ID: s.ID, Kind: s.Kind, In: s.In, Out: s.Out,
			Scores: s.Scores, Params: s.Params, Note: s.Note,
		}
		for _, r := range s.Rejected {
			st.Rejected = append(st.Rejected, trace.Rejection{
				Tag: r.Tag, Reason: r.Reason, Values: r.Values,
			})
		}
		ev.Stages = append(ev.Stages, st)
	}
	return ev
}

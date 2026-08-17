package sim

import (
	"math"
	"testing"
	"time"

	"xraystudio/sidecar/trace"
)

func row(tag string, alive bool, delayMs int64, devMs int64, all, fail int64) trace.ObsRow {
	r := trace.ObsRow{Tag: tag, Alive: alive, DelayMs: delayMs}
	if all > 0 {
		r.HasHP = true
		r.All, r.Fail = all, fail
		r.AvgNs = int64(time.Duration(delayMs) * time.Millisecond)
		r.DevNs = int64(time.Duration(devMs) * time.Millisecond)
	}
	return r
}

func base() Request {
	return Request{
		BalancerTag: "bal",
		Strategy:    "leastLoad",
		Candidates:  []string{"a", "b", "c"},
		Observation: []trace.ObsRow{
			row("a", true, 100, 40, 10, 0),
			row("b", true, 50, 20, 10, 0),
			row("c", true, 200, 90, 10, 0),
		},
		Expected: 1,
		Trials:   500,
	}
}

func stage(t *testing.T, r *Response, id string) *trace.Stage {
	t.Helper()
	for i := range r.Trace.Stages {
		if r.Trace.Stages[i].ID == id {
			return &r.Trace.Stages[i]
		}
	}
	return nil
}

func TestExpectedOneIsDeterministic(t *testing.T) {
	res, err := Run(base())
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if res.Trace.Selected != "b" {
		t.Errorf("selected %q, want b (lowest deviation)", res.Trace.Selected)
	}
	if !res.Deterministic {
		t.Errorf("expected=1 with no baselines must be deterministic, got %+v", res.Distribution)
	}
	if len(res.Distribution) != 1 || res.Distribution[0].Share != 1 {
		t.Errorf("distribution = %+v, want a single outcome at 100%%", res.Distribution)
	}
}

// TestExpectedTwoIsAUniformDraw is the honesty check: with more than one survivor the
// last step is chance, and the simulator must report a distribution rather than
// pretending the first sample is the answer.
func TestExpectedTwoIsAUniformDraw(t *testing.T) {
	req := base()
	req.Expected = 2

	res, err := Run(req)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if res.Deterministic {
		t.Fatal("expected=2 leaves two survivors; it must not be reported as deterministic")
	}
	if len(res.Distribution) != 2 {
		t.Fatalf("distribution = %+v, want exactly a and b", res.Distribution)
	}
	for _, o := range res.Distribution {
		if o.Tag != "a" && o.Tag != "b" {
			t.Errorf("unexpected outcome %q — c is ranked third and must be truncated", o.Tag)
		}
		// dice.Roll is uniform; allow generous slack for 500 trials.
		if math.Abs(o.Share-0.5) > 0.12 {
			t.Errorf("%s share = %.2f, want ~0.50 (uniform over 2 survivors)", o.Tag, o.Share)
		}
	}
}

func TestMaxRTTChangesTheOutcome(t *testing.T) {
	req := base()
	req.MaxRTTMs = 75 // only b (50ms) survives

	res, err := Run(req)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if res.Trace.Selected != "b" {
		t.Fatalf("selected %q, want b", res.Trace.Selected)
	}

	filter := stage(t, res, "node_filter")
	if filter == nil {
		t.Fatal("no node_filter stage")
	}
	rejected := map[string]string{}
	for _, r := range filter.Rejected {
		rejected[r.Tag] = r.Reason
	}
	for _, tag := range []string{"a", "c"} {
		if rejected[tag] != "maxrtt_exceeded" {
			t.Errorf("%s rejected as %q, want maxrtt_exceeded", tag, rejected[tag])
		}
	}
}

// TestCostReordersRanking pins the scoring formula through the simulator: a cost of 9
// multiplies the score by sqrt(9) = 3, which is enough to push the otherwise-best
// candidate below another.
func TestCostReordersRanking(t *testing.T) {
	req := base()
	req.Candidates = []string{"a", "b"}
	req.Observation = []trace.ObsRow{
		row("a", true, 100, 40, 10, 0),
		row("b", true, 100, 50, 10, 0), // worse deviation, so normally loses
	}
	req.Costs = []CostRule{{Match: "a", Value: 9}}

	res, err := Run(req)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if res.Trace.Selected != "b" {
		t.Fatalf("selected %q, want b — a's 40ms x sqrt(9) = 120ms should lose to b's 50ms",
			res.Trace.Selected)
	}

	score := stage(t, res, "score")
	if score == nil {
		t.Fatal("no score stage")
	}
	want := int64(120 * time.Millisecond)
	if got := score.Scores["a"]; got != want {
		t.Errorf("score[a] = %d, want %d", got, want)
	}
}

func TestOverrideDeadRemovesCandidate(t *testing.T) {
	req := base()
	req.Overrides = []Override{{Tag: "b", Dead: true}}

	res, err := Run(req)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if res.Trace.Selected != "a" {
		t.Fatalf("selected %q, want a (b was killed, c is slower)", res.Trace.Selected)
	}
	filter := stage(t, res, "node_filter")
	for _, r := range filter.Rejected {
		if r.Tag == "b" && r.Reason != "not_alive" {
			t.Errorf("b rejected as %q, want not_alive", r.Reason)
		}
	}
}

// TestSpeedPriorityCanSelectNothing covers leastLoad mode 3 — baselines with
// expected <= 0 legitimately selects nothing and defers to fallbackTag. It is easy to
// mistake for a bug, so the simulator has to reproduce it faithfully.
func TestSpeedPriorityCanSelectNothing(t *testing.T) {
	req := base()
	req.Expected = 0
	req.BaselineMs = []int64{5} // nothing is under 5ms
	req.FallbackTag = "direct"

	res, err := Run(req)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if res.Trace.Selected != "direct" {
		t.Fatalf("selected %q, want the fallback", res.Trace.Selected)
	}
	if res.Trace.Source != "fallback_empty" {
		t.Errorf("source = %q, want fallback_empty", res.Trace.Source)
	}
}

// TestLeastPingIgnoresUnprobedCandidates checks the simulator reproduces the single
// most common real-world surprise rather than smoothing it over.
func TestLeastPingIgnoresUnprobedCandidates(t *testing.T) {
	res, err := Run(Request{
		BalancerTag: "bal",
		Strategy:    "leastPing",
		Candidates:  []string{"a", "b", "never-probed"},
		Observation: []trace.ObsRow{
			row("a", true, 100, 0, 0, 0),
			row("b", true, 50, 0, 0, 0),
		},
		Trials: 50,
	})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if res.Trace.Selected != "b" {
		t.Fatalf("selected %q, want b", res.Trace.Selected)
	}
	scan := stage(t, res, "min_scan")
	if scan == nil {
		t.Fatal("no min_scan stage")
	}
	found := false
	for _, r := range scan.Rejected {
		if r.Tag == "never-probed" && r.Reason == "not_in_observation" {
			found = true
		}
	}
	if !found {
		t.Errorf("unprobed candidate not reported; rejections = %+v", scan.Rejected)
	}
}

// TestRandomWithoutFallbackKeepsDeadOutbounds reproduces the observatory gate:
// random only consults the observatory when fallbackTag is set.
func TestRandomWithoutFallbackKeepsDeadOutbounds(t *testing.T) {
	req := Request{
		BalancerTag: "bal",
		Strategy:    "random",
		Candidates:  []string{"a", "b"},
		Observation: []trace.ObsRow{
			row("a", false, 99999999, 0, 0, 0),
			row("b", true, 50, 0, 0, 0),
		},
		Trials: 400,
	}

	noFallback, err := Run(req)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if len(noFallback.Distribution) != 2 {
		t.Errorf("without fallbackTag the dead outbound must still be picked; got %+v",
			noFallback.Distribution)
	}

	req.FallbackTag = "direct"
	withFallback, err := Run(req)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if len(withFallback.Distribution) != 1 || withFallback.Distribution[0].Tag != "b" {
		t.Errorf("with fallbackTag the observatory applies and only b is viable; got %+v",
			withFallback.Distribution)
	}
}

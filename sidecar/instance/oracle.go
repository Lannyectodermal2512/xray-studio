package instance

import (
	"fmt"
	"sort"
	"strings"

	"github.com/xtls/xray-core/features/routing"

	"xraystudio/sidecar/trace"
)

// Cross-checks against the core's own answers.
//
// The dashboard makes claims — "this outbound was rejected because it is not alive",
// "leastPing picks the lowest delay", "principle_target means different things per
// strategy". Those claims are only worth making if something keeps checking them, and
// the only authority available is the core itself.
//
// Router.GetPrincipleTarget is the right oracle because, unlike TestRoute, it is
// side-effect free for all four strategies: leastPing's implementation calls
// PickOutbound but that is a pure read, and leastLoad re-runs pickOutbounds without
// touching the dice. TestRoute would advance round-robin's rotation index and re-roll
// the random draw, so polling it would corrupt the very behaviour being observed.

// CheckStatus is the outcome of one cross-check.
type CheckStatus string

const (
	CheckOK      CheckStatus = "ok"
	CheckWarn    CheckStatus = "warn"
	CheckFail    CheckStatus = "fail"
	CheckSkipped CheckStatus = "skipped"
)

// Check is one verified claim.
type Check struct {
	ID       string      `json:"id"`
	Subject  string      `json:"subject"`
	Status   CheckStatus `json:"status"`
	Summary  string      `json:"summary"`
	Detail   string      `json:"detail,omitempty"`
	Expected string      `json:"expected,omitempty"`
	Actual   string      `json:"actual,omitempty"`
}

// SelfCheck is the full report.
type SelfCheck struct {
	Checks []Check `json:"checks"`
	OK     int     `json:"ok"`
	Warn   int     `json:"warn"`
	Fail   int     `json:"fail"`
}

// PrincipleTarget asks the core what a balancer's principle target is.
func (m *Manager) PrincipleTarget(tag string) ([]string, error) {
	m.mu.Lock()
	inst := m.inst
	m.mu.Unlock()
	if inst == nil {
		return nil, fmt.Errorf("not running")
	}
	r, ok := inst.GetFeature(routing.RouterType()).(routing.BalancerPrincipleTarget)
	if !ok {
		return nil, fmt.Errorf("router does not expose principle targets")
	}
	return r.GetPrincipleTarget(tag)
}

// OverrideTarget reports a pinned target, if any.
func (m *Manager) OverrideTarget(tag string) (string, error) {
	m.mu.Lock()
	inst := m.inst
	m.mu.Unlock()
	if inst == nil {
		return "", fmt.Errorf("not running")
	}
	r, ok := inst.GetFeature(routing.RouterType()).(routing.BalancerOverrider)
	if !ok {
		return "", fmt.Errorf("router does not expose overrides")
	}
	return r.GetOverrideTarget(tag)
}

// RunSelfCheck verifies what the dashboard asserts against the core's own answers.
//
// balancers maps a balancer tag to the strategy and candidate list observed in its
// most recent decision, which the caller takes from the event stream.
func (m *Manager) RunSelfCheck(balancers map[string]BalancerFacts) SelfCheck {
	var out SelfCheck

	obs := m.Observation()
	if obs == nil {
		out.Checks = append(out.Checks, Check{
			ID: "observation", Subject: "observatory", Status: CheckSkipped,
			Summary: "No observatory configured, so there is nothing to cross-check.",
			Detail: "leastPing and leastLoad need an observatory or burstObservatory block; " +
				"random and roundRobin only consult one when fallbackTag is set.",
		})
		out.tally()
		return out
	}

	byTag := map[string]trace.ObsRow{}
	for _, r := range obs {
		byTag[r.Tag] = r
	}

	if len(balancers) == 0 {
		out.Checks = append(out.Checks, Check{
			ID: "balancers", Subject: "balancers", Status: CheckSkipped,
			Summary: "No balancer decision seen yet.",
			Detail:  "A balancer evaluates once per dispatched connection; send traffic through the inbound.",
		})
	}

	for tag, f := range balancers {
		principle, err := m.PrincipleTarget(tag)
		if err != nil {
			out.Checks = append(out.Checks, Check{
				ID: "principle/" + tag, Subject: tag, Status: CheckFail,
				Summary: "The core refused to report a principle target.",
				Detail:  err.Error(),
			})
			continue
		}
		out.Checks = append(out.Checks, checkPrinciple(tag, f, principle, byTag))
	}

	out.tally()
	return out
}

// BalancerFacts is what the caller observed about a balancer from the event stream.
type BalancerFacts struct {
	Strategy   string
	Candidates []string
}

// checkPrinciple verifies the per-strategy meaning of principle_target.
//
// This is worth checking precisely because the meaning is inconsistent, and the UI
// tells users so. If a future Xray release made it uniform, the tooltips would silently
// become wrong; this turns that into a visible failure.
func checkPrinciple(tag string, f BalancerFacts, principle []string, obs map[string]trace.ObsRow) Check {
	c := Check{ID: "principle/" + tag, Subject: tag}
	strategy := strings.ToLower(f.Strategy)
	c.Actual = strings.Join(principle, ", ")

	switch strategy {
	case "random", "roundrobin":
		// Documented behaviour: the RAW selector output, with no liveness filter — even
		// when the observatory is active.
		want := append([]string(nil), f.Candidates...)
		got := append([]string(nil), principle...)
		sort.Strings(want)
		sort.Strings(got)
		c.Expected = strings.Join(want, ", ")
		if equal(want, got) {
			c.Status, c.Summary = CheckOK,
				"principle_target is the raw, unfiltered candidate list, as documented."
			return c
		}
		c.Status = CheckWarn
		c.Summary = "principle_target does not match the raw candidate list."
		c.Detail = "The dashboard documents this as unfiltered for random/roundRobin. " +
			"A mismatch means either the candidate set changed between the decision and " +
			"this check, or upstream behaviour changed."
		return c

	case "leastping":
		// Documented behaviour: exactly one tag, the current pick.
		if len(principle) != 1 {
			c.Status = CheckWarn
			c.Summary = fmt.Sprintf("Expected exactly one tag for leastPing, got %d.", len(principle))
			c.Expected = "a single tag"
			return c
		}
		best, bestDelay := "", int64(-1)
		for _, cand := range f.Candidates {
			r, ok := obs[cand]
			if !ok || !r.Alive {
				continue
			}
			if bestDelay < 0 || r.DelayMs < bestDelay {
				best, bestDelay = cand, r.DelayMs
			}
		}
		c.Expected = best
		if best == "" {
			c.Status = CheckSkipped
			c.Summary = "No alive candidate in the current observation to compare against."
			return c
		}
		if principle[0] == best {
			c.Status = CheckOK
			c.Summary = fmt.Sprintf("Picks the lowest-delay alive candidate (%dms), as documented.", bestDelay)
			return c
		}
		c.Status = CheckWarn
		c.Summary = "The core's pick is not the lowest-delay alive candidate we observed."
		c.Detail = "Most often a race: the observation moved between the decision and this " +
			"check. Persistent disagreement means the dashboard's model is wrong."
		return c

	case "leastload":
		// Documented behaviour: ranked survivors, post-truncation. We cannot predict the
		// truncation point without the balancer's settings, so assert the invariant that
		// does not need them: every survivor must be alive and a candidate.
		cands := map[string]bool{}
		for _, t := range f.Candidates {
			cands[t] = true
		}
		var bad []string
		for _, t := range principle {
			r, ok := obs[t]
			if !cands[t] || !ok || !r.Alive {
				bad = append(bad, t)
			}
		}
		c.Expected = "a subset of alive candidates"
		if len(bad) == 0 {
			c.Status = CheckOK
			c.Summary = fmt.Sprintf("All %d ranked survivors are alive candidates.", len(principle))
			return c
		}
		c.Status = CheckFail
		c.Summary = "principle_target contains outbounds that are not alive candidates."
		c.Detail = "Reported: " + strings.Join(bad, ", ")
		return c
	}

	c.Status = CheckSkipped
	c.Summary = "Unknown strategy; nothing to verify."
	return c
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func (s *SelfCheck) tally() {
	for _, c := range s.Checks {
		switch c.Status {
		case CheckOK:
			s.OK++
		case CheckWarn:
			s.Warn++
		case CheckFail:
			s.Fail++
		}
	}
}

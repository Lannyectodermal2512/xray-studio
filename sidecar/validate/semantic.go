package validate

import (
	"encoding/json"
	"fmt"
	"strings"

	"xraystudio/sidecar/trace"
)

// A deliberately loose view of the config.
//
// Parsed independently of infra/conf so the semantic checks still run on a config that
// infra/conf would reject outright — a user fixing one error should see the other
// problems waiting behind it, not discover them one restart at a time.
type view struct {
	Outbounds []struct {
		Tag      string          `json:"tag"`
		Protocol string          `json:"protocol"`
		Settings json.RawMessage `json:"settings"`
		Stream   *struct {
			Security string `json:"security"`
			Network  string `json:"network"`
			Sockopt  *struct {
				DialerProxy string `json:"dialerProxy"`
			} `json:"sockopt"`
		} `json:"streamSettings"`
		Mux *struct {
			Enabled     bool `json:"enabled"`
			Concurrency int  `json:"concurrency"`
		} `json:"mux"`
	} `json:"outbounds"`

	Inbounds []struct {
		Tag      string `json:"tag"`
		Protocol string `json:"protocol"`
		Settings *struct {
			Address string `json:"address"`
		} `json:"settings"`
	} `json:"inbounds"`

	Routing *struct {
		DomainStrategy string `json:"domainStrategy"`
		Balancers      []struct {
			Tag         string   `json:"tag"`
			Selector    []string `json:"selector"`
			FallbackTag string   `json:"fallbackTag"`
			Strategy    *struct {
				Type     string `json:"type"`
				Settings *struct {
					Expected  *int32   `json:"expected"`
					MaxRTT    *string  `json:"maxRTT"`
					Tolerance *float64 `json:"tolerance"`
					Baselines []string `json:"baselines"`
					Costs     []struct {
						Match  string  `json:"match"`
						Value  float64 `json:"value"`
						Regexp bool    `json:"regexp"`
					} `json:"costs"`
				} `json:"settings"`
			} `json:"strategy"`
		} `json:"balancers"`
		Rules []struct {
			BalancerTag string          `json:"balancerTag"`
			OutboundTag string          `json:"outboundTag"`
			InboundTag  json.RawMessage `json:"inboundTag"`
			RuleTag     string          `json:"ruleTag"`
		} `json:"rules"`
	} `json:"routing"`

	Observatory *struct {
		SubjectSelector []string `json:"subjectSelector"`
		ProbeURL        string   `json:"probeURL"`
		ProbeInterval   string   `json:"probeInterval"`
	} `json:"observatory"`

	BurstObservatory *struct {
		SubjectSelector []string `json:"subjectSelector"`
		PingConfig      *struct {
			Interval     string `json:"interval"`
			Sampling     int    `json:"sampling"`
			Connectivity string `json:"connectivity"`
		} `json:"pingConfig"`
	} `json:"burstObservatory"`

	API *struct {
		Tag      string   `json:"tag"`
		Listen   string   `json:"listen"`
		Services []string `json:"services"`
	} `json:"api"`

	Stats     json.RawMessage `json:"stats"`
	Transport json.RawMessage `json:"transport"`
	Reverse   json.RawMessage `json:"reverse"`
}

// Semantic runs the checks that matter most: configs Xray accepts and then does not
// act on.
func Semantic(raw []byte) []trace.Diagnostic {
	var v view
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil
	}
	var out []trace.Diagnostic
	add := func(d trace.Diagnostic) { out = append(out, d) }

	tags := outboundTags(v)
	checkRemovedFeatures(v, add)
	checkOutbounds(v, add)
	checkBalancers(v, tags, add)
	checkObservatories(v, add)
	checkAPI(v, add)
	checkTestability(v, tags, add)
	return out
}

func outboundTags(v view) []string {
	var tags []string
	for _, o := range v.Outbounds {
		if o.Tag != "" {
			tags = append(tags, o.Tag)
		}
	}
	return tags
}

// matching mirrors outbound.Manager.Select: a PREFIX match, not a glob or a regexp.
func matching(selectors, tags []string) []string {
	var out []string
	for _, tag := range tags {
		for _, sel := range selectors {
			if strings.HasPrefix(tag, sel) {
				out = append(out, tag)
				break
			}
		}
	}
	return out
}

func checkRemovedFeatures(v view, add func(trace.Diagnostic)) {
	if len(v.Transport) > 0 && string(v.Transport) != "null" {
		add(trace.Diagnostic{
			Severity: "error", Code: "removed_transport", Path: "transport",
			Message: "Global \"transport\" was removed; the config will not load.",
			Detail:  "Move these settings into each outbound's streamSettings.",
		})
	}
	if len(v.Reverse) > 0 && string(v.Reverse) != "null" {
		add(trace.Diagnostic{
			Severity: "error", Code: "removed_reverse", Path: "reverse",
			Message: "Legacy \"reverse\" was removed in 26.x; the config will not load.",
			Detail:  "Replaced by VLESS Reverse Proxy (outbounds[].settings.reverse).",
		})
	}
	if v.Routing != nil && v.Routing.DomainStrategy != "" {
		switch strings.ToLower(v.Routing.DomainStrategy) {
		case "asis", "ipifnonmatch", "ipondemand":
		default:
			add(trace.Diagnostic{
				Severity: "dysfunction", Code: "domain_strategy_unknown",
				Path:    "routing.domainStrategy",
				Message: fmt.Sprintf("%q is not a recognised value; it silently falls back to AsIs.", v.Routing.DomainStrategy),
				Detail:  "Valid: AsIs, IPIfNonMatch, IPOnDemand. Matching is case-insensitive, but a typo is not an error.",
			})
		}
	}
}

func checkOutbounds(v view, add func(trace.Diagnostic)) {
	if len(v.Outbounds) == 0 {
		add(trace.Diagnostic{
			Severity: "error", Code: "no_outbounds", Path: "outbounds",
			Message: "No outbounds are defined, so nothing can be dispatched.",
		})
		return
	}

	seen := map[string]int{}
	for i, o := range v.Outbounds {
		if o.Tag == "" {
			add(trace.Diagnostic{
				Severity: "warning", Code: "outbound_untagged",
				Path:    fmt.Sprintf("outbounds[%d]", i),
				Message: "This outbound has no tag, so no balancer or observatory can ever select it.",
				Detail: "Selectors and subjectSelectors match on tags; the manager only " +
					"tracks tagged handlers. An untagged outbound is reachable only as the " +
					"default (the first entry).",
			})
			continue
		}
		if prev, dup := seen[o.Tag]; dup {
			add(trace.Diagnostic{
				Severity: "error", Code: "duplicate_outbound_tag",
				Path:    fmt.Sprintf("outbounds[%d].tag", i),
				Message: fmt.Sprintf("Tag %q is already used by outbounds[%d].", o.Tag, prev),
				Detail:  "Xray refuses to start with duplicate outbound tags.",
			})
		}
		seen[o.Tag] = i

		// XTLS-Vision needs a TLS-like outer layer. The config loads either way; the
		// failure appears per connection at handshake time.
		if o.Stream != nil && bytesContains(o.Settings, "xtls-rprx-vision") {
			sec := strings.ToLower(o.Stream.Security)
			if sec != "tls" && sec != "reality" {
				add(trace.Diagnostic{
					Severity: "dysfunction", Code: "vision_needs_tls",
					Path: fmt.Sprintf("outbounds[%d].streamSettings.security", i),
					Message: fmt.Sprintf("flow xtls-rprx-vision requires TLS or REALITY, but security is %q.",
						o.Stream.Security),
					Detail: "The config loads; every connection then fails at handshake with " +
						"\"XTLS only supports TLS and REALITY directly for now.\"",
				})
			}
		}
	}
}

func checkBalancers(v view, tags []string, add func(trace.Diagnostic)) {
	if v.Routing == nil {
		return
	}
	hasObservatory := v.Observatory != nil
	hasBurst := v.BurstObservatory != nil

	known := map[string]bool{}
	for _, t := range tags {
		known[t] = true
	}
	balancerTags := map[string]bool{}

	for i, b := range v.Routing.Balancers {
		p := fmt.Sprintf("routing.balancers[%d]", i)
		balancerTags[b.Tag] = true

		strategy := "random"
		if b.Strategy != nil && b.Strategy.Type != "" {
			strategy = strings.ToLower(b.Strategy.Type)
		}

		// Nothing checks this at load: balancers are built before outbounds exist.
		cands := matching(b.Selector, tags)
		if len(cands) == 0 {
			add(trace.Diagnostic{
				Severity: "dysfunction", Code: "selector_matches_nothing",
				Path: p + ".selector",
				Message: fmt.Sprintf("Selector %v matches none of the outbound tags.",
					b.Selector),
				Detail: "Selectors are PREFIX matches, not globs or regexps. This balancer " +
					"has no candidates, so every request falls back or fails — and Xray " +
					"never checks this, because balancers are built before outbounds exist. " +
					"Tags present: " + strings.Join(tags, ", "),
			})
		}

		needsObs := strategy == "leastping" || strategy == "leastload"
		if needsObs && !hasObservatory && !hasBurst {
			add(trace.Diagnostic{
				Severity: "error", Code: "strategy_needs_observatory",
				Path: p + ".strategy.type",
				Message: fmt.Sprintf("Strategy %q requires an observatory, and none is configured.",
					strategy),
				Detail: "Xray fails to start with the opaque message \"not all dependencies " +
					"are resolved.\", naming neither the balancer nor the strategy — the " +
					"dependency is bound lazily, so the failure surfaces far from its cause. " +
					"Add an \"observatory\" or \"burstObservatory\" block.",
			})
		}

		// The observatory-consulting gate that catches people out.
		if !needsObs && (hasObservatory || hasBurst) && b.FallbackTag == "" {
			add(trace.Diagnostic{
				Severity: "warning", Code: "observatory_ignored",
				Path: p,
				Message: fmt.Sprintf("%s ignores the observatory because fallbackTag is not set.",
					strategy),
				Detail: "random and roundRobin only bind an observatory when fallbackTag is " +
					"present. Without it this balancer will pick dead outbounds as readily " +
					"as live ones, even though health checks are running.",
			})
		}

		if b.FallbackTag != "" && !known[b.FallbackTag] {
			add(trace.Diagnostic{
				Severity: "dysfunction", Code: "fallback_tag_unknown",
				Path:    p + ".fallbackTag",
				Message: fmt.Sprintf("fallbackTag %q is not an outbound tag.", b.FallbackTag),
				Detail: "Nothing validates this. When the balancer falls back, the dispatcher " +
					"cannot find the handler and quietly uses the DEFAULT outbound — the " +
					"first one in the config — so traffic leaves through the wrong proxy.",
			})
		}

		// Subject coverage: a candidate the observatory never probes is invisible to
		// leastPing and leastLoad, which iterate the observation rather than the
		// candidate list.
		if needsObs && len(cands) > 0 {
			var subj []string
			if hasBurst {
				subj = v.BurstObservatory.SubjectSelector
			} else if hasObservatory {
				subj = v.Observatory.SubjectSelector
			}
			covered := map[string]bool{}
			for _, t := range matching(subj, cands) {
				covered[t] = true
			}
			var missing []string
			for _, c := range cands {
				if !covered[c] {
					missing = append(missing, c)
				}
			}
			if len(missing) > 0 {
				sev, msg := "dysfunction", "Some candidates are never probed."
				if len(missing) == len(cands) {
					msg = "None of this balancer's candidates are probed."
				}
				add(trace.Diagnostic{
					Severity: sev, Code: "observatory_missing_candidates",
					Path:    p + ".selector",
					Message: msg + " " + strings.Join(missing, ", "),
					Detail: "leastPing and leastLoad iterate the observation, not the " +
						"candidate list, so an outbound the observatory never probes is " +
						"invisible to them — not rejected, simply absent. Widen " +
						"subjectSelector to cover these tags.",
				})
			}
		}

		if b.Strategy == nil || b.Strategy.Settings == nil {
			continue
		}
		s := b.Strategy.Settings

		// Settings are loaded by a per-strategy loader; every strategy except leastLoad
		// maps to an empty config that unmarshals and discards them.
		if strategy != "leastload" {
			add(trace.Diagnostic{
				Severity: "dysfunction", Code: "strategy_settings_ignored",
				Path:    p + ".strategy.settings",
				Message: fmt.Sprintf("Strategy %q ignores these settings entirely.", strategy),
				Detail: "Only leastLoad reads costs/baselines/expected/maxRTT/tolerance. " +
					"For every other strategy they are parsed and thrown away without a warning.",
			})
			continue
		}

		if s.Tolerance != nil {
			if *s.Tolerance < 0 || *s.Tolerance > 1 {
				add(trace.Diagnostic{
					Severity: "warning", Code: "leastload_clamped",
					Path:    p + ".strategy.settings.tolerance",
					Message: fmt.Sprintf("tolerance %v is outside [0,1] and will be silently clamped.", *s.Tolerance),
					Detail:  "It is a failure RATE, not a percentage: 0.5 means half the probes failing.",
				})
			}
			if *s.Tolerance > 0 && !hasBurst {
				add(trace.Diagnostic{
					Severity: "dysfunction", Code: "tolerance_inert",
					Path:    p + ".strategy.settings.tolerance",
					Message: "tolerance does nothing without burstObservatory.",
					Detail: "The filter needs HealthPing data (all/fail counts), which only " +
						"burstObservatory produces. Under the plain observatory the setting " +
						"parses, clamps, and is then never consulted.",
				})
			}
		}

		if s.Expected != nil && *s.Expected < 0 {
			add(trace.Diagnostic{
				Severity: "warning", Code: "leastload_clamped",
				Path:    p + ".strategy.settings.expected",
				Message: "A negative expected is silently treated as unset.",
			})
		}

		// Speed-priority mode is legitimate but easy to configure by accident.
		expectedUnset := s.Expected == nil || *s.Expected <= 0
		if len(s.Baselines) > 0 && expectedUnset && b.FallbackTag == "" {
			add(trace.Diagnostic{
				Severity: "dysfunction", Code: "speed_priority_no_fallback",
				Path:    p + ".strategy.settings",
				Message: "Baselines with expected <= 0 can legitimately select nothing, and there is no fallbackTag.",
				Detail: "This is leastLoad's speed-priority mode: if no outbound comes in " +
					"under a baseline it selects none, and without a fallbackTag every " +
					"request then fails. Set expected, or add a fallbackTag.",
			})
		}
	}

	for i, r := range v.Routing.Rules {
		if r.BalancerTag != "" && !balancerTags[r.BalancerTag] {
			add(trace.Diagnostic{
				Severity: "error", Code: "balancer_tag_unknown",
				Path:    fmt.Sprintf("routing.rules[%d].balancerTag", i),
				Message: fmt.Sprintf("No balancer is defined with tag %q.", r.BalancerTag),
				Detail:  "Xray refuses to start: \"balancer " + r.BalancerTag + " not found\".",
			})
		}
		if r.OutboundTag != "" && !known[r.OutboundTag] {
			add(trace.Diagnostic{
				Severity: "dysfunction", Code: "rule_outbound_unknown",
				Path:    fmt.Sprintf("routing.rules[%d].outboundTag", i),
				Message: fmt.Sprintf("No outbound is defined with tag %q.", r.OutboundTag),
				Detail:  "Matching traffic is dropped rather than routed to the default outbound.",
			})
		}
		if r.BalancerTag != "" && r.OutboundTag != "" {
			add(trace.Diagnostic{
				Severity: "warning", Code: "rule_both_targets",
				Path:    fmt.Sprintf("routing.rules[%d]", i),
				Message: "This rule sets both outboundTag and balancerTag; outboundTag wins.",
				Detail:  "The balancer is never consulted for traffic matching this rule.",
			})
		}
	}
}

func checkObservatories(v view, add func(trace.Diagnostic)) {
	if v.Observatory != nil && len(v.Observatory.SubjectSelector) == 0 {
		add(trace.Diagnostic{
			Severity: "dysfunction", Code: "observatory_no_subjects",
			Path:    "observatory.subjectSelector",
			Message: "An empty subjectSelector makes the observatory a no-op.",
			Detail: "Start() returns immediately without scheduling anything, so the status " +
				"list stays permanently empty and every leastPing/leastLoad decision sees nothing.",
		})
	}
	if v.BurstObservatory != nil {
		if len(v.BurstObservatory.SubjectSelector) == 0 {
			add(trace.Diagnostic{
				Severity: "dysfunction", Code: "observatory_no_subjects",
				Path:    "burstObservatory.subjectSelector",
				Message: "An empty subjectSelector makes the observatory a no-op.",
			})
		}
		if v.BurstObservatory.PingConfig == nil {
			add(trace.Diagnostic{
				Severity: "error", Code: "burst_needs_pingconfig",
				Path:    "burstObservatory.pingConfig",
				Message: "burstObservatory requires a pingConfig block.",
			})
		} else if d, ok := parseDuration(v.BurstObservatory.PingConfig.Interval); ok && d > 0 && d < 10_000 {
			add(trace.Diagnostic{
				Severity: "warning", Code: "burst_interval_clamped",
				Path: "burstObservatory.pingConfig.interval",
				Message: fmt.Sprintf("interval %s is below the 10s minimum and will be clamped.",
					v.BurstObservatory.PingConfig.Interval),
				Detail: "This clamp was fixed in v26.7.28; earlier builds compared against 10 " +
					"nanoseconds and so honoured almost any value. A config tuned on an older " +
					"build will probe far less often here.",
			})
		}
	}
	if v.Observatory != nil && v.BurstObservatory != nil {
		add(trace.Diagnostic{
			Severity: "warning", Code: "two_observatories",
			Path:    "burstObservatory",
			Message: "Both observatory and burstObservatory are configured; only one takes effect.",
			Detail: "Features are resolved by type and the first match wins, so one block is " +
				"silently unused — and which one is not obvious from the config.",
		})
	}
}

func checkAPI(v view, add func(trace.Diagnostic)) {
	if v.API == nil {
		return
	}
	if v.API.Tag == "" {
		add(trace.Diagnostic{
			Severity: "error", Code: "api_no_tag", Path: "api.tag",
			Message: "api.tag cannot be empty.",
		})
		return
	}
	if v.API.Listen != "" {
		return
	}
	// With no listen address the commander registers an in-memory OUTBOUND named
	// api.tag; reaching it needs a dokodemo inbound plus a routing rule.
	hasRule := false
	if v.Routing != nil {
		for _, r := range v.Routing.Rules {
			if r.OutboundTag == v.API.Tag {
				hasRule = true
			}
		}
	}
	hasDokodemo := false
	for _, in := range v.Inbounds {
		if strings.EqualFold(in.Protocol, "dokodemo-door") || strings.EqualFold(in.Protocol, "tunnel") {
			hasDokodemo = true
		}
	}
	if !hasRule || !hasDokodemo {
		add(trace.Diagnostic{
			Severity: "dysfunction", Code: "api_unreachable", Path: "api",
			Message: "The API is configured but nothing can reach it.",
			Detail: "With an empty api.listen, Xray exposes the API as an in-memory outbound " +
				"named \"" + v.API.Tag + "\". It needs a dokodemo-door inbound plus a routing " +
				"rule pointing at that tag — otherwise the gRPC server exists and is " +
				"unreachable, with no error and no log line. Setting api.listen instead " +
				"binds it directly.",
		})
	}
}

// parseDuration handles the "10s"/"1m" forms Xray accepts, returning milliseconds.
func parseDuration(s string) (int64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	var num float64
	var unit string
	if _, err := fmt.Sscanf(s, "%f%s", &num, &unit); err != nil {
		return 0, false
	}
	switch unit {
	case "ns":
		return int64(num / 1e6), true
	case "us", "µs":
		return int64(num / 1e3), true
	case "ms":
		return int64(num), true
	case "s":
		return int64(num * 1000), true
	case "m":
		return int64(num * 60000), true
	case "h":
		return int64(num * 3600000), true
	}
	return 0, false
}

func bytesContains(b json.RawMessage, s string) bool {
	return len(b) > 0 && strings.Contains(string(b), s)
}

/* ── testability ───────────────────────────────────────────────────────────────
 *
 * These do not break the config. They break the ability to TEST it, which for this
 * tool is worth saying out loud: each one makes an injected fault appear to do nothing,
 * and the natural conclusion is that the tool is broken rather than the config being
 * hard to observe.
 */

func checkTestability(v view, tags []string, add func(trace.Diagnostic)) {
	// 1. mux keeps one physical connection and multiplexes over it, so a dialer-level
	//    fault only fires when a NEW dial happens. Probes ride the existing tunnel.
	var muxed []string
	for _, o := range v.Outbounds {
		if o.Mux != nil && o.Mux.Enabled && o.Tag != "" {
			muxed = append(muxed, o.Tag)
		}
	}
	if len(muxed) > 0 {
		add(trace.Diagnostic{
			Severity: "info", Code: "mux_hides_faults", Path: "outbounds[].mux",
			Message: fmt.Sprintf("%d outbound(s) use mux, so injected faults take effect only after the live connection is dropped: %s",
				len(muxed), strings.Join(muxed, ", ")),
			Detail: "Mux multiplexes many streams over ONE physical connection and reuses it " +
				"while it has spare concurrency, so observatory probes keep succeeding over the " +
				"existing tunnel and no new dial reaches the fault dialer. Applying a hard-down " +
				"fault (blackhole, refuse, host/net unreachable, dns_fail) also poisons live " +
				"connections, which forces a redial — softer faults such as latency or throttle " +
				"will only affect connections opened afterwards.",
		})
	}

	// 2. sockopt.dialerProxy hops never reach the dialer at all.
	var chained []string
	for _, o := range v.Outbounds {
		if o.Stream != nil && o.Stream.Sockopt != nil && o.Stream.Sockopt.DialerProxy != "" && o.Tag != "" {
			chained = append(chained, o.Tag+" -> "+o.Stream.Sockopt.DialerProxy)
		}
	}
	if len(chained) > 0 {
		add(trace.Diagnostic{
			Severity: "info", Code: "dialer_proxy_bypasses_faults", Path: "outbounds[].streamSettings.sockopt.dialerProxy",
			Message: fmt.Sprintf("%d outbound(s) dial through another outbound; faults on the OUTER tag will not fire: %s",
				len(chained), strings.Join(chained, ", ")),
			Detail: "A dialerProxy hop is served by an internal redirect that returns a pipe, " +
				"never reaching the system dialer. Fault the outbound named in dialerProxy " +
				"instead — that one does perform a real dial.",
		})
	}

	// 3. connectivity discards failures outright.
	if v.BurstObservatory != nil && v.BurstObservatory.PingConfig != nil && v.BurstObservatory.PingConfig.Connectivity != "" {
		add(trace.Diagnostic{
			Severity: "dysfunction", Code: "connectivity_discards_failures",
			Path:    "burstObservatory.pingConfig.connectivity",
			Message: "A failed probe is DISCARDED, not recorded, whenever this URL is unreachable.",
			Detail: "After any probe failure Xray fetches the connectivity URL through a plain " +
				"HTTP client that bypasses Xray entirely. If that fetch fails it logs \"network is " +
				"down\" and pushes a zero result, which the collector drops — the failure never " +
				"enters the sampling window and the outbound stays marked alive indefinitely. " +
				"It exists to suppress false negatives when your own uplink is down, but it also " +
				"hides real failures and injected faults. Leave it empty while testing.",
		})
	}

}

// Probe cadence is deliberately NOT a diagnostic here. It is not a defect — almost every
// real config has a round measured in tens of seconds — and reporting it would put noise
// in a panel that is about the config being wrong. The Faults panel computes and shows it
// at the moment it actually matters: when a fault has just been injected.

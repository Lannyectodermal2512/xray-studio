package validate

import (
	"strings"
	"testing"

	"xraystudio/sidecar/trace"
)

func run(t *testing.T, cfg string) []trace.Diagnostic {
	t.Helper()
	var out []trace.Diagnostic
	out = append(out, UnknownKeys([]byte(cfg))...)
	out = append(out, Semantic([]byte(cfg))...)
	return out
}

func has(diags []trace.Diagnostic, code string) *trace.Diagnostic {
	for i := range diags {
		if diags[i].Code == code {
			return &diags[i]
		}
	}
	return nil
}

func mustHave(t *testing.T, diags []trace.Diagnostic, code string) trace.Diagnostic {
	t.Helper()
	d := has(diags, code)
	if d == nil {
		var got []string
		for _, x := range diags {
			got = append(got, x.Code)
		}
		t.Fatalf("expected diagnostic %q; got %v", code, got)
	}
	return *d
}

func mustNotHave(t *testing.T, diags []trace.Diagnostic, code string) {
	t.Helper()
	if d := has(diags, code); d != nil {
		t.Fatalf("unexpected diagnostic %q at %s: %s", code, d.Path, d.Message)
	}
}

// TestUnknownKeyIsCaught covers the highest-value rule. Go's decoder ignores unknown
// fields, so a plural slip produces a config that starts and behaves as though the
// block were absent — no error, no log line.
func TestUnknownKeyIsCaught(t *testing.T) {
	d := mustHave(t, run(t, `{
	  "outbounds": [{"tag":"a","protocol":"freedom"}],
	  "routing": { "balancer": [ {"tag":"bal"} ] }
	}`), "unknown_key")

	if d.Path != "routing.balancer" {
		t.Errorf("path = %q, want routing.balancer", d.Path)
	}
	if !strings.Contains(d.Detail, "balancers") {
		t.Errorf("expected a suggestion naming \"balancers\", got: %s", d.Detail)
	}
}

// TestCaseInsensitiveKeysAreAccepted guards against the validator being stricter than
// the parser: encoding/json matches field names case-insensitively, so "probeUrl" and
// "PROBEURL" genuinely work and must not be reported.
func TestCaseInsensitiveKeysAreAccepted(t *testing.T) {
	mustNotHave(t, run(t, `{
	  "outbounds": [{"tag":"a","protocol":"freedom"}],
	  "observatory": { "subjectSelector":["a"], "probeUrl":"http://x/", "PROBEINTERVAL":"5s" }
	}`), "unknown_key")
}

// TestRemarksIsNotReported: "remarks" is the client ecosystem's profile label, written
// by v2rayN, Nekoray, Hiddify and the panels that generate subscriptions. The core
// really does ignore it, but nobody expected otherwise — flagging it as a dysfunction
// fired on every config from a panel and taught people to scroll past the findings that
// matter.
func TestRemarksIsNotReported(t *testing.T) {
	mustNotHave(t, run(t, `{
	  "remarks": "Germany · node-3",
	  "outbounds": [{"tag":"a","protocol":"freedom","remarks":"exit"}]
	}`), "unknown_key")
}

// A near miss is still a near miss: only the exact word is exempt, so a typo in it is
// reported like any other unreadable key.
func TestRemarkSingularIsStillReported(t *testing.T) {
	mustHave(t, run(t, `{
	  "remark": "Germany",
	  "outbounds": [{"tag":"a","protocol":"freedom"}]
	}`), "unknown_key")
}

// TestProtocolSettingsAreOpaque: inbounds[].settings is decoded later by a
// protocol-specific loader, so its keys are unknowable from the top-level type graph
// and must never be flagged.
func TestProtocolSettingsAreOpaque(t *testing.T) {
	mustNotHave(t, run(t, `{
	  "inbounds": [{"tag":"in","protocol":"socks","port":1080,
	                "settings":{"auth":"noauth","udp":true,"anythingAtAll":42}}],
	  "outbounds": [{"tag":"a","protocol":"freedom",
	                 "settings":{"domainStrategy":"UseIP","redirect":"1.2.3.4:0"}}]
	}`), "unknown_key")
}

func TestSelectorMatchingNothing(t *testing.T) {
	d := mustHave(t, run(t, `{
	  "outbounds": [{"tag":"proxy-a","protocol":"freedom"}],
	  "routing": { "balancers": [{"tag":"bal","selector":["node-"]}],
	               "rules": [{"balancerTag":"bal"}] }
	}`), "selector_matches_nothing")

	if !strings.Contains(d.Detail, "PREFIX") {
		t.Errorf("the message should explain prefix matching: %s", d.Detail)
	}
	if !strings.Contains(d.Detail, "proxy-a") {
		t.Errorf("the message should list the available tags: %s", d.Detail)
	}
}

func TestLeastLoadWithoutObservatory(t *testing.T) {
	d := mustHave(t, run(t, `{
	  "outbounds": [{"tag":"proxy-a","protocol":"freedom"}],
	  "routing": { "balancers": [{"tag":"bal","selector":["proxy-"],
	                              "strategy":{"type":"leastLoad"}}],
	               "rules": [{"balancerTag":"bal"}] }
	}`), "strategy_needs_observatory")

	if d.Severity != "error" {
		t.Errorf("severity = %q, want error — the instance will not start", d.Severity)
	}
	if !strings.Contains(d.Detail, "not all dependencies") {
		t.Errorf("should quote the opaque error the user will actually see: %s", d.Detail)
	}
}

func TestObservatoryMissingCandidates(t *testing.T) {
	d := mustHave(t, run(t, `{
	  "outbounds": [{"tag":"proxy-a","protocol":"freedom"},
	                {"tag":"proxy-b","protocol":"freedom"}],
	  "observatory": {"subjectSelector":["proxy-a"]},
	  "routing": { "balancers": [{"tag":"bal","selector":["proxy-"],
	                              "strategy":{"type":"leastPing"}}],
	               "rules": [{"balancerTag":"bal"}] }
	}`), "observatory_missing_candidates")

	if !strings.Contains(d.Message, "proxy-b") {
		t.Errorf("should name the unprobed candidate: %s", d.Message)
	}
}

func TestFallbackTagToNowhere(t *testing.T) {
	d := mustHave(t, run(t, `{
	  "outbounds": [{"tag":"proxy-a","protocol":"freedom"}],
	  "routing": { "balancers": [{"tag":"bal","selector":["proxy-"],"fallbackTag":"direct"}],
	               "rules": [{"balancerTag":"bal"}] }
	}`), "fallback_tag_unknown")

	// The consequence is the surprising part: traffic silently leaves via the first
	// outbound rather than erroring.
	if !strings.Contains(d.Detail, "first one in the config") {
		t.Errorf("should explain where traffic actually goes: %s", d.Detail)
	}
}

func TestStrategySettingsIgnored(t *testing.T) {
	mustHave(t, run(t, `{
	  "outbounds": [{"tag":"proxy-a","protocol":"freedom"}],
	  "routing": { "balancers": [{"tag":"bal","selector":["proxy-"],
	     "strategy":{"type":"roundRobin","settings":{"expected":2,"baselines":["100ms"]}}}],
	     "rules": [{"balancerTag":"bal"}] }
	}`), "strategy_settings_ignored")
}

func TestToleranceInertWithoutBurst(t *testing.T) {
	cfg := `{
	  "outbounds": [{"tag":"proxy-a","protocol":"freedom"}],
	  "observatory": {"subjectSelector":["proxy-"]},
	  "routing": { "balancers": [{"tag":"bal","selector":["proxy-"],
	     "strategy":{"type":"leastLoad","settings":{"tolerance":0.5}}}],
	     "rules": [{"balancerTag":"bal"}] }
	}`
	mustHave(t, run(t, cfg), "tolerance_inert")

	// With burstObservatory it is live, so the warning must disappear.
	withBurst := strings.Replace(cfg,
		`"observatory": {"subjectSelector":["proxy-"]},`,
		`"burstObservatory": {"subjectSelector":["proxy-"],"pingConfig":{"interval":"30s"}},`, 1)
	mustNotHave(t, run(t, withBurst), "tolerance_inert")
}

func TestSpeedPriorityWithoutFallback(t *testing.T) {
	mustHave(t, run(t, `{
	  "outbounds": [{"tag":"proxy-a","protocol":"freedom"}],
	  "burstObservatory": {"subjectSelector":["proxy-"],"pingConfig":{"interval":"30s"}},
	  "routing": { "balancers": [{"tag":"bal","selector":["proxy-"],
	     "strategy":{"type":"leastLoad","settings":{"baselines":["100ms"]}}}],
	     "rules": [{"balancerTag":"bal"}] }
	}`), "speed_priority_no_fallback")
}

// TestObservatoryIgnoredGate covers the behaviour that catches people out most often:
// random and roundRobin only consult an observatory when fallbackTag is set.
func TestObservatoryIgnoredGate(t *testing.T) {
	cfg := `{
	  "outbounds": [{"tag":"proxy-a","protocol":"freedom"},{"tag":"direct","protocol":"freedom"}],
	  "observatory": {"subjectSelector":["proxy-"]},
	  "routing": { "balancers": [{"tag":"bal","selector":["proxy-"],
	     "strategy":{"type":"random"}%s}],
	     "rules": [{"balancerTag":"bal"}] }
	}`
	mustHave(t, run(t, strings_Replace(cfg, "%s", "")), "observatory_ignored")
	mustNotHave(t, run(t, strings_Replace(cfg, "%s", `,"fallbackTag":"direct"`)), "observatory_ignored")
}

func TestBurstIntervalClamp(t *testing.T) {
	d := mustHave(t, run(t, `{
	  "outbounds": [{"tag":"proxy-a","protocol":"freedom"}],
	  "burstObservatory": {"subjectSelector":["proxy-"],"pingConfig":{"interval":"2s"}}
	}`), "burst_interval_clamped")

	if !strings.Contains(d.Detail, "v26.7.28") {
		t.Errorf("should explain the version-dependent behaviour: %s", d.Detail)
	}
}

func TestApiUnreachable(t *testing.T) {
	mustHave(t, run(t, `{
	  "outbounds": [{"tag":"proxy-a","protocol":"freedom"}],
	  "api": {"tag":"api","services":["StatsService"]}
	}`), "api_unreachable")

	// With the inbound + rule triangle it is reachable.
	mustNotHave(t, run(t, `{
	  "inbounds": [{"tag":"api-in","protocol":"dokodemo-door","port":10085,
	                "settings":{"address":"127.0.0.1"}}],
	  "outbounds": [{"tag":"proxy-a","protocol":"freedom"}],
	  "api": {"tag":"api","services":["StatsService"]},
	  "routing": {"rules":[{"inboundTag":["api-in"],"outboundTag":"api"}]}
	}`), "api_unreachable")
}

func TestRemovedFeatures(t *testing.T) {
	diags := run(t, `{
	  "outbounds": [{"tag":"a","protocol":"freedom"}],
	  "transport": {"tcpSettings":{}},
	  "routing": {"domainStrategy":"IPIfNoMatch"}
	}`)
	mustHave(t, diags, "removed_transport")
	// A near-miss on domainStrategy is silently treated as AsIs.
	mustHave(t, diags, "domain_strategy_unknown")
}

func TestCleanConfigIsQuiet(t *testing.T) {
	diags := run(t, `{
	  "log": {"loglevel":"warning"},
	  "inbounds": [{"tag":"in","listen":"127.0.0.1","port":1080,"protocol":"socks",
	                "settings":{"auth":"noauth"}}],
	  "outbounds": [{"tag":"proxy-a","protocol":"freedom"},
	                {"tag":"proxy-b","protocol":"freedom"},
	                {"tag":"direct","protocol":"freedom"}],
	  "burstObservatory": {"subjectSelector":["proxy-"],
	                       "pingConfig":{"interval":"30s","sampling":5}},
	  "routing": {
	    "balancers": [{"tag":"bal","selector":["proxy-"],"fallbackTag":"direct",
	                   "strategy":{"type":"leastLoad","settings":{"expected":2}}}],
	    "rules": [{"inboundTag":["in"],"balancerTag":"bal"}]
	  }
	}`)
	if len(diags) != 0 {
		for _, d := range diags {
			t.Errorf("unexpected %s at %s: %s", d.Code, d.Path, d.Message)
		}
	}
}

// strings_Replace is a tiny helper so the table above stays readable.
func strings_Replace(s, old, new string) string { return strings.Replace(s, old, new, 1) }

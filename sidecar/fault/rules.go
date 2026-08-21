// Package fault injects realistic network failures into specific Xray outbounds.
//
// It works by replacing Xray's system dialer (internet.UseAlternativeSystemDialer,
// which is exported and marked xray:api:stable), so no fork is required for this part.
//
// Why this is faithful: observatory probes and user traffic go through the SAME dial
// path — observer.probe -> tagged.Dialer -> dispatcher -> outbound handler ->
// internet.Dial -> DialSystem -> the effective system dialer. A fault installed here
// is therefore seen identically by the health checks and by real connections, which
// is exactly how a firewall whitelist behaves. Anything that faulted only one of the
// two would produce balancer behaviour that could never happen in reality.
package fault

import (
	"fmt"
	"regexp"
	"strings"
	"sync/atomic"
	"time"
)

// Kind enumerates the failure modes.
type Kind string

const (
	// KindBlackhole drops the SYN: the dial hangs until the caller's deadline.
	// Equivalent to an iptables DROP or a whitelist that simply ignores you.
	KindBlackhole Kind = "blackhole"

	// KindRefuse returns ECONNREFUSED immediately, as a closed port or an
	// iptables REJECT --reject-with tcp-reset would.
	KindRefuse Kind = "refuse"

	// KindHostUnreachable / KindNetUnreachable mimic ICMP unreachables.
	KindHostUnreachable Kind = "host_unreachable"
	KindNetUnreachable  Kind = "net_unreachable"

	// KindDNSFail fails resolution. Partial fidelity: resolution can already have
	// happened before the dialer is reached, depending on domainStrategy.
	KindDNSFail Kind = "dns_fail"

	// KindTLSHang completes the TCP handshake and then never answers, so the peer's
	// TLS handshake times out. This is the classic "port open, service dead" shape,
	// and the one most likely to be mistaken for a working server.
	KindTLSHang Kind = "tls_hang"

	// KindTLSGarbage answers the ClientHello with noise, producing
	// "tls: first record does not look like a TLS handshake".
	KindTLSGarbage Kind = "tls_garbage"

	// KindLatency adds delay to the connect and to every read.
	KindLatency Kind = "latency"

	// KindThrottle rate-limits both directions with a token bucket.
	KindThrottle Kind = "throttle"

	// KindResetAfter tears the connection down mid-stream with ECONNRESET.
	KindResetAfter Kind = "reset_after"

	// KindUDPLoss drops a percentage of datagrams. Meaningful for QUIC/KCP/hysteria.
	KindUDPLoss Kind = "udp_loss"

	// KindQuotaFreeze reproduces the per-connection byte quota Russian TSPU equipment
	// applies to TLS connections leaving the country — the behaviour usually referred
	// to by the sizes involved, "16/20".
	//
	// The handshake completes and small exchanges succeed. Once roughly 16 KB has been
	// written or 20 KB read on one connection, the middlebox stops forwarding and the
	// connection simply stops producing bytes. There is no RST: from the client's side
	// nothing is wrong until its own timeout fires. A new connection starts with a
	// fresh quota, which is why a page loads in fragments and a large download does
	// not finish at all.
	//
	// It has no equivalent among the kinds above and is not a variation on one.
	// Blackhole and refuse stop the dial, so a probe fails and the observatory marks
	// the outbound dead; reset_after produces a visible ECONNRESET. This produces
	// neither. A health check fetching a 204 moves a few hundred bytes, never reaches
	// the quota, and reports the outbound perfectly alive — while every real transfer
	// through it dies. That gap between what the observatory measures and what the
	// user experiences is the exact failure this tool exists to make visible, and
	// until now nothing here could reproduce it.
	KindQuotaFreeze Kind = "quota_freeze"
)

// Defaults for KindQuotaFreeze, in bytes.
//
// Reported thresholds vary by operator — 15 to 20 KB — because the trigger is a packet
// count (around 25 in either direction) rather than a byte count, so the payload figure
// depends on the MSS in use. These are the middle of the reported range and the numbers
// the behaviour is named after.
const (
	DefaultFreezeUpBytes   int64 = 16 << 10
	DefaultFreezeDownBytes int64 = 20 << 10
)

// Known lists every kind the engine implements.
//
// Written out rather than inferred, because the failure it prevents is specific: a rule
// naming a kind this build does not have was accepted and then quietly did nothing. A
// newer interface talking to an older sidecar — the usual shape of a dev run that
// rebuilt the app but not the binary — produced a fault that was armed, listed, and
// completely inert. "Accepted and does nothing" is exactly the class of failure this
// whole tool exists to make visible, so it must not be how the tool itself behaves.
func (k Kind) Known() bool {
	switch k {
	case KindBlackhole, KindRefuse, KindHostUnreachable, KindNetUnreachable, KindDNSFail,
		KindTLSHang, KindTLSGarbage, KindLatency, KindThrottle, KindResetAfter,
		KindUDPLoss, KindQuotaFreeze:
		return true
	}
	return false
}

// HardDown reports whether this kind prevents a connection from being established at
// all. Those kinds also poison already-open connections, because a real firewall does
// not politely wait for existing flows to finish.
func (k Kind) HardDown() bool {
	switch k {
	case KindBlackhole, KindRefuse, KindHostUnreachable, KindNetUnreachable, KindDNSFail:
		return true
	}
	return false
}

// Rule is one fault, scoped by outbound tag and optionally by destination.
type Rule struct {
	ID      string `json:"id"`
	Enabled bool   `json:"enabled"`
	Kind    Kind   `json:"kind"`

	// TagGlob matches outbound tags. "*" and "?" wildcards; empty matches all.
	// Matching on the TAG (not on an address) is the whole point: two outbounds can
	// share a server IP and port, and a packet filter physically cannot separate
	// them. A tag can.
	//
	// COMMA-SEPARATED for a group: "LTE-1, LTE-4, REGULAR-2" fails exactly those
	// three, and "REGULAR-*, LTE-1" mixes a pattern with a literal. A group is one
	// rule rather than several so that enabling and disabling it is a single atomic
	// swap — partially-applied groups would be indistinguishable from a real partial
	// outage, which is precisely the thing under test.
	TagGlob string `json:"tagGlob"`

	// DestRegexp optionally narrows to matching "host:port" destinations.
	DestRegexp string `json:"destRegexp,omitempty"`

	// Network optionally narrows to "tcp" or "udp".
	Network string `json:"network,omitempty"`

	// Origin optionally narrows to "probe" or "traffic". Leave empty for both —
	// faulting only one of them produces behaviour no real network can produce.
	Origin string `json:"origin,omitempty"`

	// DelayMs: connect delay (latency), or time-to-reset (reset_after).
	DelayMs int64 `json:"delayMs,omitempty"`
	// JitterMs: uniform +/- jitter added to DelayMs.
	JitterMs int64 `json:"jitterMs,omitempty"`
	// RateBps: throttle rate in bytes/sec.
	RateBps int64 `json:"rateBps,omitempty"`
	// BurstBytes: throttle bucket size. Defaults to one second of RateBps.
	BurstBytes int64 `json:"burstBytes,omitempty"`
	// AfterBytes: bytes to pass before reset_after fires.
	AfterBytes int64 `json:"afterBytes,omitempty"`
	// LossPercent: 0..100, for udp_loss.
	LossPercent int `json:"lossPercent,omitempty"`

	// UpBytes/DownBytes: the per-connection quota for quota_freeze. Zero takes the
	// default for that direction; a direction cannot be disabled by zeroing it,
	// because a quota that only counts one way is not a thing any middlebox does.
	UpBytes   int64 `json:"upBytes,omitempty"`
	DownBytes int64 `json:"downBytes,omitempty"`

	// FreezeMs caps how long a frozen connection blocks before it reports a timeout.
	// The real thing never unfreezes and the client gives up on its own deadline;
	// this stands in for that deadline so a frozen connection cannot pin a goroutine
	// for the lifetime of the process. Zero takes 16s, matching Xray's dialer.
	FreezeMs int64 `json:"freezeMs,omitempty"`

	// Probability applies the fault to only this fraction of dials (0..1).
	// Zero means "always" — an unset field must not silently disable the rule.
	Probability float64 `json:"probability,omitempty"`

	// UpMs/DownMs make the fault intermittent on a duty cycle, for testing whether a
	// balancer oscillates. Zero disables.
	UpMs   int64 `json:"upMs,omitempty"`
	DownMs int64 `json:"downMs,omitempty"`

	tagRe  *regexp.Regexp
	destRe *regexp.Regexp
}

// RuleSet is an immutable, compiled snapshot of the active rules.
//
// Swapped atomically so the dialer never holds a lock on the hot path and rule edits
// take effect on the next dial with no synchronisation cost.
type RuleSet struct {
	rules []*Rule
}

// Compile validates and precompiles a rule list.
func Compile(rules []*Rule) (*RuleSet, error) {
	out := make([]*Rule, 0, len(rules))
	for _, r := range rules {
		if !r.Enabled {
			continue
		}
		if !r.Kind.Known() {
			return nil, fmt.Errorf(
				"unknown fault kind %q — this sidecar does not implement it. "+
					"If the interface offers it, the two were built from different sources: "+
					"rebuild the sidecar (scripts/build-sidecar.sh) and restart the app",
				r.Kind)
		}
		cp := *r
		re, err := globToRegexp(cp.TagGlob)
		if err != nil {
			return nil, err
		}
		cp.tagRe = re
		if cp.DestRegexp != "" {
			d, err := regexp.Compile(cp.DestRegexp)
			if err != nil {
				return nil, err
			}
			cp.destRe = d
		}
		out = append(out, &cp)
	}
	return &RuleSet{rules: out}, nil
}

// Match returns the first rule matching this dial, or nil.
//
// First match wins, in list order, so the UI must present the list as ordered and
// let the user reorder it.
func (rs *RuleSet) Match(tag, network, dest, origin string, now time.Time) *Rule {
	if rs == nil {
		return nil
	}
	for _, r := range rs.rules {
		if r.tagRe != nil && !r.tagRe.MatchString(tag) {
			continue
		}
		if r.Network != "" && !strings.EqualFold(r.Network, network) {
			continue
		}
		if r.Origin != "" && r.Origin != origin {
			continue
		}
		if r.destRe != nil && !r.destRe.MatchString(dest) {
			continue
		}
		if !r.activeAt(now) {
			continue
		}
		if !r.rollProbability() {
			continue
		}
		return r
	}
	return nil
}

// Rules exposes the compiled set for reporting.
func (rs *RuleSet) Rules() []*Rule {
	if rs == nil {
		return nil
	}
	return rs.rules
}

// activeAt implements the duty cycle. With UpMs/DownMs set, the fault is active only
// during the "down" part of each period.
func (r *Rule) activeAt(now time.Time) bool {
	if r.UpMs <= 0 && r.DownMs <= 0 {
		return true
	}
	period := r.UpMs + r.DownMs
	if period <= 0 {
		return true
	}
	pos := (now.UnixMilli()) % period
	return pos >= r.UpMs
}

func (r *Rule) rollProbability() bool {
	if r.Probability <= 0 || r.Probability >= 1 {
		// 0 means "unset", which must mean always — a rule the user enabled should
		// never be silently inert.
		return true
	}
	return randFloat() < r.Probability
}

// globToRegexp converts a comma-separated list of tag globs into one anchored
// regexp. Empty matches everything; a nil result means "no filter".
func globToRegexp(glob string) (*regexp.Regexp, error) {
	alts := make([]string, 0, 4)
	for _, part := range strings.Split(glob, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		// One catch-all member makes the rest of the list redundant. Collapsing to
		// nil keeps the hot path free of a regexp that can only ever match.
		if part == "*" {
			return nil, nil
		}
		alts = append(alts, globPattern(part))
	}
	if len(alts) == 0 {
		return nil, nil
	}
	// Non-capturing: the group is structural, and a capture would allocate on match.
	return regexp.Compile("^(?:" + strings.Join(alts, "|") + ")$")
}

func globPattern(glob string) string {
	var b strings.Builder
	for _, ch := range glob {
		switch ch {
		case '*':
			b.WriteString(".*")
		case '?':
			b.WriteString(".")
		default:
			b.WriteString(regexp.QuoteMeta(string(ch)))
		}
	}
	return b.String()
}

// Store holds the active rule set behind an atomic pointer.
type Store struct{ ptr atomic.Pointer[RuleSet] }

// Load returns the current set (never nil).
func (s *Store) Load() *RuleSet {
	if rs := s.ptr.Load(); rs != nil {
		return rs
	}
	return &RuleSet{}
}

// Swap installs a new set and returns the previous one.
func (s *Store) Swap(rs *RuleSet) *RuleSet { return s.ptr.Swap(rs) }

// MatchesTag reports whether this rule's tag glob covers tag, ignoring the other
// dimensions. Used when deciding which live connections to poison.
func (r *Rule) MatchesTag(tag string) bool {
	return r.tagRe == nil || r.tagRe.MatchString(tag)
}

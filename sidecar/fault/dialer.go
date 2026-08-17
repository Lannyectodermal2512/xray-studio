package fault

import (
	"context"
	"crypto/rand"
	"net"
	"time"

	xctx "github.com/xtls/xray-core/common/ctx"
	xnet "github.com/xtls/xray-core/common/net"
	"github.com/xtls/xray-core/common/session"
	"github.com/xtls/xray-core/transport/internet"
	"github.com/xtls/xray-core/xraytrace"
)

// blackholeMax matches the hardcoded net.Dialer{Timeout: 16s} in Xray's
// DefaultSystemDialer. A blackhole must expire on the same schedule as a real one,
// or the fault would be distinguishable from the thing it imitates purely by how
// long it takes to fail.
const blackholeMax = 16 * time.Second

// DialReport describes one dial for telemetry.
type DialReport struct {
	Tag       string
	Protocol  string
	Dest      string
	Network   string
	Origin    string // probe | traffic
	FaultID   string
	FaultKind string
	Err       error
	SetupNs   int64
	ConnID    uint32
}

// Dialer is an internet.SystemDialer that injects faults per outbound tag.
type Dialer struct {
	inner  internet.SystemDialer
	store  *Store
	reg    *Registry
	report func(DialReport)
}

// NewDialer builds the fault dialer. inner may be nil, defaulting to Xray's own.
//
// Delegating to DefaultSystemDialer on the unfaulted path (rather than dialing
// ourselves) is deliberate: it keeps sendThrough, sockopt marks, TCP keepalive tuning
// and TFO working exactly as configured. A hand-rolled dialer would quietly drop all
// of that and change behaviour even when no fault is active.
func NewDialer(inner internet.SystemDialer, store *Store, reg *Registry, report func(DialReport)) *Dialer {
	if inner == nil {
		inner = &internet.DefaultSystemDialer{}
	}
	return &Dialer{inner: inner, store: store, reg: reg, report: report}
}

// Install replaces Xray's effective system dialer.
//
// Safe before or after core.New: core.New only reassigns the package-level dnsClient
// and outbound manager in transport/internet, never effectiveSystemDialer.
func (d *Dialer) Install() { internet.UseAlternativeSystemDialer(d) }

// Uninstall restores the default dialer.
func Uninstall() { internet.UseAlternativeSystemDialer(nil) }

// DestIpAddress implements internet.SystemDialer.
func (d *Dialer) DestIpAddress() net.IP { return d.inner.DestIpAddress() }

// Dial implements internet.SystemDialer.
func (d *Dialer) Dial(ctx context.Context, src xnet.Address, dest xnet.Destination, sockopt *internet.SocketConfig) (net.Conn, error) {
	start := time.Now()

	// The outbound tag lives on the LAST element of the outbound stack: dialerProxy
	// and proxySettings.tag push additional hops, and the last one is whoever
	// actually opens the socket. This is the same lookup DialSystem performs.
	var tag, proto string
	if obs := session.OutboundsFromContext(ctx); len(obs) > 0 {
		if ob := obs[len(obs)-1]; ob != nil {
			tag, proto = ob.Tag, ob.Name
		}
	}

	origin := "traffic"
	if _, ok := xraytrace.ProbeTagFrom(ctx); ok {
		origin = "probe"
	}

	network := dest.Network.SystemString()
	destStr := dest.NetAddr()
	addr := destAddr(dest)

	rule := d.store.Load().Match(tag, network, destStr, origin, time.Now())

	rep := DialReport{
		Tag: tag, Protocol: proto, Dest: destStr, Network: network,
		Origin: origin, ConnID: connIDFrom(ctx),
	}
	if rule != nil {
		rep.FaultID, rep.FaultKind = rule.ID, string(rule.Kind)
	}

	finish := func(c net.Conn, err error) (net.Conn, error) {
		rep.Err = err
		rep.SetupNs = time.Since(start).Nanoseconds()
		if d.report != nil {
			d.report(rep)
		}
		return c, err
	}

	if rule == nil {
		c, err := d.inner.Dial(ctx, src, dest, sockopt)
		if err != nil {
			return finish(nil, err)
		}
		return finish(d.track(c, nil, tag), nil)
	}

	// Connect-phase faults: no socket is ever opened, exactly as when a filter drops
	// or rejects the SYN.
	switch rule.Kind {
	case KindBlackhole:
		// Report the outcome NOW, then hold.
		//
		// The decision is already made, and reporting on completion would delay the
		// event by up to 16s. Worse, the caller often gives up long before we do:
		// the observatory's DialContext dials with the observer's long-lived context
		// rather than the per-request one, so a probe abandons the attempt at its 5s
		// HTTP timeout while this call keeps blocking. Telemetry must describe what
		// happened when it happened, not when the goroutine finally unwinds.
		err := errTimeout(network, addr)
		_, _ = finish(nil, err)
		d.holdBlackhole(ctx, rule)
		return nil, err
	case KindRefuse:
		d.pause(ctx, rule, 2)
		return finish(nil, errRefused(network, addr))
	case KindHostUnreachable:
		d.pause(ctx, rule, 40)
		return finish(nil, errHostUnreachable(network, addr))
	case KindNetUnreachable:
		d.pause(ctx, rule, 40)
		return finish(nil, errNetUnreachable(network, addr))
	case KindDNSFail:
		return finish(nil, errDNS(destHost(dest)))
	}

	// Latency applies to the connect too, not just to reads.
	if rule.Kind == KindLatency {
		if d := jitterMs(rule.DelayMs, rule.JitterMs); d > 0 {
			if err := sleepCtx(ctx, time.Duration(d)*time.Millisecond); err != nil {
				return finish(nil, err)
			}
		}
	}

	// Handshake-phase faults need a real TCP connection first: the point is that the
	// port is open and the service behind it is broken, which is a different
	// diagnosis from an unreachable host and must look different on the wire.
	if rule.Kind == KindTLSHang || rule.Kind == KindTLSGarbage {
		c, err := d.inner.Dial(ctx, src, dest, sockopt)
		if err != nil {
			return finish(nil, err)
		}
		return finish(d.track(newHandshakeBreaker(c, rule.Kind), rule, tag), nil)
	}

	c, err := d.inner.Dial(ctx, src, dest, sockopt)
	if err != nil {
		return finish(nil, err)
	}
	return finish(d.track(c, rule, tag), nil)
}

func (d *Dialer) track(c net.Conn, rule *Rule, tag string) net.Conn {
	wrapped := wrap(c, rule, d.reg, tag)
	// trackedOf, not a type switch: wrap can hand back an *internet.PacketConnWrapper
	// with the instrumentation nested inside. Missing it here leaves the connection
	// unregistered, and Poison then silently skips it — the fault would apply to new
	// dials only, which is the exact failure this registry exists to prevent.
	if tc := trackedOf(wrapped); tc != nil {
		d.reg.track(tc)
	}
	return wrapped
}

// holdBlackhole consumes the time a dropped SYN would have consumed, so the failure
// is indistinguishable from a real one in timing as well as in error shape.
//
// The cap matches net.Dialer{Timeout: 16s} in Xray's DefaultSystemDialer. A rule may
// shorten it via DelayMs, which is worth doing in the UI: a caller that ignores its
// own deadline (the observatory does — see above) will otherwise keep a goroutine
// parked here for the full 16 seconds on every probe.
func (d *Dialer) holdBlackhole(ctx context.Context, r *Rule) {
	hold := blackholeMax
	if r.DelayMs > 0 {
		hold = time.Duration(r.DelayMs) * time.Millisecond
	}
	t := time.NewTimer(hold)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

// pause applies the rule's delay, or a small default, so a synthesized refusal does
// not come back implausibly faster than a real one.
func (d *Dialer) pause(ctx context.Context, r *Rule, defaultMs int64) {
	ms := r.DelayMs
	if ms <= 0 {
		ms = defaultMs
	}
	_ = sleepCtx(ctx, time.Duration(jitterMs(ms, r.JitterMs))*time.Millisecond)
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// handshakeBreaker sits on an established TCP connection and sabotages the TLS
// handshake above it.
type handshakeBreaker struct {
	net.Conn
	kind    Kind
	replied bool
}

func newHandshakeBreaker(c net.Conn, kind Kind) net.Conn {
	return &handshakeBreaker{Conn: c, kind: kind}
}

func (h *handshakeBreaker) Write(b []byte) (int, error) {
	// Swallow the ClientHello: pretend it went out, so the peer waits for a reply
	// that either never comes or is nonsense.
	return len(b), nil
}

func (h *handshakeBreaker) Read(b []byte) (int, error) {
	switch h.kind {
	case KindTLSGarbage:
		if h.replied {
			return 0, errConnReset("read", h.Conn.LocalAddr().Network(), h.Conn.RemoteAddr())
		}
		h.replied = true
		n := len(b)
		if n > 64 {
			n = 64
		}
		if _, err := rand.Read(b[:n]); err != nil {
			return 0, err
		}
		// crypto/tls rejects this as "first record does not look like a TLS
		// handshake" the moment it inspects the record header.
		return n, nil
	default: // KindTLSHang
		// Delegate to the real socket. Because Write swallowed the ClientHello the
		// server has nothing to reply to, so this blocks until the peer's own
		// TLSHandshakeTimeout deadline fires and returns a genuine i/o timeout.
		// Honouring the deadline this way is why we must NOT park on a channel here:
		// that would ignore SetReadDeadline and leak the goroutine.
		return h.Conn.Read(b)
	}
}

// connIDFrom extracts Xray's per-connection id, when present. Zero if absent.
func connIDFrom(ctx context.Context) uint32 { return uint32(xctx.IDFromContext(ctx)) }

package fault

import (
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/xtls/xray-core/transport/internet"
)

// wrap applies a rule's in-band effects to an established connection.
//
// CRITICAL: it must preserve the dialed connection's CONCRETE TYPE, not merely the
// net.PacketConn interface.
//
// For UDP without a bind address, Xray's DefaultSystemDialer returns a
// *internet.PacketConnWrapper, and eight call sites across hysteria, kcp, splithttp,
// udp, freedom and wireguard type-SWITCH on that exact struct rather than asserting
// the interface. hysteria's switch ends in `default: panic(reflect.TypeOf(c))`, so a
// wrapper that merely satisfies net.PacketConn takes the whole process down the first
// time a hysteria outbound dials — which is exactly what it did. Others fall through
// their default branch and silently lose the packet path instead.
//
// So: rebuild the same struct around the instrumented PacketConn. Consumers that reach
// inside for .PacketConn get the tracked one and stay instrumented; consumers that only
// match the type see what they expect. TestWrapPreservesPacketConnWrapper pins it.
func wrap(c net.Conn, r *Rule, reg *Registry, tag string) net.Conn {
	if r == nil && reg == nil {
		return c
	}
	base := &trackedConn{Conn: c, rule: r, tag: tag, reg: reg, opened: time.Now()}
	if r != nil {
		base.bucket = newBucket(r.RateBps, r.BurstBytes)
		if r.Kind == KindResetAfter {
			base.resetAfter = r.AfterBytes
			if r.DelayMs > 0 {
				base.resetAt = time.Now().Add(time.Duration(r.DelayMs) * time.Millisecond)
			}
		}
	}
	if pcw, ok := c.(*internet.PacketConnWrapper); ok {
		tracked := &trackedPacketConn{trackedConn: base, pc: pcw.PacketConn}
		return &internet.PacketConnWrapper{PacketConn: tracked, Dest: pcw.Dest}
	}
	if pc, ok := c.(net.PacketConn); ok {
		return &trackedPacketConn{trackedConn: base, pc: pc}
	}
	return base
}

// trackedOf digs the trackedConn out of whatever wrap returned.
//
// Needed because preserving *internet.PacketConnWrapper means the outermost value is
// no longer one of our types. Keeping the unwrapping here, next to wrap, is what stops
// the two from drifting apart.
func trackedOf(c net.Conn) *trackedConn {
	switch v := c.(type) {
	case *trackedConn:
		return v
	case *trackedPacketConn:
		return v.trackedConn
	case *internet.PacketConnWrapper:
		if tp, ok := v.PacketConn.(*trackedPacketConn); ok {
			return tp.trackedConn
		}
	}
	return nil
}

// trackedConn counts bytes, applies in-band faults, and can be poisoned in place.
type trackedConn struct {
	net.Conn
	rule   *Rule
	tag    string
	reg    *Registry
	opened time.Time

	read    atomic.Int64
	written atomic.Int64

	bucket     *bucket
	resetAfter int64
	resetAt    time.Time

	// poison, once set, makes every subsequent Read/Write fail with that error.
	poison    atomic.Pointer[error]
	closeOnce sync.Once
}

func (c *trackedConn) effects(n int, isRead bool) error {
	if perr := c.poison.Load(); perr != nil {
		return *perr
	}
	if c.rule == nil {
		return nil
	}
	switch c.rule.Kind {
	case KindLatency:
		if d := jitterMs(c.rule.DelayMs, c.rule.JitterMs); d > 0 && isRead {
			time.Sleep(time.Duration(d) * time.Millisecond)
		}
	case KindThrottle:
		if c.bucket != nil && n > 0 {
			c.bucket.take(int64(n))
		}
	case KindResetAfter:
		total := c.read.Load() + c.written.Load()
		hitBytes := c.resetAfter > 0 && total >= c.resetAfter
		hitTime := !c.resetAt.IsZero() && time.Now().After(c.resetAt)
		if hitBytes || hitTime {
			op := "write"
			if isRead {
				op = "read"
			}
			return errConnReset(op, c.LocalAddr().Network(), c.RemoteAddr())
		}
	}
	return nil
}

func (c *trackedConn) Read(b []byte) (int, error) {
	if err := c.effects(0, true); err != nil {
		return 0, err
	}
	n, err := c.Conn.Read(b)
	if n > 0 {
		c.read.Add(int64(n))
		if e := c.effects(n, true); e != nil {
			return n, e
		}
	}
	return n, err
}

func (c *trackedConn) Write(b []byte) (int, error) {
	if err := c.effects(0, false); err != nil {
		return 0, err
	}
	if c.bucket != nil {
		c.bucket.take(int64(len(b)))
	}
	n, err := c.Conn.Write(b)
	if n > 0 {
		c.written.Add(int64(n))
		if e := c.effects(n, false); e != nil {
			return n, e
		}
	}
	return n, err
}

func (c *trackedConn) Close() error {
	var err error
	c.closeOnce.Do(func() {
		if c.reg != nil {
			c.reg.forget(c)
		}
		err = c.Conn.Close()
	})
	return err
}

// trackedPacketConn preserves net.PacketConn and applies datagram loss.
type trackedPacketConn struct {
	*trackedConn
	pc net.PacketConn
}

func (c *trackedPacketConn) dropping() bool {
	return c.rule != nil && c.rule.Kind == KindUDPLoss &&
		c.rule.LossPercent > 0 && randFloat()*100 < float64(c.rule.LossPercent)
}

func (c *trackedPacketConn) ReadFrom(p []byte) (int, net.Addr, error) {
	for {
		if perr := c.poison.Load(); perr != nil {
			return 0, nil, *perr
		}
		n, addr, err := c.pc.ReadFrom(p)
		if err != nil {
			return n, addr, err
		}
		if c.dropping() {
			// A lost datagram is not an error to the caller — it simply never
			// arrives — so swallow it and wait for the next one.
			continue
		}
		c.read.Add(int64(n))
		return n, addr, nil
	}
}

func (c *trackedPacketConn) WriteTo(p []byte, addr net.Addr) (int, error) {
	if perr := c.poison.Load(); perr != nil {
		return 0, *perr
	}
	if c.dropping() {
		// Report success: the sender of a dropped datagram gets no feedback either.
		return len(p), nil
	}
	if c.bucket != nil {
		c.bucket.take(int64(len(p)))
	}
	n, err := c.pc.WriteTo(p, addr)
	if n > 0 {
		c.written.Add(int64(n))
	}
	return n, err
}

func (c *trackedPacketConn) SetReadDeadline(t time.Time) error  { return c.pc.SetReadDeadline(t) }
func (c *trackedPacketConn) SetWriteDeadline(t time.Time) error { return c.pc.SetWriteDeadline(t) }
func (c *trackedPacketConn) SetDeadline(t time.Time) error      { return c.pc.SetDeadline(t) }

// Registry tracks live connections per outbound tag so they can be torn down when
// that tag goes hard-down.
//
// Without this, "the host is unreachable" would only apply to NEW connections while
// established ones kept working — which is not how a firewall behaves, and would let
// a long-lived flow mask the very outage being tested.
type Registry struct {
	mu      sync.Mutex
	byTag   map[string]map[*trackedConn]struct{}
	onClose func(tag string, read, written int64, age time.Duration, err error)
}

// NewRegistry creates a registry. onClose may be nil.
func NewRegistry(onClose func(tag string, read, written int64, age time.Duration, err error)) *Registry {
	return &Registry{byTag: make(map[string]map[*trackedConn]struct{}), onClose: onClose}
}

func (r *Registry) track(c *trackedConn) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	m := r.byTag[c.tag]
	if m == nil {
		m = make(map[*trackedConn]struct{})
		r.byTag[c.tag] = m
	}
	m[c] = struct{}{}
}

func (r *Registry) forget(c *trackedConn) {
	if r == nil {
		return
	}
	r.mu.Lock()
	if m := r.byTag[c.tag]; m != nil {
		delete(m, c)
		if len(m) == 0 {
			delete(r.byTag, c.tag)
		}
	}
	cb := r.onClose
	r.mu.Unlock()
	if cb != nil {
		cb(c.tag, c.read.Load(), c.written.Load(), time.Since(c.opened), nil)
	}
}

// Poison fails every live connection for tag with err, and reports how many.
//
// Order matters: the error is armed BEFORE the socket is closed. Closing first would
// make subsequent reads return "use of closed network connection", which is a local
// bug shape, not a network failure shape — and any code inspecting the error would
// draw the wrong conclusion.
func (r *Registry) Poison(tag string, err error) int {
	if r == nil {
		return 0
	}
	r.mu.Lock()
	conns := make([]*trackedConn, 0, len(r.byTag[tag]))
	for c := range r.byTag[tag] {
		conns = append(conns, c)
	}
	r.mu.Unlock()

	for _, c := range conns {
		e := err
		c.poison.Store(&e)
		_ = c.Conn.SetDeadline(time.Now()) // unblock anything parked in Read/Write
		go func(c *trackedConn) {
			// Give the parked reader a moment to observe the poison before the fd
			// disappears underneath it.
			time.Sleep(50 * time.Millisecond)
			_ = c.Close()
		}(c)
	}
	return len(conns)
}

// Count returns the number of tracked connections for a tag.
func (r *Registry) Count(tag string) int {
	if r == nil {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.byTag[tag])
}

// bucket is a simple token bucket for throttling.
type bucket struct {
	mu       sync.Mutex
	rate     float64 // bytes/sec
	capacity float64
	tokens   float64
	last     time.Time
}

func newBucket(rateBps, burst int64) *bucket {
	if rateBps <= 0 {
		return nil
	}
	if burst <= 0 {
		burst = rateBps // one second of traffic
	}
	return &bucket{rate: float64(rateBps), capacity: float64(burst), tokens: float64(burst), last: time.Now()}
}

// take blocks until n bytes' worth of tokens are available.
func (b *bucket) take(n int64) {
	if b == nil || n <= 0 {
		return
	}
	b.mu.Lock()
	now := time.Now()
	b.tokens += b.rate * now.Sub(b.last).Seconds()
	if b.tokens > b.capacity {
		b.tokens = b.capacity
	}
	b.last = now
	need := float64(n)
	var wait time.Duration
	if b.tokens < need {
		wait = time.Duration((need - b.tokens) / b.rate * float64(time.Second))
	}
	b.tokens -= need
	b.mu.Unlock()

	if wait > 0 {
		time.Sleep(wait)
	}
}

// Tags lists outbound tags with at least one tracked connection.
func (r *Registry) Tags() []string {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, 0, len(r.byTag))
	for tag := range r.byTag {
		out = append(out, tag)
	}
	return out
}

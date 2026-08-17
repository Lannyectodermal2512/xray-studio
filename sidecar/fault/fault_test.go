package fault

import (
	"errors"
	"net"
	"os"
	"syscall"
	"testing"
	"time"

	xnet "github.com/xtls/xray-core/common/net"
	"github.com/xtls/xray-core/transport/internet"
)

// TestSynthesizedErrorsMatchKernel is the fidelity test that matters.
//
// The whole premise is "behaves as if the host were genuinely unreachable". If our
// synthesized errors differed from real kernel errors — in text, in Timeout(), or in
// what errors.Is unwraps to — then the observatory's LastErrorReason, Xray's logs and
// our UI would all describe something that cannot happen on a real network.
//
// No server and no network required: 127.0.0.1:1 gives a real ECONNREFUSED from the
// kernel, which is the only ground truth worth comparing against.
func TestSynthesizedErrorsMatchKernel(t *testing.T) {
	realConn, realErr := net.DialTimeout("tcp", "127.0.0.1:1", 2*time.Second)
	if realErr == nil {
		_ = realConn.Close()
		t.Skip("something is listening on 127.0.0.1:1")
	}

	addr := &net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 1}
	synth := errRefused("tcp", addr)

	if got, want := synth.Error(), realErr.Error(); got != want {
		t.Errorf("text differs:\n  synthesized: %s\n  kernel:      %s", got, want)
	}
	if !errors.Is(synth, syscall.ECONNREFUSED) {
		t.Error("synthesized refusal does not unwrap to ECONNREFUSED")
	}
	if !errors.Is(realErr, syscall.ECONNREFUSED) {
		t.Fatalf("kernel error is not ECONNREFUSED: %v", realErr)
	}

	var synthOp, realOp *net.OpError
	if !errors.As(synth, &synthOp) || !errors.As(realErr, &realOp) {
		t.Fatal("both should be *net.OpError")
	}
	if synthOp.Timeout() != realOp.Timeout() {
		t.Errorf("Timeout() differs: synthesized=%v kernel=%v", synthOp.Timeout(), realOp.Timeout())
	}
	if synthOp.Temporary() != realOp.Temporary() { //nolint:staticcheck // parity check
		t.Errorf("Temporary() differs: synthesized=%v kernel=%v", synthOp.Temporary(), realOp.Temporary()) //nolint:staticcheck
	}
}

// TestBlackholeLooksLikeATimeout pins the other half: a dropped SYN must present as a
// timeout, because that is what callers branch on.
func TestBlackholeLooksLikeATimeout(t *testing.T) {
	err := errTimeout("tcp", &net.TCPAddr{IP: net.ParseIP("192.0.2.1"), Port: 80})

	var op *net.OpError
	if !errors.As(err, &op) {
		t.Fatal("want *net.OpError")
	}
	if !op.Timeout() {
		t.Error("a blackhole must report Timeout() == true")
	}
	if !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Error("want errors.Is(err, os.ErrDeadlineExceeded)")
	}
	if got := err.Error(); got != "dial tcp 192.0.2.1:80: i/o timeout" {
		t.Errorf("unexpected text: %q", got)
	}
}

// fakePacketConn is a net.Conn that is also a net.PacketConn, like the
// *internet.PacketConnWrapper the default dialer returns for UDP.
type fakePacketConn struct{ net.Conn }

func (f fakePacketConn) ReadFrom(p []byte) (int, net.Addr, error)  { return 0, nil, nil }
func (f fakePacketConn) WriteTo(p []byte, a net.Addr) (int, error) { return len(p), nil }

type nopConn struct{ net.Conn }

func (nopConn) Read([]byte) (int, error)         { return 0, nil }
func (nopConn) Write(b []byte) (int, error)      { return len(b), nil }
func (nopConn) Close() error                     { return nil }
func (nopConn) LocalAddr() net.Addr              { return &net.TCPAddr{} }
func (nopConn) RemoteAddr() net.Addr             { return &net.TCPAddr{} }
func (nopConn) SetDeadline(time.Time) error      { return nil }
func (nopConn) SetReadDeadline(time.Time) error  { return nil }
func (nopConn) SetWriteDeadline(time.Time) error { return nil }

// TestWrapPreservesPacketConn guards the trap that would silently break every
// QUIC-based transport.
//
// Xray's UDP path returns a conn that is ALSO a net.PacketConn, and QUIC / XHTTP /
// hysteria type-assert it back. A wrapper that only satisfies net.Conn makes those
// transports fail at handshake time, far from here and very hard to trace back.
func TestWrapPreservesPacketConn(t *testing.T) {
	reg := NewRegistry(nil)
	rule := &Rule{ID: "r", Enabled: true, Kind: KindLatency, DelayMs: 1}

	t.Run("packet conn stays a packet conn", func(t *testing.T) {
		wrapped := wrap(fakePacketConn{nopConn{}}, rule, reg, "tag")
		if _, ok := wrapped.(net.PacketConn); !ok {
			t.Fatal("wrap() dropped net.PacketConn — QUIC/XHTTP/hysteria would break")
		}
		if _, ok := wrapped.(net.Conn); !ok {
			t.Fatal("wrap() must still be a net.Conn")
		}
	})

	t.Run("stream conn is not promoted", func(t *testing.T) {
		wrapped := wrap(nopConn{}, rule, reg, "tag")
		if _, ok := wrapped.(net.PacketConn); ok {
			t.Fatal("a stream conn must not become a net.PacketConn")
		}
	})
}

// TestWrapPreservesPacketConnWrapper pins the CONCRETE type, which the interface
// check above does not.
//
// Satisfying net.PacketConn is not enough: hysteria, kcp, splithttp, udp, freedom and
// wireguard type-SWITCH on *internet.PacketConnWrapper itself. hysteria's switch ends
// in `default: panic(reflect.TypeOf(c))`, so returning any other type killed the whole
// process on the first hysteria dial. TestWrapPreservesPacketConn passed throughout —
// it asserted the interface, encoding the same wrong assumption as the code.
func TestWrapPreservesPacketConnWrapper(t *testing.T) {
	reg := NewRegistry(nil)
	rule := &Rule{ID: "r", Enabled: true, Kind: KindLatency, DelayMs: 1}
	dest := &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 443}

	wrapped := wrap(&internet.PacketConnWrapper{PacketConn: fakePacketConn{nopConn{}}, Dest: dest}, rule, reg, "tag")

	pcw, ok := wrapped.(*internet.PacketConnWrapper)
	if !ok {
		t.Fatalf("wrap() returned %T; hysteria's type switch panics on anything else", wrapped)
	}
	if pcw.Dest != dest {
		t.Fatalf("Dest = %v, want %v — hysteria reads RemoteAddr() off it", pcw.Dest, dest)
	}
	// The instrumentation has to survive the round trip, or faults stop applying to
	// every UDP transport while looking perfectly healthy.
	tp, ok := pcw.PacketConn.(*trackedPacketConn)
	if !ok {
		t.Fatalf("inner PacketConn is %T, want *trackedPacketConn — faults would not apply", pcw.PacketConn)
	}
	if tp.rule != rule {
		t.Fatal("inner conn lost its rule")
	}
	// The registry poisons by *trackedConn, so track() must still be able to find it.
	if trackedOf(wrapped) != tp.trackedConn {
		t.Fatal("trackedOf() cannot reach the tracked conn — it would never be registered or poisoned")
	}
}

// TestPoisonArmsErrorBeforeClosing covers the "already-established connections"
// gap. A firewall does not wait politely for existing flows to finish, so open
// connections must fail too — and with a NETWORK error, not with "use of closed
// network connection", which would be a different (and misleading) diagnosis.
func TestPoisonArmsErrorBeforeClosing(t *testing.T) {
	reg := NewRegistry(nil)
	wrapped := wrap(nopConn{}, nil, reg, "proxy-a")
	tc, ok := wrapped.(*trackedConn)
	if !ok {
		t.Fatal("expected a *trackedConn")
	}
	reg.track(tc)

	if n := reg.Count("proxy-a"); n != 1 {
		t.Fatalf("registry tracked %d conns, want 1", n)
	}

	want := errRefused("tcp", &net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 443})
	if n := reg.Poison("proxy-a", want); n != 1 {
		t.Fatalf("poisoned %d conns, want 1", n)
	}

	if _, err := tc.Read(make([]byte, 1)); !errors.Is(err, syscall.ECONNREFUSED) {
		t.Errorf("read after poison = %v, want ECONNREFUSED", err)
	}
	if _, err := tc.Write([]byte("x")); !errors.Is(err, syscall.ECONNREFUSED) {
		t.Errorf("write after poison = %v, want ECONNREFUSED", err)
	}
}

func TestRuleMatching(t *testing.T) {
	rs, err := Compile([]*Rule{
		{ID: "disabled", Enabled: false, Kind: KindRefuse, TagGlob: "*"},
		{ID: "probes-only", Enabled: true, Kind: KindBlackhole, TagGlob: "proxy-*", Origin: "probe"},
		{ID: "all-de", Enabled: true, Kind: KindRefuse, TagGlob: "proxy-de"},
	})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	now := time.Now()

	cases := []struct {
		name, tag, origin, want string
	}{
		{"probe on proxy-jp hits the probe rule", "proxy-jp", "probe", "probes-only"},
		{"traffic on proxy-jp matches nothing", "proxy-jp", "traffic", ""},
		{"traffic on proxy-de falls through to all-de", "proxy-de", "traffic", "all-de"},
		{"probe on proxy-de hits the EARLIER rule", "proxy-de", "probe", "probes-only"},
		{"non-matching tag", "direct", "traffic", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ""
			if r := rs.Match(tc.tag, "tcp", "example.com:443", tc.origin, now); r != nil {
				got = r.ID
			}
			if got != tc.want {
				t.Errorf("matched %q, want %q", got, tc.want)
			}
		})
	}

	t.Run("disabled rules are dropped at compile time", func(t *testing.T) {
		for _, r := range rs.Rules() {
			if r.ID == "disabled" {
				t.Fatal("a disabled rule survived Compile")
			}
		}
	})
}

// TestTagGroups covers a fault aimed at several outbounds at once. A group is one
// rule, so it arms and disarms atomically — the alternative, several rules swapped
// one at a time, would briefly produce a partial outage that looks exactly like the
// real thing being tested.
func TestTagGroups(t *testing.T) {
	cases := []struct {
		name, glob string
		hit, miss  []string
	}{
		{
			name: "explicit list of unrelated tags",
			glob: "LTE-1, LTE-4, REGULAR-2",
			hit:  []string{"LTE-1", "LTE-4", "REGULAR-2"},
			miss: []string{"LTE-14", "LTE-2", "REGULAR-1", "LTE", ""},
		},
		{
			name: "patterns mixed with literals",
			glob: "REGULAR-*,LTE-1",
			hit:  []string{"REGULAR-1", "REGULAR-99", "LTE-1"},
			miss: []string{"LTE-2", "xREGULAR-1"},
		},
		{
			name: "whitespace and empty members are ignored",
			glob: "  LTE-1 ,, LTE-2  ,",
			hit:  []string{"LTE-1", "LTE-2"},
			miss: []string{"LTE-3"},
		},
		{
			// A tag can contain regexp metacharacters; they must stay literal.
			name: "metacharacters are quoted",
			glob: "a.b, c+d",
			hit:  []string{"a.b", "c+d"},
			miss: []string{"axb", "cd", "ccd"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rs, err := Compile([]*Rule{{ID: "g", Enabled: true, Kind: KindRefuse, TagGlob: tc.glob}})
			if err != nil {
				t.Fatalf("compile %q: %v", tc.glob, err)
			}
			for _, tag := range tc.hit {
				if rs.Match(tag, "tcp", "example.com:443", "probe", time.Now()) == nil {
					t.Errorf("%q should match %q", tc.glob, tag)
				}
			}
			for _, tag := range tc.miss {
				if rs.Match(tag, "tcp", "example.com:443", "probe", time.Now()) != nil {
					t.Errorf("%q should NOT match %q", tc.glob, tag)
				}
			}
		})
	}

	t.Run("a catch-all member collapses the whole list", func(t *testing.T) {
		rs, err := Compile([]*Rule{{ID: "g", Enabled: true, Kind: KindRefuse, TagGlob: "LTE-1, *"}})
		if err != nil {
			t.Fatalf("compile: %v", err)
		}
		if r := rs.Rules()[0]; r.tagRe != nil {
			t.Errorf("expected no tag filter, got %v", r.tagRe)
		}
		if rs.Match("anything", "tcp", "example.com:443", "probe", time.Now()) == nil {
			t.Error("catch-all must match an unrelated tag")
		}
	})
}

// TestDutyCycle checks the intermittent mode, which is how you test whether a
// balancer oscillates under a flapping outbound.
func TestDutyCycle(t *testing.T) {
	r := &Rule{UpMs: 100, DownMs: 100}
	base := time.UnixMilli(0)

	if r.activeAt(base.Add(50 * time.Millisecond)) {
		t.Error("must be inactive during the up phase")
	}
	if !r.activeAt(base.Add(150 * time.Millisecond)) {
		t.Error("must be active during the down phase")
	}
	if r.activeAt(base.Add(250 * time.Millisecond)) {
		t.Error("cycle must repeat: 250ms is in the next up phase")
	}
}

// TestUnsetProbabilityMeansAlways guards against a rule the user enabled being
// silently inert because they left an optional field at zero.
func TestUnsetProbabilityMeansAlways(t *testing.T) {
	r := &Rule{}
	for i := 0; i < 100; i++ {
		if !r.rollProbability() {
			t.Fatal("Probability == 0 must mean 'always', not 'never'")
		}
	}
}

// TestDialerReadsTagFromLastOutbound documents where the tag comes from, and that a
// dial with no outbound context is handled rather than panicking.
func TestDialerReadsTagFromLastOutbound(t *testing.T) {
	store := &Store{}
	rs, _ := Compile([]*Rule{{ID: "x", Enabled: true, Kind: KindRefuse, TagGlob: "*"}})
	store.Swap(rs)

	var got DialReport
	d := NewDialer(&internet.DefaultSystemDialer{}, store, NewRegistry(nil), func(r DialReport) { got = r })

	dest := xnet.TCPDestination(xnet.DomainAddress("example.invalid"), 443)
	// No session.Outbound in the context at all: tag is empty, and a glob of "*"
	// still matches, so the fault applies and nothing panics.
	_, err := d.Dial(t.Context(), nil, dest, nil)
	if !errors.Is(err, syscall.ECONNREFUSED) {
		t.Fatalf("dial error = %v, want ECONNREFUSED", err)
	}
	if got.Dest != "example.invalid:443" {
		t.Errorf("reported dest = %q", got.Dest)
	}
	if got.Origin != "traffic" {
		t.Errorf("reported origin = %q, want traffic", got.Origin)
	}
	if got.FaultKind != string(KindRefuse) {
		t.Errorf("reported fault kind = %q", got.FaultKind)
	}
}

// TestDestAddrHandlesDomains guards the panic that xnet.Address.IP() raises on a
// domain address. Destinations arrive unresolved whenever domainStrategy is AsIs,
// which is the default, so this is the common case rather than an edge case.
func TestDestAddrHandlesDomains(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("destAddr panicked on a domain destination: %v", r)
		}
	}()

	got := destAddr(xnet.TCPDestination(xnet.DomainAddress("example.com"), 443))
	if got.String() != "example.com:443" {
		t.Errorf("addr = %q", got.String())
	}

	ipAddr := destAddr(xnet.TCPDestination(xnet.ParseAddress("1.2.3.4"), 80))
	if _, ok := ipAddr.(*net.TCPAddr); !ok {
		t.Errorf("IP destination should yield *net.TCPAddr, got %T", ipAddr)
	}
	udpAddr := destAddr(xnet.UDPDestination(xnet.ParseAddress("1.2.3.4"), 80))
	if _, ok := udpAddr.(*net.UDPAddr); !ok {
		t.Errorf("UDP destination should yield *net.UDPAddr, got %T", udpAddr)
	}
}

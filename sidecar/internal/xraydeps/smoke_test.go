package xraydeps_test

// Load-bearing smoke test for the whole architecture.
//
// It proves, against the real pinned core, the four things every later milestone
// assumes and that would be expensive to discover were false in M1.3:
//
//  1. xray-core can be driven as a *library* — no fork needed to run an instance.
//  2. internet.UseAlternativeSystemDialer actually intercepts real dials.
//  3. The outbound tag is readable at dial time from the LAST element of
//     session.OutboundsFromContext(ctx) — this is what makes per-outbound fault
//     injection possible at all.
//  4. A synthesized dial error propagates back out as a real connection failure,
//     which is what "as if the host were genuinely unreachable" reduces to.
//
// It binds a loopback port and speaks SOCKS5 to itself. No external network.

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"os"
	"sync"
	"syscall"
	"testing"
	"time"

	xnet "github.com/xtls/xray-core/common/net"
	"github.com/xtls/xray-core/common/session"
	"github.com/xtls/xray-core/core"
	"github.com/xtls/xray-core/infra/conf/serial"
	"github.com/xtls/xray-core/transport/internet"

	_ "xraystudio/sidecar/internal/xraydeps"
)

// recordingDialer stands in for the real fault dialer: it records the outbound tag
// of every dial and refuses those matching refuseTag.
type recordingDialer struct {
	inner     internet.SystemDialer
	refuseTag string

	mu   sync.Mutex
	seen []string
}

func (d *recordingDialer) DestIpAddress() net.IP { return d.inner.DestIpAddress() }

func (d *recordingDialer) Dial(ctx context.Context, src xnet.Address, dest xnet.Destination, sockopt *internet.SocketConfig) (net.Conn, error) {
	// The same lookup transport/internet.DialSystem itself performs.
	var tag string
	if obs := session.OutboundsFromContext(ctx); len(obs) > 0 {
		tag = obs[len(obs)-1].Tag
	}

	d.mu.Lock()
	d.seen = append(d.seen, tag)
	d.mu.Unlock()

	if tag != "" && tag == d.refuseTag {
		// Shaped exactly like a kernel refusal, because that is what the balancer,
		// the observatory and the proxy code all pattern-match against.
		return nil, &net.OpError{
			Op:   "dial",
			Net:  dest.Network.SystemString(),
			Addr: destAddr(dest),
			Err:  os.NewSyscallError("connect", syscall.ECONNREFUSED),
		}
	}
	return d.inner.Dial(ctx, src, dest, sockopt)
}

// domainAddr carries an unresolved host:port, for the very common case where the
// destination is a domain and no IP exists yet.
type domainAddr struct{ network, addr string }

func (a domainAddr) Network() string { return a.network }
func (a domainAddr) String() string  { return a.addr }

// destAddr converts an Xray destination into a net.Addr without ever assuming it is
// an IP. xnet.Address.IP() PANICS on a domain address, and destinations reach the
// dialer unresolved whenever domainStrategy is AsIs — i.e. by default.
func destAddr(dest xnet.Destination) net.Addr {
	if dest.Address.Family().IsDomain() {
		return domainAddr{network: dest.Network.SystemString(), addr: dest.NetAddr()}
	}
	ip := dest.Address.IP()
	if dest.Network == xnet.Network_UDP {
		return &net.UDPAddr{IP: ip, Port: int(dest.Port)}
	}
	return &net.TCPAddr{IP: ip, Port: int(dest.Port)}
}

func (d *recordingDialer) tags() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.seen...)
}

// freePort asks the kernel for an unused loopback TCP port.
func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	p := l.Addr().(*net.TCPAddr).Port
	_ = l.Close()
	return p
}

func TestLibraryEmbedAndDialerInterception(t *testing.T) {
	socksPort := freePort(t)

	// Minimal but realistic: a SOCKS entry point and a tagged freedom outbound.
	// The tag is the whole point — it is what the fault rules key on.
	cfgJSON := `{
	  "log": { "loglevel": "error" },
	  "inbounds": [
	    { "tag": "socks-in", "listen": "127.0.0.1", "port": ` + itoa(socksPort) + `,
	      "protocol": "socks", "settings": { "auth": "noauth", "udp": false } }
	  ],
	  "outbounds": [
	    { "tag": "direct", "protocol": "freedom" }
	  ]
	}`

	cfg, err := serial.LoadJSONConfig(bytes.NewReader([]byte(cfgJSON)))
	if err != nil {
		t.Fatalf("LoadJSONConfig: %v", err)
	}

	dialer := &recordingDialer{inner: &internet.DefaultSystemDialer{}, refuseTag: "direct"}

	// Order does not matter relative to core.New: core.New touches dnsClient/obm in
	// transport/internet, but never effectiveSystemDialer.
	internet.UseAlternativeSystemDialer(dialer)
	t.Cleanup(func() { internet.UseAlternativeSystemDialer(nil) })

	inst, err := core.New(cfg)
	if err != nil {
		t.Fatalf("core.New: %v", err)
	}
	if err := inst.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = inst.Close() })

	// The SOCKS listener comes up asynchronously.
	waitListening(t, "127.0.0.1:"+itoa(socksPort))

	// Ask the proxy for a host we never actually contact — the fault dialer refuses
	// the outbound hop before any packet leaves.
	//
	// Note that SOCKS5 CONNECT itself succeeds: Xray replies 0x00 as soon as it has
	// routed the request, before the outbound dials. The refusal therefore surfaces
	// in the data phase as a torn-down connection, which is exactly how a real
	// unreachable host behaves through a SOCKS proxy.
	if err := socks5Connect(t, "127.0.0.1:"+itoa(socksPort), "example.invalid", 80, true); err != nil {
		t.Fatalf("data phase should fail, but the CONNECT handshake itself broke: %v", err)
	}

	tags := dialer.tags()
	if len(tags) == 0 {
		t.Fatal("fault dialer was never consulted — UseAlternativeSystemDialer did not take effect")
	}
	found := false
	for _, tag := range tags {
		if tag == "direct" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("outbound tag not visible at dial time; saw %q, want one to be %q", tags, "direct")
	}
}

// TestSynthesizedRefusalMatchesKernel pins our error shape to the real thing. If these
// ever diverge, code that inspects errors (and the UI that reports them) starts lying.
func TestSynthesizedRefusalMatchesKernel(t *testing.T) {
	// 127.0.0.1:1 is reliably closed and gives a genuine kernel ECONNREFUSED.
	real, err := net.DialTimeout("tcp", "127.0.0.1:1", 2*time.Second)
	if err == nil {
		_ = real.Close()
		t.Skip("something is listening on 127.0.0.1:1")
	}

	synthetic := &net.OpError{
		Op:   "dial",
		Net:  "tcp",
		Addr: &net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 1},
		Err:  os.NewSyscallError("connect", syscall.ECONNREFUSED),
	}

	if !errors.Is(err, syscall.ECONNREFUSED) {
		t.Fatalf("kernel error is not ECONNREFUSED: %v", err)
	}
	if !errors.Is(synthetic, syscall.ECONNREFUSED) {
		t.Fatalf("synthesized error is not ECONNREFUSED: %v", synthetic)
	}
	if got, want := synthetic.Error(), err.Error(); got != want {
		t.Fatalf("error text differs\n synthesized: %s\n kernel:      %s", got, want)
	}
	var realOp *net.OpError
	if errors.As(err, &realOp) && realOp.Timeout() != synthetic.Timeout() {
		t.Fatalf("Timeout() differs: synthesized=%v kernel=%v", synthetic.Timeout(), realOp.Timeout())
	}
}

func waitListening(t *testing.T, addr string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		c, err := net.DialTimeout("tcp", addr, 200*time.Millisecond)
		if err == nil {
			_ = c.Close()
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("nothing listening on %s after 5s", addr)
}

// socks5Connect performs a no-auth SOCKS5 CONNECT. When wantDataPhaseFailure is set
// it additionally drives the data phase and requires it to fail, which is how an
// unreachable upstream manifests through SOCKS5 (the CONNECT reply comes first).
func socks5Connect(t *testing.T, proxy, host string, port uint16, wantDataPhaseFailure bool) error {
	t.Helper()
	c, err := net.DialTimeout("tcp", proxy, 3*time.Second)
	if err != nil {
		return err
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))

	// greeting: ver=5, 1 method, 0x00 = no auth
	if _, err := c.Write([]byte{0x05, 0x01, 0x00}); err != nil {
		return err
	}
	resp := make([]byte, 2)
	if _, err := io.ReadFull(c, resp); err != nil {
		return err
	}
	if resp[0] != 0x05 || resp[1] != 0x00 {
		return errors.New("socks5: no-auth rejected")
	}

	// request: ver=5, cmd=connect, rsv, atyp=domain
	req := []byte{0x05, 0x01, 0x00, 0x03, byte(len(host))}
	req = append(req, host...)
	req = append(req, byte(port>>8), byte(port))
	if _, err := c.Write(req); err != nil {
		return err
	}

	head := make([]byte, 4)
	if _, err := io.ReadFull(c, head); err != nil {
		// Xray closes the connection outright when the outbound dial fails, so a
		// truncated reply is itself the failure signal we are asserting on.
		return err
	}
	if head[1] != 0x00 {
		// Also a legitimate way for the refusal to surface; nothing more to check.
		t.Logf("socks5: CONNECT refused outright, reply code %d", head[1])
		return nil
	}
	if !wantDataPhaseFailure {
		return nil
	}

	// Drain the rest of the bind address so the stream is positioned correctly:
	// atyp is head[3]; 0x01 = IPv4(4), 0x03 = len-prefixed domain, 0x04 = IPv6(16).
	var addrLen int
	switch head[3] {
	case 0x01:
		addrLen = 4
	case 0x04:
		addrLen = 16
	case 0x03:
		l := make([]byte, 1)
		if _, err := io.ReadFull(c, l); err != nil {
			return err
		}
		addrLen = int(l[0])
	default:
		return errors.New("socks5: unknown atyp in reply")
	}
	if _, err := io.ReadFull(c, make([]byte, addrLen+2)); err != nil { // +2 = port
		return err
	}

	// The outbound dial was refused, so this must not round-trip.
	if _, err := c.Write([]byte("GET / HTTP/1.0\r\n\r\n")); err != nil {
		t.Logf("data phase failed on write (expected): %v", err)
		return nil
	}
	if n, err := c.Read(make([]byte, 1)); err == nil && n > 0 {
		return errors.New("data phase unexpectedly returned bytes — the fault did not propagate")
	} else {
		t.Logf("data phase failed on read (expected): %v", err)
	}
	return nil
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b [20]byte
	p := len(b)
	for i > 0 {
		p--
		b[p] = byte('0' + i%10)
		i /= 10
	}
	return string(b[p:])
}

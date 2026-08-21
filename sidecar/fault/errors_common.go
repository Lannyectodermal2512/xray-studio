package fault

import (
	"crypto/rand"
	"encoding/binary"
	"math"
	"net"
	"os"

	xnet "github.com/xtls/xray-core/common/net"
)

// RefusedError builds this platform's "connection refused", identical to the kernel's.
//
// Exported because a test dialer elsewhere was assembling the same *net.OpError by
// hand, with the Unix errno and the Unix syscall name hardcoded — two copies of one
// fact, and the copy was wrong on Windows in both respects (the name there is
// "connectex", not "connect").
func RefusedError(network string, addr net.Addr) error {
	return errRefused(network, addr)
}

// errTimeout is the blackhole error: a dial that ran out of time.
//
// os.ErrDeadlineExceeded is what net.Dialer itself returns on timeout, so
// err.Error() reads "i/o timeout" and errors.Is(err, os.ErrDeadlineExceeded) and
// Timeout() both behave as callers expect.
func errTimeout(network string, addr net.Addr) error {
	return &net.OpError{Op: "dial", Net: network, Addr: addr, Err: os.ErrDeadlineExceeded}
}

// errIOTimeout is the same deadline error on a read or a write rather than a dial.
//
// The Op matters: a caller that logs the error prints "read tcp …: i/o timeout", and a
// stall reported as a failed dial would point at the wrong end of the connection.
func errIOTimeout(op, network string, addr net.Addr) error {
	return &net.OpError{Op: op, Net: network, Addr: addr, Err: os.ErrDeadlineExceeded}
}

// errDNS is the resolution failure.
func errDNS(host string) error {
	return &net.DNSError{
		Err:        "no such host",
		Name:       host,
		IsNotFound: true,
	}
}

// domainAddr carries an unresolved host:port.
//
// This type exists because xnet.Address.IP() PANICS on a domain address, and
// destinations arrive at the dialer unresolved whenever domainStrategy is AsIs —
// which is the default. Constructing a *net.TCPAddr unconditionally is a crash
// waiting for the first user who proxies a hostname.
type domainAddr struct{ network, addr string }

func (a domainAddr) Network() string { return a.network }
func (a domainAddr) String() string  { return a.addr }

// destAddr converts an Xray destination to a net.Addr, safe for domains.
func destAddr(dest xnet.Destination) net.Addr {
	network := dest.Network.SystemString()
	if dest.Address == nil || dest.Address.Family().IsDomain() {
		return domainAddr{network: network, addr: dest.NetAddr()}
	}
	ip := dest.Address.IP()
	if dest.Network == xnet.Network_UDP {
		return &net.UDPAddr{IP: ip, Port: int(dest.Port)}
	}
	return &net.TCPAddr{IP: ip, Port: int(dest.Port)}
}

// destHost returns just the host portion, for DNS errors.
func destHost(dest xnet.Destination) string {
	if dest.Address == nil {
		return ""
	}
	return dest.Address.String()
}

// randFloat returns a uniform float in [0,1) from crypto/rand.
//
// crypto/rand rather than math/rand so that fault sampling cannot be perturbed by,
// or perturb, the global math/rand sequence that dice.Roll uses for balancer
// selection. Keeping the two independent means an injected fault never biases the
// very choice we are trying to observe.
func randFloat() float64 {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return 0
	}
	return float64(binary.BigEndian.Uint64(b[:])>>11) / float64(1<<53)
}

// jitter returns base +/- jitter, clamped at zero.
func jitterMs(base, jit int64) int64 {
	if jit <= 0 {
		return base
	}
	delta := int64(math.Round((randFloat()*2 - 1) * float64(jit)))
	v := base + delta
	if v < 0 {
		return 0
	}
	return v
}

// PoisonError builds the error used to tear down live connections when their
// outbound enters a hard-down fault, matching what a new dial would have returned.
func PoisonError(kind Kind, tag string) error {
	addr := domainAddr{network: "tcp", addr: tag}
	switch kind {
	case KindRefuse:
		return errRefused("tcp", addr)
	case KindHostUnreachable:
		return errHostUnreachable("tcp", addr)
	case KindNetUnreachable:
		return errNetUnreachable("tcp", addr)
	case KindDNSFail:
		return errDNS(tag)
	default: // blackhole and anything else: a stalled flow ends as a timeout
		return errTimeout("tcp", addr)
	}
}

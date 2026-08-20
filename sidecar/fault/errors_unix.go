//go:build darwin || linux || freebsd || netbsd || openbsd

package fault

import (
	"net"
	"os"
	"syscall"
)

// The synthesized errors below are asserted, in errors_test.go, to be byte-identical
// to what the kernel produces for the same condition. That matters because these
// strings surface in the observatory's LastErrorReason, in Xray's logs, and in our
// UI — if they differed, every one of those would be subtly lying about what
// happened.
//
// Build-tagged from the start so a Windows port is a new file (WSAECONNREFUSED and
// friends), not a refactor of this one.

// RefusedErrno is the errno this platform reports for a refused connection.
//
// Exported for the tests, which have to ask "is this the refusal this OS produces?"
// rather than naming a constant. Naming one is how the suite came to assert
// syscall.ECONNREFUSED everywhere and then fail on Windows against production code
// that was right: Winsock answers WSAECONNREFUSED, and the tests were the Unix half
// of the port that nobody finished.
var RefusedErrno error = syscall.ECONNREFUSED

func errRefused(network string, addr net.Addr) error {
	return &net.OpError{
		Op:   "dial",
		Net:  network,
		Addr: addr,
		Err:  os.NewSyscallError("connect", syscall.ECONNREFUSED),
	}
}

func errHostUnreachable(network string, addr net.Addr) error {
	return &net.OpError{
		Op:   "dial",
		Net:  network,
		Addr: addr,
		Err:  os.NewSyscallError("connect", syscall.EHOSTUNREACH),
	}
}

func errNetUnreachable(network string, addr net.Addr) error {
	return &net.OpError{
		Op:   "dial",
		Net:  network,
		Addr: addr,
		Err:  os.NewSyscallError("connect", syscall.ENETUNREACH),
	}
}

func errConnReset(op, network string, addr net.Addr) error {
	return &net.OpError{
		Op:   op,
		Net:  network,
		Addr: addr,
		Err:  os.NewSyscallError(op, syscall.ECONNRESET),
	}
}

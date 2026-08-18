//go:build windows

package fault

import (
	"net"
	"os"
	"syscall"

	"golang.org/x/sys/windows"
)

// The Windows counterpart of errors_unix.go.
//
// Same contract: a synthesized failure must be indistinguishable from the one the
// kernel produces, because these strings surface in the observatory's
// LastErrorReason, in Xray's logs and in the UI. A fault that reported a Unix errno
// on Windows would be a tell, and the whole point of injecting at the dialer is that
// nothing downstream can tell the difference.
//
// Two things differ from Unix and both matter for that fidelity:
//
//   - The errno values are the WSA* set, and they come from golang.org/x/sys/windows
//     rather than syscall: Go's own syscall package exports only four of them
//     (WSAEACCES, WSAECONNABORTED, WSAECONNRESET, WSAENOPROTOOPT), and the three this
//     needs are not among them. They are the same syscall.Errno values either way —
//     WSAECONNREFUSED is 10061 — so the formatted text is what Winsock really returns
//     ("No connection could be made because the target machine actively refused it.").
//   - The syscall NAMES are different. Go's net package dials through ConnectEx and
//     reads/writes through WSARecv/WSASend, so a real Windows failure reads
//     "connectex: ..." or "wsarecv: ...", never "connect: ..." or "read: ...".
func errRefused(network string, addr net.Addr) error {
	return &net.OpError{
		Op:   "dial",
		Net:  network,
		Addr: addr,
		Err:  os.NewSyscallError("connectex", windows.WSAECONNREFUSED),
	}
}

func errHostUnreachable(network string, addr net.Addr) error {
	return &net.OpError{
		Op:   "dial",
		Net:  network,
		Addr: addr,
		Err:  os.NewSyscallError("connectex", windows.WSAEHOSTUNREACH),
	}
}

func errNetUnreachable(network string, addr net.Addr) error {
	return &net.OpError{
		Op:   "dial",
		Net:  network,
		Addr: addr,
		Err:  os.NewSyscallError("connectex", windows.WSAENETUNREACH),
	}
}

func errConnReset(op, network string, addr net.Addr) error {
	return &net.OpError{
		Op:   op,
		Net:  network,
		Addr: addr,
		Err:  os.NewSyscallError(winSyscallName(op), syscall.WSAECONNRESET),
	}
}

// winSyscallName maps the direction to the Winsock call Go would have been in.
func winSyscallName(op string) string {
	switch op {
	case "read":
		return "wsarecv"
	case "write":
		return "wsasend"
	default:
		return op
	}
}

package fault

import (
	"errors"
	"io"
	"net"
	"os"
	"testing"
	"time"
)

// pair returns a tracked connection over a real socket, plus the far end.
func pair(t *testing.T, r *Rule) (tracked net.Conn, peer net.Conn) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })

	accepted := make(chan net.Conn, 1)
	go func() {
		c, err := ln.Accept()
		if err == nil {
			accepted <- c
		}
	}()

	client, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	server := <-accepted
	t.Cleanup(func() { _ = client.Close(); _ = server.Close() })

	return wrap(client, r, nil, "test"), server
}

func quotaRule(up, down int64) *Rule {
	// A short cap: the test asserts that a frozen read ends in a timeout, and the real
	// sixteen seconds would only make it a slow test of the same thing.
	return &Rule{Kind: KindQuotaFreeze, UpBytes: up, DownBytes: down, FreezeMs: 150}
}

// The shape of the thing: a connection works, then stops, and nothing says so. This is
// what makes the behaviour hard to diagnose on a real network and worth reproducing —
// there is no error at the moment the middlebox intervenes, only silence.
func TestQuotaFreezeStopsWithoutAnError(t *testing.T) {
	c, peer := pair(t, quotaRule(64, 1<<20))

	if _, err := c.Write(make([]byte, 32)); err != nil {
		t.Fatalf("under quota should be ordinary traffic, got %v", err)
	}
	got := make([]byte, 32)
	if _, err := io.ReadFull(peer, got); err != nil {
		t.Fatalf("the first write should have arrived: %v", err)
	}

	// Crossing the budget does not fail the write that crosses it, exactly as the
	// middlebox does not reject the packet that trips it.
	if _, err := c.Write(make([]byte, 64)); err != nil {
		t.Fatalf("the crossing write should still succeed, got %v", err)
	}

	start := time.Now()
	_, err := c.Write([]byte("x"))
	if err == nil {
		t.Fatal("a write past the quota should not have gone through")
	}
	if !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Errorf("the caller should see a timeout, not %v", err)
	}
	var opErr *net.OpError
	if errors.As(err, &opErr) {
		if !opErr.Timeout() {
			t.Error("Timeout() should report true, as it does for a real stall")
		}
		if opErr.Op != "write" {
			t.Errorf("Op = %q, want write — a stall is not a failed dial", opErr.Op)
		}
	} else {
		t.Error("the error should be a *net.OpError, like every other network error")
	}
	if waited := time.Since(start); waited < 100*time.Millisecond {
		t.Errorf("the caller waited %v; a freeze makes it wait out its deadline", waited)
	}
}

// The download budget is separate from the upload one, and either exhausted is enough.
func TestQuotaFreezeCountsEachDirection(t *testing.T) {
	c, peer := pair(t, quotaRule(1<<20, 64))

	if _, err := peer.Write(make([]byte, 96)); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadFull(c, make([]byte, 96)); err != nil {
		t.Fatalf("bytes already in flight still arrive: %v", err)
	}

	if _, err := peer.Write([]byte("more")); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Read(make([]byte, 4)); !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Errorf("reading past the download quota should stall, got %v", err)
	}
}

// The reason this kind had to exist.
//
// An observatory probe fetches a 204 and moves a few hundred bytes, so it never reaches
// the quota and reports the outbound alive — while a real transfer through the same
// outbound dies. No other fault produces that split: blackhole and refuse fail the dial,
// so the probe fails too, and reset_after delivers a visible ECONNRESET.
func TestQuotaFreezeLeavesSmallExchangesAlone(t *testing.T) {
	r := quotaRule(DefaultFreezeUpBytes, DefaultFreezeDownBytes)

	probe, probePeer := pair(t, r)
	if _, err := probe.Write([]byte("GET /generate_204 HTTP/1.1\r\nHost: x\r\n\r\n")); err != nil {
		t.Fatalf("a probe-sized request must be untouched: %v", err)
	}
	if _, err := probePeer.Write([]byte("HTTP/1.1 204 No Content\r\n\r\n")); err != nil {
		t.Fatal(err)
	}
	if _, err := probe.Read(make([]byte, 128)); err != nil {
		t.Fatalf("a probe-sized response must be untouched: %v", err)
	}

	// The same rule, a real transfer, a separate connection: dead.
	traffic, _ := pair(t, r)
	sent := 0
	var err error
	for sent < int(DefaultFreezeUpBytes)+4096 {
		var n int
		n, err = traffic.Write(make([]byte, 1024))
		sent += n
		if err != nil {
			break
		}
	}
	if err == nil {
		t.Fatal("a transfer past the quota should have stalled")
	}
	if !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Errorf("stall should surface as a timeout, got %v", err)
	}
	if int64(sent) < DefaultFreezeUpBytes {
		t.Errorf("stalled after %d bytes, before the %d-byte quota", sent, DefaultFreezeUpBytes)
	}
}

// A fresh connection starts with a fresh budget — which is why a page loads in
// fragments rather than not at all, and why "it works, just badly" is the usual report.
func TestQuotaFreezeIsPerConnection(t *testing.T) {
	r := quotaRule(64, 1<<20)

	first, _ := pair(t, r)
	if _, err := first.Write(make([]byte, 96)); err != nil {
		t.Fatal(err)
	}
	if _, err := first.Write([]byte("x")); err == nil {
		t.Fatal("the first connection should be spent")
	}

	second, secondPeer := pair(t, r)
	if _, err := second.Write(make([]byte, 32)); err != nil {
		t.Errorf("a new connection starts with a full quota, got %v", err)
	}
	if _, err := io.ReadFull(secondPeer, make([]byte, 32)); err != nil {
		t.Errorf("and its bytes actually arrive: %v", err)
	}
}

// Closing a frozen connection releases the caller immediately, rather than leaving a
// goroutine parked until the cap expires.
func TestQuotaFreezeReleasesOnClose(t *testing.T) {
	c, _ := pair(t, &Rule{Kind: KindQuotaFreeze, UpBytes: 16, DownBytes: 16, FreezeMs: 30_000})
	if _, err := c.Write(make([]byte, 32)); err != nil {
		t.Fatal(err)
	}

	done := make(chan time.Duration, 1)
	go func() {
		start := time.Now()
		_, _ = c.Write([]byte("x"))
		done <- time.Since(start)
	}()

	time.Sleep(50 * time.Millisecond)
	_ = c.Close()

	select {
	case waited := <-done:
		if waited > 5*time.Second {
			t.Errorf("close should have released the freeze; waited %v", waited)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a frozen connection stayed parked after Close")
	}
}

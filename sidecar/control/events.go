package control

import (
	"fmt"
	"net/http"
	"time"
)

// handleEvents streams the event bus as Server-Sent Events.
//
// SSE rather than WebSocket: the stream is one-way (commands go over REST), it needs
// no dependency, it survives proxies, and it can be inspected with
// `curl -N -H 'Authorization: Bearer …' …/v1/events` — which matters a lot when the
// question is "is the sidecar emitting anything at all?".
//
// Backpressure is handled by dropping, on both hops: Bus.Emit drops when the central
// queue is full, and the per-subscriber channel drops when one client is slow. A
// stalled UI must never be able to slow down the Xray data path that feeds it.
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	ch, cancel := s.bus.Subscribe(4096)
	defer cancel()

	// Replay current state immediately so a client that connects mid-session is not
	// staring at an empty screen until the next event happens to fire.
	st := s.mgr.State()
	s.bus.Stamp(&st.Envelope, "state")
	writeSSE(w, mustJSON(st))
	flusher.Flush()

	keepalive := time.NewTicker(15 * time.Second)
	defer keepalive.Stop()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case <-keepalive.C:
			// A comment frame keeps intermediaries and idle-socket timeouts at bay.
			if _, err := fmt.Fprint(w, ": keepalive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case buf, open := <-ch:
			if !open {
				return
			}
			if !writeSSE(w, buf) {
				return
			}
			flusher.Flush()
		}
	}
}

// writeSSE emits one frame. Every payload is single-line JSON, so no multi-line
// escaping is needed.
func writeSSE(w http.ResponseWriter, payload []byte) bool {
	if _, err := w.Write([]byte("data: ")); err != nil {
		return false
	}
	if _, err := w.Write(payload); err != nil {
		return false
	}
	_, err := w.Write([]byte("\n\n"))
	return err == nil
}

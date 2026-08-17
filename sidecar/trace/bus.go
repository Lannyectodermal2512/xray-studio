package trace

import (
	"encoding/json"
	"sync"
	"sync/atomic"
	"time"
)

// Bus fans structured events out to subscribers.
//
// THE INVARIANT: Emit never blocks. Several producers sit on Xray's hot paths —
// OnBalancerEval fires synchronously for every dispatched connection, and a burst
// round can fire len(tags)*samplingCount probes at once. A bus that applied
// backpressure there would add latency to the very thing it is measuring.
//
// So the queue is bounded and overflow is DROPPED and COUNTED. The drop counter is
// published in BusStats and shown in the UI: an observability tool that silently
// loses events is worse than one that admits it.
type Bus struct {
	queue chan []byte

	seq     atomic.Uint64
	emitted atomic.Uint64
	dropped atomic.Uint64
	epoch   atomic.Uint32

	start time.Time

	mu   sync.RWMutex
	subs map[int]chan []byte
	next int

	closeOnce sync.Once
	done      chan struct{}
}

// DefaultQueueSize is sized for a worst-case burst round (20 outbounds x 10 samples
// produces 400 probe events) plus headroom for concurrent dispatch traffic.
const DefaultQueueSize = 8192

// NewBus creates a bus and starts its fan-out goroutine.
func NewBus(size int) *Bus {
	if size <= 0 {
		size = DefaultQueueSize
	}
	b := &Bus{
		queue: make(chan []byte, size),
		start: time.Now(),
		subs:  make(map[int]chan []byte),
		done:  make(chan struct{}),
	}
	go b.fanout()
	return b
}

// Stamp fills in the envelope. Exported so producers can build a typed event, stamp
// it, and emit it without the bus needing to know every concrete type.
func (b *Bus) Stamp(e *Envelope, typ string) {
	e.Seq = b.seq.Add(1)
	e.Type = typ
	e.MonoNs = time.Since(b.start).Nanoseconds()
	e.WallMs = time.Now().UnixMilli()
	e.Epoch = b.epoch.Load()
}

// Emit serialises and queues an event. Never blocks; drops on a full queue.
//
// The event must embed Envelope and must already have been passed to Stamp.
func (b *Bus) Emit(ev any) {
	buf, err := json.Marshal(ev)
	if err != nil {
		b.dropped.Add(1)
		return
	}
	select {
	case b.queue <- buf:
		b.emitted.Add(1)
	default:
		b.dropped.Add(1)
	}
}

// Publish stamps and emits in one step.
func (b *Bus) Publish(typ string, e *Envelope, ev any) {
	b.Stamp(e, typ)
	b.Emit(ev)
}

// NextEpoch bumps the epoch, marking a new instance lifetime. Returns the new value.
func (b *Bus) NextEpoch() uint32 { return b.epoch.Add(1) }

// Epoch returns the current epoch.
func (b *Bus) Epoch() uint32 { return b.epoch.Load() }

// Since returns monotonic nanoseconds since the bus started.
func (b *Bus) Since() int64 { return time.Since(b.start).Nanoseconds() }

// Subscribe returns a channel of raw JSON frames and a cancel func.
//
// Per-subscriber queues are bounded too: one stalled WebSocket must not be able to
// stall the fan-out for everyone else, so a slow subscriber loses frames rather than
// applying backpressure upstream.
func (b *Bus) Subscribe(buffer int) (<-chan []byte, func()) {
	if buffer <= 0 {
		buffer = 1024
	}
	ch := make(chan []byte, buffer)

	b.mu.Lock()
	id := b.next
	b.next++
	b.subs[id] = ch
	b.mu.Unlock()

	var once sync.Once
	cancel := func() {
		once.Do(func() {
			b.mu.Lock()
			delete(b.subs, id)
			b.mu.Unlock()
			close(ch)
		})
	}
	return ch, cancel
}

func (b *Bus) fanout() {
	for {
		select {
		case <-b.done:
			return
		case buf := <-b.queue:
			b.mu.RLock()
			for _, ch := range b.subs {
				select {
				case ch <- buf:
				default:
					// Slow subscriber: drop for them alone. Counted globally so the
					// UI still sees that something was lost.
					b.dropped.Add(1)
				}
			}
			b.mu.RUnlock()
		}
	}
}

// Stats snapshots the pipeline's health.
func (b *Bus) Stats() BusStats {
	b.mu.RLock()
	n := len(b.subs)
	b.mu.RUnlock()
	return BusStats{
		Emitted:     b.emitted.Load(),
		Dropped:     b.dropped.Load(),
		QueueDepth:  len(b.queue),
		QueueCap:    cap(b.queue),
		Subscribers: n,
	}
}

// StartStatsTicker publishes BusStats periodically until the bus closes.
func (b *Bus) StartStatsTicker(every time.Duration) {
	if every <= 0 {
		every = 500 * time.Millisecond
	}
	go func() {
		t := time.NewTicker(every)
		defer t.Stop()
		for {
			select {
			case <-b.done:
				return
			case <-t.C:
				s := b.Stats()
				b.Publish(TypeBusStats, &s.Envelope, &s)
			}
		}
	}()
}

// Close stops the fan-out and closes every subscriber channel.
func (b *Bus) Close() {
	b.closeOnce.Do(func() {
		close(b.done)
		b.mu.Lock()
		for id, ch := range b.subs {
			delete(b.subs, id)
			close(ch)
		}
		b.mu.Unlock()
	})
}

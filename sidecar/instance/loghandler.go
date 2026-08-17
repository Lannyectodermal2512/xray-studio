package instance

import (
	"strings"

	xerrors "github.com/xtls/xray-core/common/errors"
	xlog "github.com/xtls/xray-core/common/log"

	"xraystudio/sidecar/trace"
)

// tee forwards every log record to the core's own handler and to our event bus.
//
// Teeing rather than replacing matters. app/log registers itself as the global
// handler from inside core.New, and it is what implements the user's configured
// `log.access` / `log.error` destinations. Simply calling RegisterHandler with our
// own handler would silently disable the file logging the config asked for — and
// "the config under test runs verbatim" is the premise of the whole tool.
type tee struct {
	primary xlog.Handler // app/log's Instance; may be nil
	bus     *trace.Bus
}

func (t *tee) Handle(msg xlog.Message) {
	if t.primary != nil {
		t.primary.Handle(msg)
	}
	if t.bus == nil {
		return
	}

	ev := trace.Log{Message: msg.String()}
	severity := "unknown"

	// A GeneralMessage carrying an *errors.Error is the rich case: the patched core
	// exposes the per-connection id, the logging package and the severity, so the UI
	// can filter by any of them and pivot to a single connection — none of which is
	// recoverable from the formatted string.
	if gm, ok := msg.(*xlog.GeneralMessage); ok {
		severity = severityName(gm.Severity)
		if xe, ok := gm.Content.(*xerrors.Error); ok {
			ev.Caller = xe.Caller()
			ev.ConnID = xe.ConnID()
			ev.Message = strings.TrimSpace(xe.Error())
		}
	}
	ev.Severity = severity
	t.bus.Publish(trace.TypeLog, &ev.Envelope, &ev)
}

func severityName(s xlog.Severity) string {
	switch s {
	case xlog.Severity_Debug:
		return "debug"
	case xlog.Severity_Info:
		return "info"
	case xlog.Severity_Warning:
		return "warning"
	case xlog.Severity_Error:
		return "error"
	case xlog.Severity_Unknown:
		return "unknown"
	default:
		return "unknown"
	}
}

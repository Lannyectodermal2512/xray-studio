// Package validate finds configs that load without complaint and then do not work.
//
// Xray's own parser rejects malformed configs, which is the easy half. The hard half
// is everything it accepts: a balancer selector that matches no outbound, leastLoad
// with no observatory, a fallbackTag pointing at nothing. Those produce a process that
// starts cleanly, logs nothing useful, and quietly routes traffic somewhere else.
package validate

import (
	"encoding/json"
	"reflect"
	"strings"

	"github.com/xtls/xray-core/infra/conf"

	"xraystudio/sidecar/trace"
)

// UnknownKeys reports JSON keys that no config struct will ever read.
//
// This is the single highest-value check in the whole validator, because Go's
// encoding/json silently ignores unknown fields. Writing "balancer" instead of
// "balancers", or "probeUrl" instead of "probeURL" under the wrong parent, produces
// a config that parses, starts, and behaves as though the entire block were absent.
// There is no error, no warning, and nothing in the logs.
//
// The known-key set is derived by reflecting over the infra/conf structs rather than
// being written out by hand, so it cannot drift from the parser as Xray evolves.
func UnknownKeys(raw []byte) []trace.Diagnostic {
	var tree any
	if err := json.Unmarshal(raw, &tree); err != nil {
		// Malformed JSON is reported by the parse phase with a position; nothing to add.
		return nil
	}
	var out []trace.Diagnostic
	walk(tree, reflect.TypeOf(conf.Config{}), "", &out)
	return out
}

// opaque reports types whose contents the config system treats as a black box, so
// descending into them would produce false positives.
//
// Protocol settings are the important case: `inbounds[].settings` is a
// *json.RawMessage decoded later by a protocol-specific loader chosen at runtime, so
// its keys are simply not knowable from the top-level type graph.
func opaque(t reflect.Type) bool {
	switch t {
	case reflect.TypeOf(json.RawMessage{}), reflect.TypeOf(&json.RawMessage{}):
		return true
	}
	// Types with custom unmarshalling accept shapes their fields do not describe
	// (StringList takes a string or an array, PortList a number or a range, ...).
	if t.Kind() != reflect.Struct {
		return true
	}
	if reflect.PointerTo(t).Implements(reflect.TypeOf((*json.Unmarshaler)(nil)).Elem()) {
		return true
	}
	return false
}

func deref(t reflect.Type) reflect.Type {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	return t
}

func walk(node any, t reflect.Type, path string, out *[]trace.Diagnostic) {
	if node == nil || t == nil {
		return
	}
	t = deref(t)

	switch v := node.(type) {
	case map[string]any:
		if t.Kind() == reflect.Map {
			// Map keys are user-chosen (policy levels, for instance), so only the
			// values are checkable.
			for k, child := range v {
				walk(child, t.Elem(), join(path, k), out)
			}
			return
		}
		if t.Kind() != reflect.Struct || opaque(t) {
			return
		}
		fields := jsonFields(t)
		for k, child := range v {
			// Matching is case-insensitive because encoding/json is: a config using
			// "ProbeURL" or "probeurl" really does work, and flagging it would be
			// wrong. Only genuinely unreadable keys are reported.
			f, ok := fields[strings.ToLower(k)]
			if !ok {
				*out = append(*out, trace.Diagnostic{
					Severity: "dysfunction",
					Code:     "unknown_key",
					Path:     join(path, k),
					Key:      "unknown_key",
					Vars:     map[string]string{"key": k, "suggestion": suggest(k, fields)},
					Message:  "\"" + k + "\" is not read by anything.",
					Detail: "Go's JSON decoder ignores unknown fields silently, so this " +
						"block behaves exactly as if it were absent — no error, no log line. " +
						suggest(k, fields),
				})
				continue
			}
			walk(child, f.Type, join(path, k), out)
		}

	case []any:
		if t.Kind() != reflect.Slice && t.Kind() != reflect.Array {
			return
		}
		for i, child := range v {
			walk(child, t.Elem(), path+"["+itoa(i)+"]", out)
		}
	}
}

// jsonFields maps lower-cased JSON names to their fields, mirroring how
// encoding/json resolves them.
func jsonFields(t reflect.Type) map[string]reflect.StructField {
	out := make(map[string]reflect.StructField, t.NumField())
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		if f.PkgPath != "" {
			continue // unexported
		}
		name := f.Name
		if tag := f.Tag.Get("json"); tag != "" {
			if tag == "-" {
				continue
			}
			if n, _, _ := strings.Cut(tag, ","); n != "" {
				name = n
			}
		}
		if f.Anonymous && f.Tag.Get("json") == "" {
			// Embedded structs contribute their fields directly.
			for k, v := range jsonFields(deref(f.Type)) {
				out[k] = v
			}
			continue
		}
		out[strings.ToLower(name)] = f
	}
	return out
}

// suggest offers the closest known key, which turns a bare "unknown" into an
// actionable message for the common case of a typo or a singular/plural slip.
func suggest(key string, fields map[string]reflect.StructField) string {
	best, bestDist := "", 1<<30
	lk := strings.ToLower(key)
	for name := range fields {
		d := editDistance(lk, name)
		if d < bestDist {
			best, bestDist = name, d
		}
	}
	// Only suggest when it is close enough to be plausible.
	if best == "" || bestDist > 3 || bestDist >= len(lk) {
		return ""
	}
	return "Did you mean \"" + best + "\"?"
}

func editDistance(a, b string) int {
	prev := make([]int, len(b)+1)
	cur := make([]int, len(b)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(a); i++ {
		cur[0] = i
		for j := 1; j <= len(b); j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			cur[j] = min3(cur[j-1]+1, prev[j]+1, prev[j-1]+cost)
		}
		prev, cur = cur, prev
	}
	return prev[len(b)]
}

func min3(a, b, c int) int {
	if b < a {
		a = b
	}
	if c < a {
		a = c
	}
	return a
}

func join(path, key string) string {
	if path == "" {
		return key
	}
	return path + "." + key
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

package instance

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A config naming a directory that does not exist must be rewritten, and only there.
func TestRedirectsMissingLogDirectory(t *testing.T) {
	dir := t.TempDir()
	// A path that cannot exist on any platform this runs on — which is the point: the
	// same config travels between machines and only one of them has /Users/alex.
	raw := []byte(`{
	  "log": {"access": "/Users/alex/Library/Group Containers/nope/access.log", "loglevel": "warning"},
	  "outbounds": [{"protocol": "freedom", "tag": "direct"}]
	}`)

	out, redirects, err := redirectLogPaths(raw, dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(redirects) != 1 {
		t.Fatalf("redirects = %d, want 1", len(redirects))
	}
	if redirects[0].Field != "access" {
		t.Errorf("field = %q, want access", redirects[0].Field)
	}
	// The file name survives, so a config that names its logs after an environment stays
	// recognisable after the move.
	if filepath.Base(redirects[0].To) != "access.log" {
		t.Errorf("to = %q, want it to keep the file name", redirects[0].To)
	}

	var doc map[string]json.RawMessage
	if err := json.Unmarshal(out, &doc); err != nil {
		t.Fatalf("output is not valid JSON: %v", err)
	}
	var logBlock map[string]any
	if err := json.Unmarshal(doc["log"], &logBlock); err != nil {
		t.Fatal(err)
	}
	if got := logBlock["access"].(string); got != redirects[0].To {
		t.Errorf("access = %q, want %q", got, redirects[0].To)
	}
	// Everything else in the block is carried through. A rewrite that quietly dropped
	// loglevel would change what the instance reports about itself.
	if logBlock["loglevel"] != "warning" {
		t.Errorf("loglevel = %v, want it preserved", logBlock["loglevel"])
	}
	if _, ok := doc["outbounds"]; !ok {
		t.Error("outbounds went missing from the rewritten config")
	}
}

// A usable path must be left exactly as written — including the bytes, so formatting and
// key order in the rest of the document are untouched when there is nothing to fix.
func TestLeavesUsablePathsAlone(t *testing.T) {
	dir := t.TempDir()
	good := filepath.Join(t.TempDir(), "access.log")
	raw := []byte(`{"log": {"access": ` + quote(good) + `}, "inbounds": []}`)

	out, redirects, err := redirectLogPaths(raw, dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(redirects) != 0 {
		t.Fatalf("redirected %v, want none — the directory exists", redirects)
	}
	if string(out) != string(raw) {
		t.Errorf("config was rewritten despite nothing to fix:\n got %s\nwant %s", out, raw)
	}
}

// "none" and "console" are sinks rather than paths and are always valid.
func TestLeavesSinksAlone(t *testing.T) {
	for _, sink := range []string{"none", "console"} {
		raw := []byte(`{"log": {"access": "` + sink + `", "error": "` + sink + `"}}`)
		out, redirects, err := redirectLogPaths(raw, t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		if len(redirects) != 0 {
			t.Errorf("%s: redirected %v, want none", sink, redirects)
		}
		if string(out) != string(raw) {
			t.Errorf("%s: config was rewritten", sink)
		}
	}
}

// Both fields are handled, and the directory is created on demand.
func TestRedirectsBothFieldsAndCreatesTheDirectory(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "logs", "nested")
	raw := []byte(`{"log": {
	  "access": "/nonexistent-xray-studio/a.log",
	  "error":  "/nonexistent-xray-studio/e.log"
	}}`)

	_, redirects, err := redirectLogPaths(raw, dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(redirects) != 2 {
		t.Fatalf("redirects = %d, want 2", len(redirects))
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		t.Fatalf("log directory was not created: %v", err)
	}
	for _, r := range redirects {
		if !strings.HasPrefix(r.To, dir) {
			t.Errorf("%s went to %q, outside the directory the app owns", r.Field, r.To)
		}
	}
}

// An empty directory disables the mechanism rather than redirecting somewhere arbitrary.
func TestDisabledWithoutADirectory(t *testing.T) {
	raw := []byte(`{"log": {"access": "/nonexistent-xray-studio/a.log"}}`)
	out, redirects, err := redirectLogPaths(raw, "")
	if err != nil || len(redirects) != 0 || string(out) != string(raw) {
		t.Fatalf("expected a no-op, got redirects=%v err=%v", redirects, err)
	}
}

// Malformed JSON is passed straight through: the config loader reports it with a line and
// column, and a second, worse error message from here would only get in the way.
func TestPassesMalformedConfigThrough(t *testing.T) {
	raw := []byte(`{"log": {"access": `)
	out, redirects, err := redirectLogPaths(raw, t.TempDir())
	if err != nil || len(redirects) != 0 || string(out) != string(raw) {
		t.Fatalf("expected a no-op, got redirects=%v err=%v", redirects, err)
	}
}

func quote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

package instance

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The app's paths win over whatever the config asked for, including a path that would
// have worked. A log destination is a property of the machine, not of the config.
func TestOverridesWhateverTheConfigSaid(t *testing.T) {
	dir := t.TempDir()
	usable := filepath.Join(t.TempDir(), "their.log")
	raw := []byte(`{
	  "log": {"access": ` + quote(usable) + `, "error": "/Users/someone-else/e.log", "loglevel": "warning", "dnsLog": true},
	  "outbounds": [{"protocol": "freedom", "tag": "direct"}]
	}`)

	out, paths, err := applyLogPaths(raw, dir)
	if err != nil {
		t.Fatal(err)
	}
	if paths.Access != filepath.Join(dir, "access.log") || paths.Error != filepath.Join(dir, "error.log") {
		t.Fatalf("paths = %+v, want both under %s", paths, dir)
	}

	logBlock := logBlockOf(t, out)
	if logBlock["access"] != paths.Access {
		t.Errorf("access = %v, want %s", logBlock["access"], paths.Access)
	}
	if logBlock["error"] != paths.Error {
		t.Errorf("error = %v, want %s", logBlock["error"], paths.Error)
	}
	// Only the paths are the app's. Everything else in the block belongs to the user, and
	// silently changing loglevel would change what the instance reports about itself.
	if logBlock["loglevel"] != "warning" {
		t.Errorf("loglevel = %v, want it preserved", logBlock["loglevel"])
	}
	if logBlock["dnsLog"] != true {
		t.Errorf("dnsLog = %v, want it preserved", logBlock["dnsLog"])
	}

	var doc map[string]json.RawMessage
	if err := json.Unmarshal(out, &doc); err != nil {
		t.Fatalf("output is not valid JSON: %v", err)
	}
	if _, ok := doc["outbounds"]; !ok {
		t.Error("outbounds went missing from the rewritten config")
	}
}

// A config with no log block at all still gets one: "always" has to mean always, or the
// Log tab would have nothing to point at for exactly the simplest configs.
func TestAddsALogBlockWhenThereIsNone(t *testing.T) {
	dir := t.TempDir()
	out, paths, err := applyLogPaths([]byte(`{"outbounds": []}`), dir)
	if err != nil {
		t.Fatal(err)
	}
	if paths.Access == "" {
		t.Fatal("no paths assigned")
	}
	if logBlockOf(t, out)["access"] != paths.Access {
		t.Error("access was not set on a config that had no log block")
	}
}

// "none" and "console" are sinks rather than paths, and they are overridden too. This is
// the deliberate consequence of the app owning the destinations, and it is pinned here so
// that the choice is visible rather than discovered.
func TestOverridesSinksToo(t *testing.T) {
	dir := t.TempDir()
	out, paths, err := applyLogPaths([]byte(`{"log": {"access": "none", "error": "console"}}`), dir)
	if err != nil {
		t.Fatal(err)
	}
	if logBlockOf(t, out)["access"] != paths.Access {
		t.Error("a 'none' sink was left in place")
	}
}

// The directory is created on demand, however deep.
func TestCreatesTheDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "logs", "nested")
	if _, _, err := applyLogPaths([]byte(`{}`), dir); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		t.Fatalf("log directory was not created: %v", err)
	}
}

// An empty directory disables the whole mechanism rather than writing somewhere
// arbitrary.
func TestDisabledWithoutADirectory(t *testing.T) {
	raw := []byte(`{"log": {"access": "/somewhere/a.log"}}`)
	out, paths, err := applyLogPaths(raw, "")
	if err != nil || paths.Access != "" || string(out) != string(raw) {
		t.Fatalf("expected a no-op, got paths=%+v err=%v", paths, err)
	}
}

// Malformed JSON passes straight through: the config loader reports it with a line and a
// column, and a second, worse message from here would only get in the way.
func TestPassesMalformedConfigThrough(t *testing.T) {
	for _, raw := range [][]byte{
		[]byte(`{"log": {"access": `),      // truncated document
		[]byte(`{"log": "not-an-object"}`), // log is the wrong shape
	} {
		out, paths, err := applyLogPaths(raw, t.TempDir())
		if err != nil || paths.Access != "" || string(out) != string(raw) {
			t.Fatalf("%s: expected a no-op, got paths=%+v err=%v", raw, paths, err)
		}
	}
}

func logBlockOf(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("output is not valid JSON: %v", err)
	}
	var block map[string]any
	if err := json.Unmarshal(doc["log"], &block); err != nil {
		t.Fatalf("log block is not an object: %v", err)
	}
	return block
}

func quote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

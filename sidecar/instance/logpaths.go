package instance

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

/*
Redirect log files whose directory does not exist.

Xray does not create the directory and does not fall back to stderr: it refuses to start
outright with "failed to initialize access logger". That makes it one of the very few
config errors that stops the instance dead before anything can be observed — and the
likeliest way to meet it is opening a config written on another machine, where a path
under /Users, /home or C:\Users means nothing.

Refusing to run someone else's config over a log path is a poor trade for a tool whose
entire job is to tell them what that config does. So the path is redirected to a
directory this app owns, and the substitution is REPORTED rather than performed quietly.
That last part matters more than the fix: a config tester that silently runs something
other than what you handed it is worse than one that refuses, because you would carry its
conclusions back to a config that never had them.

Only the log block is touched, only when the directory is genuinely missing, and only in
the bytes handed to the parser — the file on disk is never modified.
*/

// LogRedirect records one substitution, for reporting to the UI.
type LogRedirect struct {
	Field string `json:"field"` // "access" or "error"
	From  string `json:"from"`
	To    string `json:"to"`
}

// redirectLogPaths rewrites unusable log destinations in raw config bytes.
//
// dir is where redirected logs are written; it is created on demand. A nil or empty dir
// disables the whole mechanism, and the config is returned untouched.
func redirectLogPaths(raw []byte, dir string) ([]byte, []LogRedirect, error) {
	if dir == "" {
		return raw, nil, nil
	}

	// Decoded into a generic map rather than a typed struct so that everything the
	// config carries — including keys this build knows nothing about — survives the
	// round trip untouched.
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(raw, &doc); err != nil {
		// Not our error to report: the loader will produce a far better message with a
		// line and column. Hand the original bytes on.
		return raw, nil, nil
	}
	logRaw, ok := doc["log"]
	if !ok {
		return raw, nil, nil
	}

	var logBlock map[string]json.RawMessage
	if err := json.Unmarshal(logRaw, &logBlock); err != nil {
		return raw, nil, nil
	}

	var redirects []LogRedirect
	for _, field := range []string{"access", "error"} {
		var path string
		if err := json.Unmarshal(logBlock[field], &path); err != nil || path == "" {
			continue
		}
		// Xray treats these as sinks, not paths, and both always work.
		if path == "none" || path == "console" {
			continue
		}
		if info, err := os.Stat(filepath.Dir(path)); err == nil && info.IsDir() {
			continue
		}
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return raw, nil, fmt.Errorf("creating the log directory: %w", err)
		}
		// Keep the original file name: a config naming its logs after an environment
		// stays recognisable, and two configs redirected at once do not collide.
		to := filepath.Join(dir, filepath.Base(path))
		enc, err := json.Marshal(to)
		if err != nil {
			return raw, nil, err
		}
		logBlock[field] = enc
		redirects = append(redirects, LogRedirect{Field: field, From: path, To: to})
	}

	if len(redirects) == 0 {
		return raw, nil, nil
	}

	newLog, err := json.Marshal(logBlock)
	if err != nil {
		return raw, nil, err
	}
	doc["log"] = newLog
	out, err := json.Marshal(doc)
	if err != nil {
		return raw, nil, err
	}
	return out, redirects, nil
}

package instance

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

/*
The app owns the log destinations.

Every config that starts here gets its log.access and log.error rewritten to files in a
directory this app controls, whatever the config said — including when it said nothing at
all. Only the paths change; loglevel, dnsLog and everything else in the block are the
user's.

The reason is that a log path is a property of the machine, not of the config, and these
configs travel. A path under /Users, /home or C:\Users is meaningful on exactly one
computer, and Xray does not degrade politely when it is wrong: it does not create the
directory, does not fall back to stderr, and refuses to start with "failed to initialize
access logger". Testing someone else's config should not require first repairing a path
that has nothing to do with what is being tested.

The substitution is silent by design. The paths in use are shown in the Log tab, which is
where someone goes when they want to know where the logs are.

The file on disk is never modified; this rewrites only the bytes handed to the parser.
*/

// LogPaths is where this instance's logs are actually being written.
type LogPaths struct {
	Access string `json:"access"`
	Error  string `json:"error"`
}

// applyLogPaths points the config's log files at the app's own directory.
//
// An empty dir disables the mechanism and returns the config untouched, which is what
// makes the behaviour testable and keeps a misconfigured build from writing to a
// surprising place.
func applyLogPaths(raw []byte, dir string) ([]byte, LogPaths, error) {
	var paths LogPaths
	if dir == "" {
		return raw, paths, nil
	}

	// A generic map rather than a typed struct, so everything the config carries —
	// including keys this build knows nothing about — survives the round trip.
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(raw, &doc); err != nil {
		// Not this function's error to report: the loader produces a far better message,
		// with a line and column. Hand the original bytes on.
		return raw, paths, nil
	}

	logBlock := map[string]json.RawMessage{}
	if existing, ok := doc["log"]; ok {
		// A malformed log block is left for the loader to complain about properly.
		if err := json.Unmarshal(existing, &logBlock); err != nil {
			return raw, paths, nil
		}
	}

	if err := os.MkdirAll(dir, 0o755); err != nil {
		return raw, paths, fmt.Errorf("creating the log directory: %w", err)
	}
	paths = LogPaths{
		Access: filepath.Join(dir, "access.log"),
		Error:  filepath.Join(dir, "error.log"),
	}

	for field, path := range map[string]string{"access": paths.Access, "error": paths.Error} {
		enc, err := json.Marshal(path)
		if err != nil {
			return raw, LogPaths{}, err
		}
		logBlock[field] = enc
	}

	newLog, err := json.Marshal(logBlock)
	if err != nil {
		return raw, LogPaths{}, err
	}
	doc["log"] = newLog
	out, err := json.Marshal(doc)
	if err != nil {
		return raw, LogPaths{}, err
	}
	return out, paths, nil
}

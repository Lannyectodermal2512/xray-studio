# Changelog

## 0.1.0-alpha.1

First public build. Alpha: interfaces and file formats may change without notice, and
the fault engine acts on **real servers** in the config you open.

Built against Xray-core **v26.7.28**, patched with a nine-commit telemetry series
(`xray/patches/`).

### Observability

- **Decision funnel** — why a balancer picked the outbound it picked, stage by stage,
  with a stable rejection reason for every candidate that dropped out. Threaded through
  the real strategy code rather than reimplemented, and pinned by an equivalence test
  over 10,000 randomised cases.
- **Observe** — live RTT chart with a per-outbound probe lane showing every probe,
  successful and failed, on the chart's own time axis. Failures are never plotted as
  values: the observatory represents a dead probe as a sentinel (`99999999` plain,
  `MaxInt64` burst), and charting those would flatten every real measurement.
- **Log** — the core's structured log stream, filterable by severity and connection id.
- **Self-check** — continuously re-derives the dashboard's claims from the core's own
  answers, using the side-effect-free `GetPrincipleTarget` oracle.

### Fault injection

Eleven fault kinds at the dialer level — blackhole, refuse, host/net unreachable,
DNS failure, TLS hang, TLS garbage, latency, throttle, reset-after, UDP loss — applied
to real dials so probes and user traffic see the same failure. Hard-down faults also
poison established connections, because a firewall does not wait for existing flows to
finish.

The UI states the four fidelity limits rather than burying them: `dialerProxy` hops
never reach the dialer, WireGuard's gVisor stack dials internally, `burst.checkConnectivity`
uses a bare HTTP client outside Xray, and there is no TCP segment loss, ICMP or PMTUD.

### Config work

- **Validate** — catches configs Xray *accepts* and then does not act on: unknown keys
  (Go's JSON decoder ignores them silently), `leastLoad` without an observatory, a
  selector matching nothing, a `fallbackTag` pointing nowhere, `tolerance` without
  `burstObservatory`, and traps that make faults look broken. The known-key set is
  derived by reflecting over `conf.Config`, so it cannot drift from the parser.
- **Editor** — the whole config as text, with a documentation hint for whatever the
  pointer is over. The pointer position maps arithmetically to a character offset
  (the font is monospace), and `getLocation` turns that into the JSON path the docs are
  keyed by — so hints are exact rather than guessed from the nearest word, including
  inside protocol `settings`, which are keyed by protocol.
- **Graph** — the config as a diagram, editable: click a node and change it. Every edit
  is a minimal text patch, so protocol settings, TLS, Reality, `mux`, comments and
  formatting survive untouched. Individual nodes can also be edited as raw JSON.
  Nodes are banded by group — the same tag-prefix split the rail and the RTT legend use
  — on an unbounded pan-and-zoom canvas: a diagram sized to its content forces a choice
  between labels too small to read and a mostly-empty page to scroll. Any group can be
  dragged where its reader wants it; the automatic layout is a starting point, not a
  claim about what matters in a particular config. The one spacing control widens the
  gap between COLUMNS, which is the only dimension where more room buys legibility —
  every edge crosses it.
- **Reference / Protocols** — 311 documented parameters and the generated
  `settings` schema for every protocol in the registry.
- **What-if** — runs the real strategy against a frozen observation and reports the
  outcome over 1,000 trials, because `random` and `leastLoad` end in a uniform draw.

### Known limits

- macOS arm64 only. The fault dialer's errno layer is behind a build tag and only the
  `_unix` variant exists; Windows will not build.
- Unsigned and un-notarised — see the README for the one-time quarantine removal.
- One config per process. Reload is a respawn, by design.

# Patched Xray-core

The sidecar builds against a **pinned, patched** checkout of
[XTLS/Xray-core](https://github.com/XTLS/Xray-core), reproduced on demand into `.build/xray-core/`
by `scripts/bootstrap-xray.sh`. That directory is gitignored — the source of truth is
`PIN` + `patches/`.

## The pin

```
PIN = 5ca6f4b7d4dc20a881d4330e498892697627ec0c   # tag v26.7.28, 2026-07-28
```

### Why a commit SHA and not the tag

`v26.7.28` is **not a resolvable Go module version**. `go.mod` at that tag declares the module
path as `github.com/xtls/xray-core` with no `/v26` suffix, so Go rejects it:

```
$ go get github.com/xtls/xray-core@v26.7.28
invalid version: module contains a go.mod file, so module path must match major
version ("github.com/xtls/xray-core/v26")
```

XTLS historically published two tags per release — `vYY.M.D` (human) and `v1.YYMMDD.N`
(Go-legal). **They stopped publishing the `v1.*` companion after v26.3.27.** The newest one that
exists is `v1.260327.0`, so every release from v26.4.13 onward is reachable only by
pseudo-version:

```
v1.260327.1-0.20260728075948-5ca6f4b7d4dc
```

`go get github.com/xtls/xray-core@5ca6f4b7d4dc20a881d4330e498892697627ec0c` produces exactly that.

## Integrity — read this

`sidecar/go.mod` contains:

```gomod
replace github.com/xtls/xray-core => ../.build/xray-core
```

A directory `replace` **bypasses `go.sum` verification for that module**. Go will not detect a
tampered or accidentally-edited checkout. Therefore:

> **`xray/PIN` plus the patch stamp ARE the integrity mechanism for xray-core.**

`scripts/check-pin.sh` enforces both:

1. the commit `N` patches back from `HEAD` equals `PIN` (where `N` = number of patch files), and
2. `.build/xray-core/.xray-studio-stamp` equals `sha256(PIN || all patch files)`.

Run it before trusting a build. `scripts/dev.sh` runs it automatically and exports
`GOFLAGS=-mod=readonly` so a stray `go get` cannot silently rewrite the pin.

Two further hazards worth knowing:

- `go get -u` / Dependabot would move off the pseudo-version the moment XTLS publishes any
  `v1.2608xx.0` tag, because that sorts above `v1.260327.1-0…`. The `replace` neutralises this for
  xray-core itself, but keep the `require` line's `// tag v26.7.28` comment intact.
- The pseudo-version's base is a **pre-release** of `v1.260327.1`. Any transitive dependency that
  requires `v1.260327.1` or higher would win MVS. The `replace` also neutralises this, but
  `go mod verify` still matters for everything else.

## Patch series

Every patch obeys one invariant:

> A hook is a package-level `func` var, nil by default, copied to a local before being called, and
> set exactly once before `core.New()`. When unset, the cost is a single nil compare and behaviour
> is **byte-identical** to upstream. **Hooks must never block** — `OnBalancerEval` fires on the
> synchronous per-connection data path.

| # | Touches | What it exposes |
|---|---|---|
| 0001 | **new** `xraytrace/` | Event structs, the three hook vars, the nil-safe `Trace` accumulator, and a probe-origin context marker. Stdlib-only (no import cycles). Zero upstream diff, so it can never conflict on rebase. |
| 0002 | `common/errors/errors.go` | `ConnID()` / `Caller()` / `Sev()`. `doLog` already stores `ctx.IDFromContext` in the unexported `prefix`; this exposes the free per-connection correlation ID that joins the whole event model. |
| 0003 | `features/routing/session/context.go` | Carries the `context.Context` so a balancer decision can be attributed to a connection. |
| 0004 | `app/observatory/observer.go` | Probe start/end, including `errorCollector.UnderlyingError()` which upstream only ever sends to the log, never into `LastErrorReason`. |
| 0005 | `app/observatory/burst/healthping.go` | Probe start/end + round ID. Notably emits `Class:"net_down"` — the case whose result the collector **discards** (`if rtt.value > 0`) and which is invisible today. |
| 0006 | `app/router/balancing.go`, `strategy_{random,leastping,leastload}.go` | The decision trace, **threaded through the existing code**. |
| 0007 | `app/router/router.go`, `config.go` | Rule-match events with the loop index (upstream uses `for _, rule :=`, so the index has to be introduced), plus both `ErrNoClue` returns so "no rule matched → default outbound" stops being invisible. |
| 0008 | `app/dispatcher/default.go` | One line: append `": ", err` at the `"default route for"` log. Recovers the discarded `"balancing strategy returns empty tag"`. |
| 0009 | **new** `app/router/simulation.go` | A seam for offline what-if analysis: inject an observatory directly (no live instance needed) and return a decision trace instead of publishing it. Each strategy applies the same observatory gate it would apply live, so a simulation reproduces `random`/`roundRobin` ignoring the observatory without a `fallbackTag`. |

Total: 12 upstream files (2 of them tests), ~380 changed lines plus a 420-line test, and two new packages/files that carry no upstream diff at all.

### Why the trace is threaded in, rather than reimplemented alongside

The obvious alternative — leave the strategy files untouched and put "explaining" copies
of the four algorithms in new files — was rejected. `leastLoad` in particular branches on
`costs`, `baselines`, `expected`, `maxRTT`, `tolerance` and the presence of `HealthPing`,
and a parallel implementation can drift from the real one in ways random testing does not
catch. The UI presents this trace as the reason a decision was made; a drifted copy would
make it lie.

So `PickOutbound` and `PickOutboundTraced` are literally the same function:

```go
func (s *LeastLoadStrategy) PickOutbound(c []string) string {
    return s.PickOutboundTraced(c, nil)
}
```

Every `*xraytrace.Trace` method is nil-safe, so with tracing off the added cost is a
handful of nil checks and behaviour is unchanged. **A nil `*Trace` is the normal disabled
state, which means assigning to a field directly (`tr.Foo = x`) panics** — only the
methods are safe. Everything a caller needs to set is therefore an argument to
`NewTrace`. (Upstream's own `TestSimpleBalancer` caught exactly this mistake once.)

The price is that `strategy_leastload.go` carries a real diff instead of none, so a future
Xray release may conflict there. That is a cheap, visible, one-time cost per release —
unlike silent drift, which is neither.

## Rebasing onto a newer Xray

```bash
scripts/rebase-xray.sh <new-commit-sha>
```

It fetches the new commit, resets to it, replays the series with `git am --3way`, and reports
which patch failed if any. On success it rewrites `PIN` and regenerates the patch files from the
replayed commits, so the series stays canonical.

Expect one or two hunks per Xray release, most likely in `healthping.go`, `balancing.go` or
`strategy_leastload.go` — the three files with the largest diffs. Patch 0001 is a new
directory and can never conflict.

After a rebase, **re-run the router tests**. They are what lets the UI claim the decision
funnel is ground truth rather than a reconstruction, and they include upstream's own
balancer tests:

```bash
go -C .build/xray-core test ./app/router/ -count=1
go -C sidecar test ./...
```

Then re-check the version-sensitive behaviours against the new tree, because these have
already changed once between releases:

- `leastLoad`'s `tolerance` filter (inert before v26.7.28, enforced from it)
- the burst `interval` clamp (`< 10ns` before v26.7.28, `< 10s` from it)
- `RegisterDialerController`'s signature
- `app/router/webhook.go`'s payload shape

## Licensing

Xray-core is **MPL-2.0**. The patches in `patches/` are modifications of MPL-2.0 files and remain
MPL-2.0. This does not affect the licence of the sidecar or the Electron app, which merely link
against / talk to it.

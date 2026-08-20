<img src="assets/icon.png" width="96" align="right" alt="">

# Xray Studio

**English** · [Русский](README.ru.md)

A desktop tool for testing Xray-core configurations: it shows **why** a load balancer
picked a particular outbound, and lets you make specific outbounds unreachable in a way
that is indistinguishable from a real network failure.

Built against **Xray-core v26.7.28**.

> **Alpha.** Interfaces and file formats may change without notice. More importantly:
> fault injection acts on the **real servers in the config you open** — there is no
> sandbox or lab mode, by design, because a simulated failure would not prove anything
> about your actual setup. Do not point it at production you cannot afford to disturb.

![The decision funnel](docs/img/funnel.png)

<sup>Every stage of a real `leastLoad` decision: the candidates, the arithmetic, the one
that was cut and why — and the dice roll at the end, stated as a dice roll.</sup>

## What you get

| | |
|---|---|
| [**Observe**](docs/TOUR.md#observe--what-the-observatory-sees) | live RTT per outbound, a separate lane for failed probes, and a table that highlights the columns the active strategy actually sorts by |
| [**Why this outbound**](docs/TOUR.md#the-decision-funnel--why-this-outbound) | the balancer's decision, stage by stage, with the reason each candidate was dropped and the numbers behind it |
| [**Faults**](docs/TOUR.md#faults--making-an-outbound-unreachable) | make one outbound unreachable by **tag** — blackhole, refused, unreachable, DNS failure, TLS hang, latency, throttle, reset, packet loss, flaky |
| [**Graph**](docs/TOUR.md#graph--the-config-as-a-diagram-and-an-editor) | the config as a diagram you can edit, with every change written back as a minimal text patch |
| [**Editor**](docs/TOUR.md#editor--the-config-as-text-annotated) | the file as text, with per-parameter documentation under the pointer |
| [**What-if**](docs/TOUR.md#what-if--asking-without-touching-anything) | "what if maxRTT were 200ms, or this host died?", answered by the real strategy code over 1,000 trials |
| [**Validate**](docs/TOUR.md#validate--configs-that-load-and-then-do-nothing) | configs that load cleanly and then never do what they say |
| [**Self-check**](docs/TOUR.md#self-check--auditing-the-tools-own-claims) | the tool continuously re-deriving its own claims from the core's answers |
| [**Reference**](docs/TOUR.md#reference--the-parameter-index) · [**Protocols**](docs/TOUR.md#protocols--the-part-reflection-cannot-see) · [**Log**](docs/TOUR.md#log--the-cores-own-logger-teed) | 360 documented parameters, the per-protocol schema, and the core's own log stream |

**→ [A tour of every tab, with screenshots](docs/TOUR.md)**

## Install

Download from [Releases](../../releases). One file per system:

| system | file | how |
|---|---|---|
| **macOS** 14+ | `macos-universal.dmg` | open, drag to Applications. Intel and Apple Silicon in one build |
| **Windows** 10+ | `win-x64.zip` | **portable** — unpack anywhere, run `Xray Studio.exe`. This is the one to take |
| **Windows** 11 ARM | `win-arm64.zip` | optional. Only worth it for native speed on a Snapdragon machine — the x64 build runs there too, under emulation |
| **Arch Linux** x86_64 | `linux-x86_64.pkg.tar.zst` | `sudo pacman -U <file>` |
| **Arch Linux** ARM | `linux-aarch64.pkg.tar.zst` | `sudo pacman -U <file>` |

If you take the wrong Windows file, Windows says *"This app can't run on your PC"* — that
message always means an architecture mismatch, never a broken download. `win-x64.zip` is
the safe choice: it runs on ordinary PCs natively and on Windows 11 ARM under emulation.
Take `win-arm64.zip` only if you know the machine is ARM and want native speed;
`$env:PROCESSOR_ARCHITECTURE` in PowerShell prints `AMD64` or `ARM64` if you are unsure.

**Windows has no installer.** Nothing is written outside the folder: no registry keys, no
uninstall entry, no `%APPDATA%`. Settings — the API key, the window profile, pasted
configs — live in `XrayStudio-data` beside the executable, so deleting the folder removes
every trace and copying it to a USB stick carries your setup with it. If you put the
folder somewhere unwritable, such as Program Files, the app falls back to `%APPDATA%`
rather than refusing to start.

One thing does not travel between machines: the API key is encrypted with Windows DPAPI,
which is tied to the account that saved it. The folder opens fine elsewhere, but that key
has to be entered again.

Windows and Linux both need two files, for the same reason: there is no
universal binary format on Linux — no fat binary, no equivalent — so a package is built
for one architecture or the other. The names are exactly what `uname -m` prints, so run
that if you are unsure.

The AppImage is the one to reach for when a dependency is missing or the wrong version:
it never resolves packages, so it cannot fail the way an install can. It is not fully
self-contained though — Electron and its private libraries travel with it, but `gtk3`,
`nss` and `glibc` still come from the host. Only Flatpak or a container would remove
that last dependency, and neither is built here.

If it refuses to start with a FUSE error, run it as
`./XrayStudio-*.AppImage --appimage-extract-and-run`.

The Arch package installs to `/opt` with a desktop entry and icons. Its dependencies are
derived from the shipped binary's own `DT_NEEDED` entries rather than copied from an
Electron boilerplate list — `gtk3`, `nss`, `alsa-lib`, `libcups`, `mesa`, `systemd-libs`,
`dbus`, `at-spi2-core`, `xdg-utils` — so `pacman` pulls exactly what is missing and
nothing that was retired from the repositories years ago.

Also in the release:

| file | what |
|---|---|
| `src.tar.gz` | the sources this release was built from, straight out of `git archive` at the tag |
| `*.blockmap` | not for downloading — a map of content-defined chunks and their hashes, which a future auto-updater uses to fetch only the parts of an installer that changed instead of all 200 MB |

None of the builds are signed. macOS needs the quarantine flag cleared once, and Windows
will warn about an unknown publisher:

```bash
xattr -dr com.apple.quarantine "/Applications/Xray Studio.app"
```

To build from source instead, see [Getting started](#getting-started).

## Why it exists

None of the balancer's reasoning is available from Xray's own API:

- `RoutingService.GetBalancerInfo` returns only `{override, principle_target}` — no
  strategy, no candidates, no scores, no rejection reasons. For `random` and
  `roundRobin` it returns the *raw unfiltered* selector output; for `leastPing` a
  single tag; only for `leastLoad` a ranked list, and even then post-truncation and
  score-free.
- `SubscribeRoutingStats` is dead code: `app/router/command/command.go` always passes
  `nil` for the stats channel, so it answers `"Routing statistics not enabled."`
  forever, with no config knob to change that.
- Probe start/finish, individual RTT samples, and per-connection rule matches are not
  exposed at all.
- When a strategy returns nothing and no `fallbackTag` is set, the dispatcher silently
  routes to the **first outbound in the config** and discards the error text.

So the core is patched — minimally, additively, and reproducibly — to emit what is
missing.

## Layout

```
xray/          PIN + the 9-patch telemetry series (the source of truth)
scripts/       bootstrap, pin verification, rebase, dev, test, package, icon, screenshots
sidecar/       Go: runs one Xray instance, injects faults, serves telemetry
app/           Electron + React UI
tools/         docsgen and schemagen, run against the pinned sources
data/          generated: parameter docs (CC BY-SA 4.0) and protocol schema
docs/          the tour and its screenshots, regenerated by scripts/screenshots.sh
examples/      demo-leastload.json (a working balancer) and broken-showcase.json
assets/        icon source and the generated .icns/.png
.build/        gitignored: the patched checkout, binaries and release artefacts
```

## Getting started

Needs **Go ≥ 1.26**, **Node ≥ 22**, **git**, and a network connection on first run (the
Xray-core checkout is cloned, not vendored). Developed on macOS arm64; the fault
dialer's errno layer is behind a build tag and only `_unix` exists so far, so Windows
will not build yet.

```bash
scripts/dev.sh
```

That clones Xray-core at the pinned commit, applies the patch series, builds the
sidecar, installs the app's dependencies and opens the window. Roughly a minute cold,
seconds warm.

If the clone step fails on `git am`, it is almost always commit signing — the bootstrap
disables it inside the checkout, but a `gpg.program` that prompts can still stall.

Then **Open config…**, pick an Xray config, and press **Start**. To skip the picker
while iterating:

```bash
XRAYSTUDIO_CONFIG=/path/to/config.json scripts/dev.sh
```

What each tab does, with a screenshot of it, is in **[the tour](docs/TOUR.md)**. Two
things belong here instead, because they are build steps rather than usage.

The **Reference** tab and the `?` hints are generated from a pinned commit of
XTLS/Xray-docs-next — pinned for the same reason the core is, since unpinned upstream
text would silently change what the app tells you about your config. Upstream publishes
a Russian translation of the same pages, so both bundles are built and the topbar switch
picks between them:

```bash
go -C tools run ./docsgen -out ../data/docs-en
go -C tools run ./docsgen -lang ru -out ../data/docs-ru
```

The **Protocols** tab needs the schema, recovered from the pinned sources by parsing the
registry literals with `go/ast` — the source is the only place that records that
`"vless"` means `VLessOutboundConfig`:

```bash
go -C tools run ./schemagen -src ../.build/xray-core/infra/conf -out ../data/schema
```

[`examples/demo-leastload.json`](examples/demo-leastload.json) is a runnable starting
point: four outbounds, a `leastLoad` balancer with `expected: 2`, and an observatory
probing `cp.cloudflare.com`. Open the **Faults** tab, blackhole one of the `proxy-*`
tags, and watch the observatory notice and the balancer fail over — the **Observe**
tab's funnel will name the reason. It is also the config every screenshot in the tour
was taken against:

```bash
scripts/screenshots.sh
```

```bash
scripts/test.sh
```

### Dev environment variables

| | |
|---|---|
| `XRAYSTUDIO_CONFIG=<path>` | open and start a config on launch |
| `XRAYSTUDIO_TRACE=<path>` | append main-process diagnostics (window lifecycle, sidecar port and token) to a file — Electron's main-process stdout is not reliably captured when launched detached, which otherwise makes "no window appeared" undiagnosable |
| `XRAYSTUDIO_SHOT=<png>[,<ms>]` | capture the window from inside the app, bypassing macOS Screen Recording permissions |
| `XRAYSTUDIO_SHOT_JS=<js>` | run JS in the renderer before capturing (to pick a tab or scroll) |
| `XRAYSTUDIO_SHOTS=<json>` | capture a whole sequence from one launch, then quit — `[{file, js?, delay?}, …]`. `scripts/screenshots.sh` uses this to regenerate the documentation set |

## How it works

**The patched core** (`xray/patches/`, 9 commits, ~380 lines across 12 files) adds a
`xraytrace` package with three nil-by-default hooks: probe events, balancer decisions,
routing rule matches. When the hooks are unset the cost is a nil comparison and
behaviour is byte-identical to upstream.

The decision trace is **threaded through the real balancer code**, not reimplemented
beside it — `PickOutbound` calls `PickOutboundTraced` with a nil trace, and every
trace method is nil-safe. There is exactly one implementation of each balancing
algorithm, so the explanation cannot drift from the behaviour it explains. See
[xray/README.md](xray/README.md).

**The sidecar** embeds xray-core as a library (no fork needed for this part) and
replaces its system dialer via the exported, API-stable
`internet.UseAlternativeSystemDialer`.

**Fault injection keys on the outbound tag**, read from the dial context. That is the
whole point: two outbounds can share a server IP and port, and a packet filter
physically cannot tell them apart — `pf` and `iptables` see identical 5-tuples. A tag
can. `sidecar/e2e_test.go` proves exactly this case.

Faults are faithful because observatory probes and user traffic take the *same* dial
path, so health checks see the failure the same way real connections do — which is how
a firewall whitelist behaves. Synthesized errors are asserted byte-identical to real
kernel errors (`sidecar/fault/fault_test.go` compares against a genuine
`ECONNREFUSED` from `127.0.0.1:1`), and live connections are torn down too, since a
firewall does not wait politely for existing flows to finish.

### What the faults cannot do

Stated here and surfaced in the UI, because the claim is "as if genuinely unreachable"
and it is only mostly true:

1. `sockopt.dialerProxy` hops get a pipe from `redirect()` and never reach the dialer.
2. WireGuard's inner gVisor netstack dials bypass it; only the outer UDP is covered.
3. `burstObservatory`'s `connectivity` check uses a bare `http.Client` outside Xray.
4. No TCP segment loss (userspace can only stall or jitter), no ICMP, no PMTUD.
5. DNS failure is partial — resolution can happen before the dialer is reached.

## Status

| | |
|---|---|
| M0 — pinned + patchable core, sidecar, app shell | done |
| M1.1 — telemetry patch series + decision trace | done |
| M1.2 — event bus + control plane | done |
| M1.3 — fault engine | done |
| M1.4 — main process, sidecar supervision, 30Hz event store | done |
| M1.5–M1.7 — dashboard: probe table, RTT chart, decision funnel, faults, graph | done |
| M1.8 — what-if simulator | done |
| M1.9 — self-check | done |
| **M1 complete** | |
| M2.1 — validator (silent dysfunction) | done |
| M2.2 — per-parameter docs from XTLS/Xray-docs-next | done |
| M3 — visual config editing | done |
| M4 — protocol schema generated from infra/conf | done |

## Environment note

`~/Documents` is synced by iCloud Drive on this machine, which creates
`filename 2.go` conflict copies when files change quickly — and duplicate `.go` files
break the Go build with redeclaration errors. `.build/` and `app/node_modules` are
marked with the `com.apple.fileprovider.ignore#P` attribute to keep them out of sync.
If stray `* 2.*` files reappear:

```bash
find . -name "* [0-9].*" -not -path "./.git/*" -delete
```

## Licensing

Xray-core is **MPL-2.0**; the patches in `xray/patches/` are modifications of MPL-2.0
files and remain so.

The parameter text in `data/docs-en/` is **adapted from XTLS/Xray-docs-next and is
CC BY-SA 4.0**. Because it is adapted material, ShareAlike applies to it — so it lives
in its own directory with its own `LICENSE` and `ATTRIBUTION.md`, and every tooltip
links back to the upstream page. That obligation covers the extracted text only; it
does not extend to this project's code, which merely reads the file at runtime.

The app's own explanatory copy — the rejection reasons, the notes about behaviour the
official docs do not mention — is deliberately kept separate from the extract, so
neither is misattributed to the other.

## Packaging

```bash
npm run package
```

```bash
npm run package:all          # every platform, one command
npm run package -- win       # or just one: mac, win, linux
```

Both clear `.build/dist/` first. electron-builder overwrites what it produces but never
removes what it no longer produces, so without that a stale artefact from an earlier
version sits there looking current and gets uploaded with the rest.

Verifies the pinned core, runs the tests and **refuses to package if they fail**, builds
the sidecar for *every* target — so a Windows-only break surfaces on a macOS release
rather than waiting for a Windows one — builds the renderer, and writes the installers
plus a source archive to `.build/dist/`.

macOS, Windows and Linux artefacts can all be produced from a Mac; CI builds each on its
own runner anyway, because an AppImage assembled on Linux and an installer assembled on
Windows are the ones users will actually run.

The source archive comes from `git archive` at HEAD, not from the working tree. That
means it contains exactly the tracked files — it cannot pick up `node_modules`, the
patched core or a previous release artefact — and if the working tree has drifted from
HEAD the script says so, because the binaries would then have been built from something
the archive does not describe. The Go binary and the generated `data/` bundles ship as
`extraResources` outside the asar — the sidecar has to be a real file on disk to be
spawned, and the data files are looked up by path.

The icon is generated from `assets/icon.svg`:

```bash
npm run icon
```

It rasterises through Chromium rather than ImageMagick, which without a librsvg delegate
silently drops every stroke — the first attempt came out as three dots with all the
connecting lines missing and no warning.

Tagging `v*` runs the same script in CI and attaches the artefacts to a **draft**
pre-release, so nothing is downloadable until it has been looked at.

## License

See [`LICENSE`](LICENSE). Third-party terms — Xray-core under MPL-2.0 and the
documentation text under CC BY-SA 4.0 — are set out in
[`THIRD-PARTY.md`](THIRD-PARTY.md), along with how a release satisfies MPL's source
requirement: the patched core is reproducible from `xray/PIN` and `xray/patches/`, not
merely available.

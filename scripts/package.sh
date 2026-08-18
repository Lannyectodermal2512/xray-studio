#!/usr/bin/env bash
# Build a distributable macOS app: .dmg and .zip in .build/dist/.
#
# Everything the packaged app needs must exist BEFORE electron-builder runs, because it
# copies extraResources rather than building them: the Go sidecar and the generated
# data/ bundles. Building them here rather than documenting the order keeps a release
# from silently shipping a stale sidecar.
#
# Usage: scripts/package.sh [mac|win|linux|all]   (default: the host platform)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export GOFLAGS="${GOFLAGS:-} -mod=readonly"

info() { printf '\033[36m•\033[0m %s\n' "$*"; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

info "verifying the patched core"
./scripts/bootstrap-xray.sh
./scripts/check-pin.sh >/dev/null

TARGET="${1:-host}"
if [[ "$TARGET" == host ]]; then
  case "$(uname -s)" in
    Darwin) TARGET=mac ;;
    Linux)  TARGET=linux ;;
    MINGW*|MSYS*|CYGWIN*) TARGET=win ;;
    *) die "cannot infer a target from $(uname -s); pass mac, win, linux or all" ;;
  esac
fi

case "$TARGET" in
  mac)   PLATFORMS=(mac) ;;
  win)   PLATFORMS=(win) ;;
  linux) PLATFORMS=(linux) ;;
  all)   PLATFORMS=(mac win linux) ;;
  *) die "unknown target: $TARGET" ;;
esac

# Start from an empty output directory.
#
# electron-builder overwrites what it produces but does not remove what it no longer
# produces, so a stale artefact from an earlier version or a target you have since
# dropped would sit in dist/ looking current — and get uploaded with the rest.
info "clearing .build/dist"
rm -rf .build/dist

# A release that ships a broken engine is worse than no release. Tests run once, on the
# host: they exercise logic, not platform bindings.
info "running tests"
go -C sidecar test ./... >/dev/null || die "sidecar tests failed — refusing to package"
[[ -d app/node_modules ]] || { info "installing app dependencies"; npm --prefix app install; }
npm --prefix app run test >/dev/null || die "app tests failed — refusing to package"

# Build the sidecar for EVERY target, not only the ones being packaged. A Windows-only
# build break should surface on any release, not wait for a Windows one — and the cost
# is a few seconds of cross-compilation.
info "building sidecars for every target"
while read -r plat arch; do
  [[ -z "$plat" ]] && continue
  ./scripts/build-sidecar.sh "$plat" "$arch" >/dev/null \
    || die "the sidecar does not build for $plat/$arch"
done <<'TARGETS'
mac arm64
linux x64
linux arm64
win x64
win arm64
TARGETS

[[ -f assets/icon.icns ]] || { info "generating icon"; ./scripts/make-icon.sh >/dev/null; }

info "type-checking and building the renderer"
npm --prefix app run build

info "packaging for: ${PLATFORMS[*]}"
FLAGS=()
for p in "${PLATFORMS[@]}"; do FLAGS+=("--$p"); done
# Run from app/, not via `npm --prefix`: --prefix changes where npm looks for the
# package, not the process cwd, and electron-builder resolves both its config path and
# every relative path inside it against cwd.
(cd app && ./node_modules/.bin/electron-builder "${FLAGS[@]}" --config electron-builder.yml)

info "archiving sources"
# Built with `git archive` rather than `tar --exclude`, deliberately.
#
# git archive emits exactly the tracked files, so it cannot pick up node_modules, the
# patched core, an editor's swap file or a previous release artefact. The hand-rolled
# tarball this replaced did: it came out at 194 MB because a stale exclude let
# node_modules and .build in, and nobody would notice until someone downloaded it.
#
# It also archives HEAD, not the working tree — which is what makes the file honest.
# The binaries above were built from the working tree, so if that has drifted from HEAD
# the two artefacts describe different code. Say so rather than shipping the mismatch
# silently.
VERSION="$(node -p "require('./package.json').version")"
SRC=".build/dist/XrayStudio-${VERSION}-src.tar.gz"

if git rev-parse --git-dir >/dev/null 2>&1 && git rev-parse HEAD >/dev/null 2>&1; then
  if [[ -n "$(git status --porcelain)" ]]; then
    printf '\033[33mwarning:\033[0m working tree is dirty — the source archive is HEAD,\n'
    printf '         but the binaries were built from your uncommitted changes.\n'
    git status --short | sed 's/^/         /'
  fi
  git archive --format=tar.gz \
    --prefix="xray-studio-${VERSION}/" \
    -o "$SRC" HEAD
else
  die "not a git repository with a commit — the source archive needs one.
     Reproducibility is the point: an archive of whatever happened to be on disk
     cannot be checked against anything."
fi

printf '\033[32m✓\033[0m artifacts in .build/dist/\n'
ls -lh .build/dist/* 2>/dev/null | grep -vE '/(mac|win|linux)-' | sed 's/^/  /' || true

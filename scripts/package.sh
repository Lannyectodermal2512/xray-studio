#!/usr/bin/env bash
# Build a distributable macOS app: .dmg and .zip in .build/dist/.
#
# Everything the packaged app needs must exist BEFORE electron-builder runs, because it
# copies extraResources rather than building them: the Go sidecar and the generated
# data/ bundles. Building them here rather than documenting the order keeps a release
# from silently shipping a stale sidecar.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export GOFLAGS="${GOFLAGS:-} -mod=readonly"

info() { printf '\033[36m•\033[0m %s\n' "$*"; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

info "verifying the patched core"
./scripts/bootstrap-xray.sh
./scripts/check-pin.sh >/dev/null

info "building sidecar"
mkdir -p .build/bin
go -C sidecar build -o "$ROOT/.build/bin/xray-studio-sidecar" ./cmd/sidecar

# A release that ships a broken engine is worse than no release.
info "running tests"
go -C sidecar test ./... >/dev/null || die "sidecar tests failed — refusing to package"

[[ -f assets/icon.icns ]] || { info "generating icon"; ./scripts/make-icon.sh >/dev/null; }

[[ -d app/node_modules ]] || { info "installing app dependencies"; npm --prefix app install; }

info "type-checking and building the renderer"
npm --prefix app run build

info "packaging"
# Run from app/, not via `npm --prefix`: --prefix changes where npm looks for the
# package, not the process cwd, and electron-builder resolves both its config path and
# every relative path inside it against cwd.
(cd app && ./node_modules/.bin/electron-builder --mac --config electron-builder.yml)

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
ls -lh .build/dist/*.dmg .build/dist/*.zip .build/dist/*-src.tar.gz 2>/dev/null | sed 's/^/  /' || true

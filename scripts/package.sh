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

printf '\033[32m✓\033[0m artifacts in .build/dist/\n'
ls -lh .build/dist/*.dmg .build/dist/*.zip 2>/dev/null | sed 's/^/  /' || true

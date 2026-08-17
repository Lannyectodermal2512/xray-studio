#!/usr/bin/env bash
# Clean checkout → running app, in one command.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# A stray `go get` must never be able to rewrite the pin. See xray/README.md.
export GOFLAGS="${GOFLAGS:-} -mod=readonly"

./scripts/bootstrap-xray.sh
./scripts/check-pin.sh >/dev/null

printf '\033[36m•\033[0m building sidecar\n'
mkdir -p .build/bin
go -C sidecar build -o "$ROOT/.build/bin/xray-studio-sidecar" ./cmd/sidecar

if [[ ! -d app/node_modules ]]; then
  printf '\033[36m•\033[0m installing app dependencies\n'
  npm --prefix app install
fi

# Electron ships as a postinstall download. It can be skipped (offline, a sandboxed
# install, `ignore-scripts`), and the failure is silent until `electron-vite dev`
# dies with a confusing error — so check for the binary rather than the package.
if [[ ! -f app/node_modules/electron/dist/version ]]; then
  printf '\033[36m•\033[0m fetching electron binary (~150 MB, one time)\n'
  node app/node_modules/electron/install.js
fi

printf '\033[32m✓\033[0m starting\n'
exec npm --prefix app run dev

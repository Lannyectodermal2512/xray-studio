#!/usr/bin/env bash
# Build the Go sidecar for one target: scripts/build-sidecar.sh <platform> <arch>
#
# platform is electron-builder's naming (mac|win|linux) and arch is its arch naming
# (x64|arm64), not Go's. Keeping the OUTPUT in those terms is what lets
# electron-builder's ${arch} macro find the right binary without a mapping table in the
# packaging config, and what lets the app locate it by process.platform/process.arch.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PLATFORM="${1:?usage: build-sidecar.sh <mac|win|linux> <x64|arm64>}"
ARCH="${2:?usage: build-sidecar.sh <mac|win|linux> <x64|arm64>}"

case "$PLATFORM" in
  mac)   GOOS=darwin  ;;
  win)   GOOS=windows ;;
  linux) GOOS=linux   ;;
  *) echo "unknown platform: $PLATFORM" >&2; exit 1 ;;
esac

case "$ARCH" in
  x64)   GOARCH=amd64 ;;
  arm64) GOARCH=arm64 ;;
  *) echo "unknown arch: $ARCH" >&2; exit 1 ;;
esac

EXE="xray-studio-sidecar"
[[ "$GOOS" == "windows" ]] && EXE="$EXE.exe"
OUT="$ROOT/.build/bin/$PLATFORM-$ARCH/$EXE"
mkdir -p "$(dirname "$OUT")"

# CGO off: the sidecar is pure Go, and enabling it would make every cross build need a
# matching C toolchain for no benefit.
GOOS="$GOOS" GOARCH="$GOARCH" CGO_ENABLED=0 \
  go -C sidecar build -trimpath -o "$OUT" ./cmd/sidecar

printf '\033[32m✓\033[0m %s (%s/%s, %s)\n' \
  "${OUT#$ROOT/}" "$GOOS" "$GOARCH" "$(du -h "$OUT" 2>/dev/null | cut -f1 | tr -d ' ' || echo '?')"

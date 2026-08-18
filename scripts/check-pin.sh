#!/usr/bin/env bash
# Verify .build/xray-core is exactly PIN + the committed patch series.
#
# This matters because sidecar/go.mod uses a directory `replace`, which bypasses
# go.sum verification for xray-core. PIN + the patch stamp ARE the integrity check.
# See xray/README.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
XRAY_DIR="$ROOT/.build/xray-core"
PATCH_DIR="$ROOT/xray/patches"
STAMP_FILE="$XRAY_DIR/.xray-studio-stamp"

die() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }
ok()  { printf '\033[32m✓\033[0m %s\n' "$*"; }

# sha256 varies by platform: macOS ships shasum, most Linux images ship sha256sum, and
# git-bash on a Windows runner may have either. The stamp must be identical everywhere
# or a checkout would appear to need rebuilding on every machine.
sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum
  else die "need shasum or sha256sum"; fi
}

PIN="$(tr -d '[:space:]' < "$ROOT/xray/PIN")"
[[ -d "$XRAY_DIR/.git" ]] || die "no checkout at .build/xray-core — run scripts/bootstrap-xray.sh"

shopt -s nullglob
PATCHES=("$PATCH_DIR"/*.patch)
shopt -u nullglob
N=${#PATCHES[@]}

# 1. The commit N patches back from HEAD must be the pin.
BASE="$(git -C "$XRAY_DIR" rev-parse "HEAD~$N" 2>/dev/null)" \
  || die "HEAD~$N does not exist — checkout has fewer than $N commits on top of a base"
[[ "$BASE" == "$PIN" ]] \
  || die "base commit mismatch
     expected $PIN (xray/PIN)
     actual   $BASE (HEAD~$N)"

# 2. The stamp must match sha256(PIN || patches) — catches an edited patch file.
WANT="$( { printf '%s\n' "$PIN"; if [[ $N -gt 0 ]]; then cat "${PATCHES[@]}"; fi; } | sha256 | cut -d' ' -f1)"
[[ -f "$STAMP_FILE" ]] || die "missing stamp — run scripts/bootstrap-xray.sh"
GOT="$(cat "$STAMP_FILE")"
[[ "$WANT" == "$GOT" ]] \
  || die "patch stamp mismatch — patches changed since bootstrap
     run: scripts/bootstrap-xray.sh"

# 3. The working tree must be clean (nothing hand-edited in .build/).
if [[ -n "$(git -C "$XRAY_DIR" status --porcelain --untracked-files=no)" ]]; then
  git -C "$XRAY_DIR" status --short --untracked-files=no >&2
  die "working tree is dirty — .build/xray-core has uncommitted edits.
     Edits there are disposable; move them into xray/patches/ instead."
fi

ok "xray-core verified: ${PIN:0:12} + $N patches, tree clean"

# 4. Advisory: the diff vs PIN should only touch files the series is supposed to touch.
if [[ $N -gt 0 ]]; then
  echo
  echo "Files changed vs pin:"
  git -C "$XRAY_DIR" diff --stat "$PIN" HEAD | sed 's/^/  /'
fi

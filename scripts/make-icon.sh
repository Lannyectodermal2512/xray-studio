#!/usr/bin/env bash
# assets/icon.svg -> assets/icon.icns + assets/icon.png (and the .iconset it came from).
#
# Committed as a script rather than committing only the binaries: the icon is source,
# and a PNG nobody can regenerate is a dead end the first time it needs a tweak.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SVG="$ROOT/assets/icon.svg"
OUT="$ROOT/assets"
SET="$OUT/icon.iconset"
ELECTRON="$ROOT/app/node_modules/.bin/electron"

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m•\033[0m %s\n' "$*"; }

[[ -f "$SVG" ]] || die "missing $SVG"
[[ -x "$ELECTRON" ]] || die "electron not installed — run: npm --prefix app install"

info "rendering 1024px master"
"$ELECTRON" "$ROOT/scripts/render-icon.cjs" "$SVG" "$OUT/icon.png" 1024 >/dev/null 2>&1
[[ -s "$OUT/icon.png" ]] || die "render produced nothing"

info "building iconset"
rm -rf "$SET"
mkdir -p "$SET"
# The names are fixed by iconutil; @2x entries are the same pixel count as the next
# size up, but both must exist or macOS falls back to a blurry scale at some scales.
for spec in "16 icon_16x16" "32 icon_16x16@2x" "32 icon_32x32" "64 icon_32x32@2x" \
            "128 icon_128x128" "256 icon_128x128@2x" "256 icon_256x256" \
            "512 icon_256x256@2x" "512 icon_512x512" "1024 icon_512x512@2x"; do
  px="${spec%% *}"; name="${spec##* }"
  sips -z "$px" "$px" "$OUT/icon.png" --out "$SET/$name.png" >/dev/null
done

info "packing icns"
iconutil -c icns "$SET" -o "$OUT/icon.icns"
rm -rf "$SET"

printf '\033[32m✓\033[0m %s (%s), %s\n' \
  "assets/icon.icns" "$(du -h "$OUT/icon.icns" 2>/dev/null | cut -f1 | tr -d ' ' || echo '?')" "assets/icon.png"

#!/usr/bin/env bash
# Reproduce .build/xray-core/ from xray/PIN + xray/patches/.
#
# Idempotent: writes a stamp of sha256(PIN || patches) and exits early when it
# already matches, so it is cheap to call from `npm run dev` on every start.
#
# Usage: scripts/bootstrap-xray.sh [--force]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
XRAY_DIR="$ROOT/.build/xray-core"
PATCH_DIR="$ROOT/xray/patches"
PIN_FILE="$ROOT/xray/PIN"
STAMP_FILE="$XRAY_DIR/.xray-studio-stamp"
UPSTREAM="https://github.com/XTLS/Xray-core.git"

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m•\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }

[[ -f "$PIN_FILE" ]] || die "missing $PIN_FILE"
PIN="$(tr -d '[:space:]' < "$PIN_FILE")"
[[ "$PIN" =~ ^[0-9a-f]{40}$ ]] || die "xray/PIN must be a full 40-char commit sha, got: $PIN"

# Patch list, lexically sorted. Empty series is valid (M0 bootstraps before any patch exists).
shopt -s nullglob
PATCHES=("$PATCH_DIR"/*.patch)
shopt -u nullglob

# The stamp covers the pin AND every patch byte, so editing a patch forces a rebuild.
# Note: the `if` (rather than `[[ ]] && cat`) matters — under `pipefail` a false
# test as the group's last command makes the whole pipeline exit 1.
compute_stamp() {
  {
    printf '%s\n' "$PIN"
    if [[ ${#PATCHES[@]} -gt 0 ]]; then cat "${PATCHES[@]}"; fi
  } | shasum -a 256 | cut -d' ' -f1
}
WANT_STAMP="$(compute_stamp)"

if [[ $FORCE -eq 0 && -f "$STAMP_FILE" && "$(cat "$STAMP_FILE")" == "$WANT_STAMP" ]]; then
  ok "xray-core up to date (${PIN:0:12}, ${#PATCHES[@]} patches)"
  exit 0
fi

command -v git >/dev/null || die "git not found"

if [[ ! -d "$XRAY_DIR/.git" ]]; then
  info "cloning Xray-core (blobless) → .build/xray-core"
  rm -rf "$XRAY_DIR"
  mkdir -p "$(dirname "$XRAY_DIR")"
  git clone --filter=blob:none --no-checkout "$UPSTREAM" "$XRAY_DIR" >/dev/null 2>&1 \
    || die "clone failed — check network access to github.com"
fi

# These commits are throwaway build artifacts, never pushed anywhere. If the user has
# commit signing on globally (a hardware key, or a 1Password/agent-backed SSH key),
# `git am` would prompt or fail outright — and the failure surfaces as a baffling
# "fatal: failed to write commit object". Disable signing for this checkout only.
git -C "$XRAY_DIR" config commit.gpgsign false
git -C "$XRAY_DIR" config tag.gpgsign false
git -C "$XRAY_DIR" config user.name xraystudio
git -C "$XRAY_DIR" config user.email xray-studio@localhost

info "fetching pinned commit ${PIN:0:12}"
git -C "$XRAY_DIR" fetch --quiet origin "$PIN" 2>/dev/null \
  || git -C "$XRAY_DIR" fetch --quiet origin \
  || die "fetch failed"

git -C "$XRAY_DIR" cat-file -e "${PIN}^{commit}" 2>/dev/null \
  || die "commit $PIN not found upstream"

# Hard reset to the pin. Anything hand-edited in .build/ is disposable by design.
info "resetting to pin"
git -C "$XRAY_DIR" am --abort 2>/dev/null || true   # clear any interrupted replay
git -C "$XRAY_DIR" checkout --quiet --detach "$PIN"
git -C "$XRAY_DIR" reset  --quiet --hard "$PIN"
git -C "$XRAY_DIR" clean  --quiet -fdx -e .xray-studio-stamp

if [[ ${#PATCHES[@]} -gt 0 ]]; then
  info "applying ${#PATCHES[@]} patches"
  # Plain `am`, not --3way. The series is generated against exactly this pin, so it
  # must apply cleanly; if it does not, the tree or the patches are wrong and we want
  # a hard failure rather than a silent merge. (--3way also interacts badly with a
  # blobless clone, since it lazily fetches pre-image blobs mid-apply.)
  # --3way belongs in scripts/rebase-xray.sh, where the base genuinely differs.
  git -C "$XRAY_DIR" am --quiet "${PATCHES[@]}" || {
    FAILED="$(git -C "$XRAY_DIR" am --show-current-patch=raw 2>/dev/null | sed -n 's/^Subject: //p' | head -1)"
    git -C "$XRAY_DIR" am --abort 2>/dev/null || true
    git -C "$XRAY_DIR" reset --quiet --hard "$PIN" 2>/dev/null || true
    die "patch failed to apply: ${FAILED:-unknown}
     The pinned tree has drifted from what the series expects.
     Run: scripts/rebase-xray.sh $PIN"
  }

  # Paranoia: the series must land exactly len(PATCHES) commits on top of the pin.
  ACTUAL_BASE="$(git -C "$XRAY_DIR" rev-parse "HEAD~${#PATCHES[@]}" 2>/dev/null || echo none)"
  [[ "$ACTUAL_BASE" == "$PIN" ]] \
    || die "applied ${#PATCHES[@]} patches but HEAD~${#PATCHES[@]} is $ACTUAL_BASE, not the pin"
else
  info "no patches yet (empty series)"
fi

echo "$WANT_STAMP" > "$STAMP_FILE"
ok "xray-core ready: ${PIN:0:12} + ${#PATCHES[@]} patches"

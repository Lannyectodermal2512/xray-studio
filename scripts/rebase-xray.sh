#!/usr/bin/env bash
# Replay xray/patches/ onto a newer Xray-core commit.
#
#   scripts/rebase-xray.sh <new-commit-sha>
#
# On success: rewrites xray/PIN and regenerates xray/patches/ from the replayed
# commits, so the series stays canonical. On conflict: leaves the checkout mid-am
# so you can resolve by hand, and tells you how to finish.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
XRAY_DIR="$ROOT/.build/xray-core"
PATCH_DIR="$ROOT/xray/patches"
UPSTREAM="https://github.com/XTLS/Xray-core.git"

die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m•\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }

NEW="${1:-}"
[[ -n "$NEW" ]] || die "usage: scripts/rebase-xray.sh <new-commit-sha>"

[[ -d "$XRAY_DIR/.git" ]] || die "no checkout — run scripts/bootstrap-xray.sh first"

shopt -s nullglob
PATCHES=("$PATCH_DIR"/*.patch)
shopt -u nullglob
[[ ${#PATCHES[@]} -gt 0 ]] || die "no patches to rebase"

info "fetching $NEW"
git -C "$XRAY_DIR" fetch --quiet origin "$NEW" 2>/dev/null \
  || git -C "$XRAY_DIR" fetch --quiet --tags origin \
  || die "fetch failed"

# Accept a tag or short sha; normalise to a full commit id.
NEW_SHA="$(git -C "$XRAY_DIR" rev-parse --verify "${NEW}^{commit}" 2>/dev/null)" \
  || die "cannot resolve $NEW to a commit"
info "resolved to ${NEW_SHA:0:12}"

git -C "$XRAY_DIR" am --abort 2>/dev/null || true
git -C "$XRAY_DIR" checkout --quiet --detach "$NEW_SHA"
git -C "$XRAY_DIR" reset --quiet --hard "$NEW_SHA"
git -C "$XRAY_DIR" clean --quiet -fdx -e .xray-studio-stamp

info "replaying ${#PATCHES[@]} patches"
if ! git -C "$XRAY_DIR" -c user.name=xraystudio -c user.email=xray-studio@localhost \
       am --3way "${PATCHES[@]}"; then
  echo
  warn "conflict — the checkout is left mid-am at .build/xray-core"
  cat <<EOF

  Resolve it there:
    cd .build/xray-core
    git status                 # see the conflicted files
    \$EDITOR <files>            # fix
    git add -A && git am --continue
    # repeat until the series is applied, then come back and run:
    scripts/rebase-xray.sh --finish $NEW_SHA

  Or give up:
    cd .build/xray-core && git am --abort
EOF
  exit 1
fi

# --- success: regenerate the canonical series from the replayed commits --------
N=${#PATCHES[@]}
info "regenerating patch series from replayed commits"
rm -f "$PATCH_DIR"/*.patch
git -C "$XRAY_DIR" format-patch --quiet --no-signature --zero-commit \
    --output-directory "$PATCH_DIR" "HEAD~$N..HEAD" >/dev/null

printf '%s\n' "$NEW_SHA" > "$ROOT/xray/PIN"
info "PIN updated → ${NEW_SHA:0:12}"

# Force a re-stamp so check-pin.sh agrees.
"$ROOT/scripts/bootstrap-xray.sh" --force

ok "rebased onto ${NEW_SHA:0:12}"
cat <<EOF

Next, and do not skip this — it is what lets the UI claim the decision funnel is
ground truth rather than a reconstruction:

  go -C .build/xray-core test ./app/router/ -run TestTraceEquivalence -count=1
  go -C sidecar build ./...

Then re-check the version-sensitive behaviours in xray/README.md (leastLoad
tolerance enforcement, the burst interval clamp, RegisterDialerController's
signature) against the new tree.
EOF

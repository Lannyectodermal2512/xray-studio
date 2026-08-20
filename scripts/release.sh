#!/usr/bin/env bash
# Cut a release: scripts/release.sh <version>
#
#   scripts/release.sh 0.2.0
#   scripts/release.sh 0.2.0-beta.1
#   DRY_RUN=1 scripts/release.sh 0.2.0     # check everything, change nothing
#
# Everything downstream keys off the tag: pushing v<version> is what starts the build,
# and that build is what produces the installers. So this script's job is to make sure
# the tag is worth trusting before it exists — a tag is the one thing in the process
# that cannot be quietly corrected afterwards, because people have already downloaded
# what it pointed at.
#
# It refuses rather than warns. Every check here is something that has to be true for
# the release to mean what it says, and a warning at this point is a check nobody reads.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-}"
DRY_RUN="${DRY_RUN:-}"

die()  { printf '\033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$1"; }
info() { printf '\033[36m•\033[0m %s\n' "$1"; }

[[ -n "$VERSION" ]] || die "usage: scripts/release.sh <version>   (e.g. 0.2.0, 0.2.0-beta.1)"

# Semver without the leading v. The tag gets the v; the manifests do not, and mixing the
# two is how a tag ends up not matching the version inside the build it produced.
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] \
  || die "'$VERSION' is not a semantic version — expected 1.2.3 or 1.2.3-beta.1, with no leading v"
TAG="v$VERSION"

# ── the tag must be new ─────────────────────────────────────────────────────────────
# Checked first because it is the only failure that cannot be fixed by editing something.
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "tag $TAG already exists locally"
if git ls-remote --exit-code --tags origin "$TAG" >/dev/null 2>&1; then
  die "tag $TAG already exists on the remote — releases are immutable; pick the next version"
fi
ok "$TAG is unused"

# ── the working tree must be exactly what will be built ─────────────────────────────
BRANCH="$(git branch --show-current)"
[[ "$BRANCH" == "main" ]] || die "on '$BRANCH'; releases are cut from main"
[[ -z "$(git status --porcelain)" ]] || die "working tree is dirty — commit or stash first"

git fetch --quiet origin main
LOCAL="$(git rev-parse @)"
REMOTE="$(git rev-parse @{u} 2>/dev/null || echo "$LOCAL")"
BASE="$(git merge-base @ @{u} 2>/dev/null || echo "$LOCAL")"
[[ "$LOCAL" != "$BASE" || "$LOCAL" == "$REMOTE" ]] || die "main is behind origin — pull first"
[[ "$REMOTE" == "$BASE" ]] || die "main has diverged from origin — reconcile first"
ok "on main, clean, in step with origin"

# ── the release must have notes ─────────────────────────────────────────────────────
# Not a formality. The workflow publishes this exact section as the release body, so a
# missing one means a release whose page says nothing about what changed.
./scripts/changelog-section.sh "$VERSION" >/dev/null \
  || die "add a '## $VERSION' section to CHANGELOG.md describing what changed"
ok "CHANGELOG has notes for $VERSION"

# ── the core must be the pinned one ─────────────────────────────────────────────────
./scripts/check-pin.sh >/dev/null || die "the xray-core checkout drifted from xray/PIN — run scripts/bootstrap-xray.sh"
ok "core is PIN + the committed patch series"

# ── everything must pass ────────────────────────────────────────────────────────────
# Before the tag, not after: a tag on a red commit is a release that has to be retracted.
info "running tests (a couple of minutes)"
./scripts/test.sh || die "tests failed — nothing was tagged"
npm --prefix app run typecheck || die "typecheck failed — nothing was tagged"
ok "tests and typecheck green"

if [[ -n "$DRY_RUN" ]]; then
  printf '\n\033[33m…\033[0m dry run: everything checks out for %s, nothing was changed\n' "$TAG"
  exit 0
fi

# ── bump, commit, tag, push ─────────────────────────────────────────────────────────
# Both manifests carry the version: app/package.json is what electron-builder stamps into
# the bundle and the artefact names, and the root one is what the repository reports.
node -e '
  const fs = require("fs")
  for (const f of ["package.json", "app/package.json"]) {
    const j = JSON.parse(fs.readFileSync(f, "utf8"))
    j.version = process.argv[1]
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n")
  }
' "$VERSION"
ok "version set to $VERSION in package.json and app/package.json"

git add package.json app/package.json
git commit -q -m "Release $TAG"

# Annotated, with the notes in the message: an annotated tag carries an author and a
# date and can be signed, and `git show $TAG` then answers "what was in this release?"
# from a clone alone, with no network and no release page.
./scripts/changelog-section.sh "$VERSION" | git tag -a "$TAG" -F - --cleanup=whitespace
ok "tagged $TAG"

git push origin main
git push origin "$TAG"
ok "pushed"

REPO="$(git remote get-url origin | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')"
cat <<EOF

  The release workflow is now building $TAG on macOS, Windows and Linux.

    https://github.com/$REPO/actions

  When it finishes it creates a DRAFT release with the installers attached. Nothing is
  downloadable until you open it, look at the files and press Publish:

    https://github.com/$REPO/releases

EOF

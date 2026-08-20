#!/usr/bin/env bash
# Print the CHANGELOG section for one version: scripts/changelog-section.sh 0.1.0
#
# Used twice, which is the point: scripts/release.sh calls it before tagging to refuse a
# release that has no notes, and the release workflow calls it to produce the notes the
# published release actually carries. One reader means the check and the output can never
# disagree — a release cannot pass the check and then publish something else.
#
# Exits non-zero when the version has no section.
set -euo pipefail

VERSION="${1:?usage: changelog-section.sh <version>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FILE="${2:-$ROOT/CHANGELOG.md}"

awk -v want="## $VERSION" '
  $0 == want      { inside = 1; next }
  inside && /^## / { exit }
  inside          { print }
' "$FILE" | sed -e '/./,$!d' | awk '{ lines[NR] = $0 } END {
  # Trim trailing blank lines without buffering the whole file twice.
  last = NR
  while (last > 0 && lines[last] ~ /^[[:space:]]*$/) last--
  for (i = 1; i <= last; i++) print lines[i]
}' > /tmp/.changelog-section.$$

if [[ ! -s /tmp/.changelog-section.$$ ]]; then
  rm -f /tmp/.changelog-section.$$
  echo "no '## $VERSION' section in ${FILE#$ROOT/}" >&2
  exit 1
fi

cat /tmp/.changelog-section.$$
rm -f /tmp/.changelog-section.$$

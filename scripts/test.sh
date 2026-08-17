#!/usr/bin/env bash
# Run everything: pin integrity, the patched core's tests, and the sidecar's.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export GOFLAGS="${GOFLAGS:-} -mod=readonly"

fail=0
hdr()  { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '\033[31m✗\033[0m %s\n' "$1"; fail=1; }

hdr "pin integrity"
./scripts/check-pin.sh >/dev/null 2>&1 && ok "checkout is PIN + the committed series" \
                                       || bad "checkout drifted — run scripts/bootstrap-xray.sh"

hdr "patched core"
# TestChinaSites needs geoip/geosite asset files that are not in the repo. It fails
# identically on a pristine checkout, so it is excluded rather than left to look like
# a regression we introduced. Everything else in app/router IS ours to keep green.
if go -C .build/xray-core test ./app/router/ -count=1 -skip 'TestChinaSites' >/dev/null 2>&1; then
  ok "app/router (balancers, decision traces, upstream's own tests)"
else
  bad "app/router"
  go -C .build/xray-core test ./app/router/ -count=1 -skip 'TestChinaSites' 2>&1 | tail -20
fi

for pkg in ./app/observatory/... ./common/errors/ ./features/routing/...; do
  if go -C .build/xray-core test "$pkg" -count=1 >/dev/null 2>&1; then
    ok "$pkg"
  else
    bad "$pkg"
    go -C .build/xray-core test "$pkg" -count=1 2>&1 | tail -20
  fi
done

hdr "sidecar"
if go -C sidecar test ./... -count=1 -timeout 300s; then
  ok "sidecar (fault fidelity, dialer, end-to-end failover)"
else
  bad "sidecar"
fi

hdr "result"
if [[ $fail -eq 0 ]]; then
  ok "all green"
else
  bad "failures above"
fi
exit $fail

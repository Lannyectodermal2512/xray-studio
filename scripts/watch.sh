#!/usr/bin/env bash
# Run a config through the sidecar and pretty-print the telemetry.
#
# A stand-in for the dashboard until it exists. Everything here is also what the UI
# will consume, so it doubles as a way to see the event stream verbatim.
#
#   scripts/watch.sh <config.json> [--filter probe,balancer,dial,rule,log]
#   scripts/watch.sh <config.json> --fault <tag-glob>[:kind]   # inject after 5s
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONFIG="${1:-}"
[[ -n "$CONFIG" && -f "$CONFIG" ]] || {
  echo "usage: scripts/watch.sh <config.json> [--filter kinds] [--fault tag[:kind]]" >&2
  exit 1
}
shift

FILTER="probe,balancer,dial,rule,state,fault"
FAULT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --filter) FILTER="$2"; shift 2 ;;
    --fault)  FAULT="$2";  shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

[[ -x .build/bin/xray-studio-sidecar ]] || {
  printf '\033[36m•\033[0m building sidecar\n'
  ./scripts/bootstrap-xray.sh >/dev/null
  mkdir -p .build/bin
  go -C sidecar build -o "$ROOT/.build/bin/xray-studio-sidecar" ./cmd/sidecar || exit 1
}

TMP="$(mktemp -d)"
cleanup() { [[ -n "${SIDE:-}" ]] && kill "$SIDE" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

.build/bin/xray-studio-sidecar --config "$CONFIG" > "$TMP/out" 2> "$TMP/err" &
SIDE=$!

# Wait for the ready line.
for _ in $(seq 1 50); do [[ -s "$TMP/out" ]] && break; sleep 0.1; done
READY="$(head -1 "$TMP/out")"
[[ "$READY" == \{* ]] || { echo "sidecar failed to start:"; cat "$TMP/err"; exit 1; }

PORT="$(python3 -c "import json;print(json.loads(input())['port'])" <<<"$READY")"
TOKEN="$(python3 -c "import json;print(json.loads(input())['token'])" <<<"$READY")"
XV="$(python3 -c "import json;print(json.loads(input())['xray'])" <<<"$READY")"

printf '\033[32m✓\033[0m xray %s · control http://127.0.0.1:%s · config %s\n\n' "$XV" "$PORT" "$CONFIG"

if [[ -n "$FAULT" ]]; then
  TAG="${FAULT%%:*}"; KIND="${FAULT#*:}"; [[ "$KIND" == "$TAG" ]] && KIND=blackhole
  (
    sleep 5
    printf '\n\033[33m▸ injecting %s on %s\033[0m\n\n' "$KIND" "$TAG"
    curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
      -d "{\"rules\":[{\"id\":\"cli\",\"enabled\":true,\"kind\":\"$KIND\",\"tagGlob\":\"$TAG\"}]}" \
      "http://127.0.0.1:$PORT/v1/faults" >/dev/null
  ) &
fi

# Tail the core's own log alongside the structured stream.
tail -n +2 -f "$TMP/out" | sed 's/^/\x1b[90mcore \x1b[0m/' &

curl -s -N -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/v1/events" \
| FILTER="$FILTER" python3 -u -c '
import json, os, sys

want = set(os.environ["FILTER"].split(","))
C = dict(dim="\033[90m", red="\033[31m", grn="\033[32m", ylw="\033[33m",
         cyn="\033[36m", mag="\033[35m", bld="\033[1m", off="\033[0m")

def ms(ns):
    return f"{ns/1e6:.1f}ms" if ns else "-"

for line in sys.stdin:
    if not line.startswith("data: "):
        continue
    try:
        e = json.loads(line[6:])
    except Exception:
        continue
    t = e.get("type", "")
    ts = f'{C["dim"]}{e.get("mono_ns",0)/1e9:8.2f}s{C["off"]}'

    if t == "state" and "state" in want:
        print(f'{ts} {C["bld"]}state{C["off"]} {e["state"]}'
              + (f' {C["red"]}{e.get("err","")}{C["off"]}' if e.get("err") else ""))

    elif t == "probe_end" and "probe" in want:
        cls = e.get("class", "")
        col = C["grn"] if cls == "ok" else (C["ylw"] if cls == "net_down" else C["red"])
        detail = ms(e.get("rtt_ns")) if cls == "ok" else e.get("err", "")[:70]
        print(f'{ts} {col}probe{C["off"]}  {e["tag"]:<14} {cls:<9} {detail}')

    elif t == "dial" and "dial" in want:
        fk = e.get("fault_kind", "")
        col = C["red"] if fk else C["dim"]
        note = f' {C["red"]}[{fk}]{C["off"]}' if fk else ""
        err = f' {e["err"][:50]}' if e.get("err") else ""
        print(f'{ts} {col}dial{C["off"]}   {e["tag"]:<14} {e.get("origin",""):<8} '
              f'{e.get("dest","")}{note}{err}')

    elif t == "rule_match" and "rule" in want:
        idx = e.get("rule_idx", -1)
        if idx < 0:
            print(f'{ts} {C["ylw"]}rule{C["off"]}   NO MATCH -> default outbound (first in config)')
        else:
            print(f'{ts} {C["cyn"]}rule{C["off"]}   #{idx} {e.get("rule_tag","") or "-":<10} '
                  f'-> {e.get("balancer") or e.get("out_tag")}')

    elif t == "fault" and "fault" in want:
        print(f'{ts} {C["mag"]}fault{C["off"]}  {e["action"]} {e["id"]} {e.get("kind","")} {e.get("match","")}')

    elif t == "balancer_eval" and "balancer" in want:
        print(f'\n{ts} {C["bld"]}{C["mag"]}BALANCER {e["balancer_tag"]}{C["off"]} '
              f'({e["strategy"]}) -> {C["bld"]}{e["selected"] or "(none)"}{C["off"]} '
              f'{C["dim"]}via {e["source"]}, {ms(e.get("duration_ns"))}{C["off"]}')
        if e.get("err"):
            print(f'          {C["red"]}{e["err"]}{C["off"]}')
        print(f'          candidates: {", ".join(e.get("candidates") or []) or "(none)"}')
        for st in e.get("stages") or []:
            out = ", ".join(st.get("out") or []) or "(none)"
            print(f'          {C["cyn"]}{st["id"]:<13}{C["off"]} -> {out}'
                  + (f'  {C["ylw"]}[{st["note"]}]{C["off"]}' if st.get("note") else ""))
            for r in st.get("rejected") or []:
                vals = " ".join(f"{k}={v}" for k, v in (r.get("values") or {}).items())
                print(f'            {C["red"]}x{C["off"]} {r["tag"]:<12} {r["reason"]:<20} {C["dim"]}{vals}{C["off"]}')
            sc = st.get("scores") or {}
            if sc:
                ranked = " ".join(f"{k}={v/1e6:.1f}ms" for k, v in sorted(sc.items(), key=lambda kv: kv[1]))
                print(f'            {C["dim"]}scores: {ranked}{C["off"]}')
        print()

    elif t == "log" and "log" in want:
        print(f'{ts} {C["dim"]}log    [{e.get("severity","")}] {e.get("message","")[:100]}{C["off"]}')
'

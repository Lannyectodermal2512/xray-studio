#!/usr/bin/env bash
# Capture the README screenshots: scripts/screenshots.sh [config]
#
# Runs the real app against a real config and captures each tab from inside the window,
# which is the only way to get a picture of what the tool actually shows — a mock would
# be a drawing of the tool rather than the tool.
#
# The default config is examples/demo-leastload.json: four outbounds, a leastLoad
# balancer, and an observatory probing cp.cloudflare.com. It needs a working network, so
# the charts have measurements in them rather than an empty axis.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONFIG="${1:-$ROOT/examples/demo-leastload.json}"
OUT="$ROOT/docs/img"
mkdir -p "$OUT"

# mktemp names the file it creates; appending an extension to that name would point at
# something that does not exist, and the app would then fail to read it in a background
# promise with nothing to show for it.
STEPS="$(mktemp -t xraystudio-shots)"
trap 'rm -f "$STEPS"' EXIT

# Tab clicks go through the visible label rather than an index: the labels are what the
# README names, so a reordered tab bar renames a file instead of silently capturing the
# wrong panel.
# Single quotes throughout: the snippet is embedded in a JSON string, and a double
# quote in it would end that string.
tab() {
  printf "[...document.querySelectorAll('.tabs .tab')].find(t=>t.textContent.trim().startsWith('%s')).click()" "$1"
}

cat > "$STEPS" <<EOF
[
  { "file": "$OUT/observe.png",
    "js": "[...document.querySelectorAll('.doclang button')].find(b=>b.textContent.trim()==='EN').click(); $(tab Observe)",
    "delay": 1400 },
  { "file": "$OUT/funnel.png",
    "js": "[...document.querySelectorAll('.observe h3')].find(h=>h.textContent.includes('Why this outbound')).scrollIntoView({block:'start'})",
    "delay": 1200 },
  { "file": "$OUT/graph.png",
    "js": "(async()=>{ $(tab Graph); await new Promise(r=>setTimeout(r,700)); [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Fit')?.click(); [...document.querySelectorAll('svg text')].find(t=>t.textContent.trim()==='bal')?.closest('g')?.dispatchEvent(new MouseEvent('click',{bubbles:true})) })()",
    "delay": 1600 },
  { "file": "$OUT/editor.png",    "js": "$(tab Editor)",    "delay": 1400 },
  { "file": "$OUT/faults.png",
    "js": "(async()=>{ $(tab Faults); await new Promise(r=>setTimeout(r,500)); [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='proxy-a')?.click(); await new Promise(r=>setTimeout(r,300)); [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Add')?.click() })()",
    "delay": 3500 },
  { "file": "$OUT/whatif.png",    "js": "$(tab What-if)",   "delay": 1600 },
  { "file": "$OUT/selfcheck.png", "js": "$(tab Self-check)","delay": 1600 },
  { "file": "$OUT/reference.png", "js": "$(tab Reference)", "delay": 1200 },
  { "file": "$OUT/protocols.png", "js": "$(tab Protocols)", "delay": 1400 },
  { "file": "$OUT/log.png",       "js": "$(tab Log)",       "delay": 1200 }
]
EOF

printf '\033[36m•\033[0m capturing %s tabs from %s\n' "$(grep -c '"file"' "$STEPS")" "${CONFIG#$ROOT/}"

# Drive traffic through the config's own inbound while the app warms up.
#
# A balancer evaluates once per dispatched connection and not otherwise, so without
# this the decision funnel — the thing this tool exists for — photographs as "No
# balancer decisions yet." The port is read from the config rather than hardcoded, and
# a config without a socks inbound simply skips this.
PORT="$(python3 - "$CONFIG" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
for i in cfg.get("inbounds", []):
    if i.get("protocol") == "socks":
        print(i.get("port", "")); break
PY
)"
if [[ -n "$PORT" ]]; then
  (
    sleep 6
    for _ in $(seq 1 12); do
      curl -s -o /dev/null --max-time 4 \
        --socks5-hostname "127.0.0.1:$PORT" http://cp.cloudflare.com/generate_204 || true
      sleep 1
    done
  ) &
  printf '  driving traffic through socks 127.0.0.1:%s so the balancer runs\n' "$PORT"
fi

XRAYSTUDIO_CONFIG="$CONFIG" \
XRAYSTUDIO_SHOTS="$STEPS" \
XRAYSTUDIO_SHOTS_WARMUP="${WARMUP:-14000}" \
XRAYSTUDIO_TRACE="${TRACE:-/dev/null}" \
  npm --prefix app run dev

# Second pass, for the one tab a working config cannot illustrate. Validate exists to
# report configs that load and then do nothing, so photographing it against a healthy
# file produces "Nothing to report" — a true statement about the wrong config.
BROKEN="$ROOT/examples/broken-showcase.json"
if [[ -f "$BROKEN" ]]; then
  cat > "$STEPS" <<EOF
[
  { "file": "$OUT/validate.png",
    "js": "[...document.querySelectorAll('.doclang button')].find(b=>b.textContent.trim()==='EN').click(); $(tab Validate)",
    "delay": 2000 }
]
EOF
  printf '\033[36m•\033[0m capturing Validate from %s\n' "${BROKEN#$ROOT/}"
  XRAYSTUDIO_CONFIG="$BROKEN" \
  XRAYSTUDIO_SHOTS="$STEPS" \
  XRAYSTUDIO_SHOTS_WARMUP=6000 \
  XRAYSTUDIO_TRACE="${TRACE:-/dev/null}" \
    npm --prefix app run dev
fi

printf '\033[32m✓\033[0m %s\n' "$OUT"
ls -1 "$OUT"

#!/usr/bin/env bash
# Day-before (and morning-of) check for the showcase demo. READ-ONLY: it changes nothing and
# never prints a secret. Safe to run on the projector (it never shows .env contents).
#
#   showcase/demo/preflight.sh          quick checks (about 10 seconds)
#   showcase/demo/preflight.sh --live   also ask Claude and Gemini one tiny question each
#                                       (uses a little of your Claude allowance / Gemini quota)
set -uo pipefail

GHOST_DIR="$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)"
cd "$GHOST_DIR" || exit 1
LIVE=0
[ "${1:-}" = "--live" ] && LIVE=1

pass=0
warn=0
bad=0
ok() {
  echo "  [ OK ] $*"
  pass=$((pass + 1))
}
wn() {
  echo "  [WARN] $*"
  warn=$((warn + 1))
}
no() {
  echo "  [FAIL] $*"
  bad=$((bad + 1))
}
# Value of a key in .env without printing it: "set" / "empty" / "missing".
env_state() {
  local line
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=" .env 2>/dev/null | tail -n 1)" || true
  [ -z "$line" ] && {
    echo missing
    return
  }
  local v="${line#*=}"
  v="$(printf '%s' "$v" | sed -E 's/[[:space:]]+#.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//' | tr -d '\r"'"'")"
  [ -n "$v" ] && echo set || echo empty
}
env_val() { grep -E "^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=" .env 2>/dev/null | tail -n 1 | sed -E 's/^[^=]*=//; s/[[:space:]]+#.*$//' | tr -d '\r"'"'"; }

echo "Ghost-Prime showcase preflight ($(date '+%a %d %b %H:%M'))"

echo "App"
[ -d node_modules ] && ok "node_modules present" || no "node_modules missing: run 'npm install' (needs internet)"
[ -f out/main/index.js ] && ok "app is built (out/)" || wn "not built yet: bin/ghost-showcase builds it on first start (takes a minute)"
[ -x bin/ghost-showcase ] && ok "bin/ghost-showcase is executable" || no "bin/ghost-showcase missing or not executable"
# Memory/chat history (better-sqlite3) and the live terminal (node-pty) are native modules: after an
# 'npm install' they must be rebuilt for Electron, or memory and the terminal demo silently break.
if [ -x node_modules/electron/dist/electron ]; then
  if ELECTRON_RUN_AS_NODE=1 timeout 20 node_modules/electron/dist/electron -e "new (require('better-sqlite3'))(':memory:').close(); require('node-pty').spawn('/bin/true', []).kill()" >/dev/null 2>&1; then
    ok "native modules load in Electron (memory + live terminal)"
  else
    no "memory/terminal modules don't load in Electron: run 'npm run rebuild' (needs internet)"
  fi
fi
if pgrep -f "$GHOST_DIR/node_modules/electron/dist/electron \\." >/dev/null 2>&1; then
  wn "Ghost-Prime is already running: start the showcase with 'bin/ghost-showcase --restart'"
else
  ok "Ghost-Prime not running yet"
fi

echo "Settings (.env is never printed)"
if [ -f .env ]; then
  ok ".env exists"
  [ "$(env_state GEMINI_API_KEY)" = set ] && ok "Gemini key is set (speech + quick answers)" || no "GEMINI_API_KEY is not set: voice will fall back to offline Whisper/espeak"
  bm="$(env_val GHOST_BRAIN_MODE)"
  echo "         brain mode in .env: ${bm:-auto (default)}   (showcase plan: claude; see DEMO.md)"
  vp="$(env_val GHOST_VOICE_PROVIDER)"
  echo "         voice provider in .env: ${vp:-auto}   (backup: GHOST_VOICE_PROVIDER=local bin/ghost-showcase)"
  echo "         the launcher overrides: browser=playwright (built-in, tested) + isolated profile, proactive/auto-summary/Canva/Discord off"
  if [ -n "${GHOST_BROWSER_BACKEND:-}" ] && [ "$GHOST_BROWSER_BACKEND" != playwright ]; then
    wn "this terminal has GHOST_BROWSER_BACKEND=$GHOST_BROWSER_BACKEND set: open a new terminal tab before bin/ghost-showcase"
  fi
else
  no ".env is missing: the Gemini key and bridge token live there"
fi

echo "Claude (the main brain)"
command -v claude >/dev/null 2>&1 && ok "claude command installed" || wn "'claude' command not found on PATH (the app uses its login)"
[ -f "$HOME/.claude/.credentials.json" ] && ok "Claude login file present (run with --live to prove it answers)" || no "no Claude login found: run 'claude' in a terminal and log in"

echo "Internet (each should say OK on the booth network)"
for u in https://api.anthropic.com https://generativelanguage.googleapis.com https://www.wikipedia.org https://wttr.in https://example.com; do
  code="$(curl -s -o /dev/null -m 6 -w '%{http_code}' "$u" 2>/dev/null)"
  if [ -n "$code" ] && [ "$code" != 000 ]; then ok "reach $u (HTTP $code)"; else no "cannot reach $u"; fi
done

echo "Sound and mic"
if arecord -l 2>/dev/null | grep -q '^card'; then ok "microphone device visible to Linux"; else no "no microphone: ChromeOS Settings > Developers > Linux > allow microphone"; fi
vol="$(pactl get-sink-volume @DEFAULT_SINK@ 2>/dev/null | grep -oE '[0-9]+%' | head -1)"
mute="$(pactl get-sink-mute @DEFAULT_SINK@ 2>/dev/null | grep -oiE 'yes|no')"
[ -n "$vol" ] && echo "         Linux speaker volume: $vol, muted: ${mute:-?}   (also turn ChromeOS volume up)"
[ "${mute:-no}" = yes ] && wn "Linux audio is muted: pactl set-sink-mute @DEFAULT_SINK@ 0"
command -v espeak-ng >/dev/null 2>&1 && ok "espeak-ng installed (offline voice)" || wn "espeak-ng missing: no offline voice backup"
[ -d vendor/transformers-cache/Xenova/whisper-tiny.en ] && ok "offline Whisper model cached" || wn "offline Whisper model not cached: offline voice input will download it (needs internet)"

echo "Power and memory"
if [ -r /sys/class/power_supply/battery/capacity ]; then
  cap="$(cat /sys/class/power_supply/battery/capacity)"
  st="$(cat /sys/class/power_supply/battery/status 2>/dev/null)"
  if [ "$cap" -ge 80 ] || { [ "$cap" -ge 50 ] && { [ "$st" = Charging ] || [ "$st" = Full ]; }; }; then ok "battery $cap% ($st)"; else wn "battery only $cap% ($st): charge it fully and bring the charger"; fi
fi
avail="$(free -m | awk '/^Mem:/ {print $7}')"
if [ "${avail:-0}" -ge 1500 ]; then ok "free memory ${avail} MB"; else wn "only ${avail} MB free memory: close other apps/tabs before the demo"; fi

echo "Offline replay (Plan C)"
[ -f src/renderer/dev/showcase-scenarios.js ] && ok "replay scenarios present" || no "src/renderer/dev/showcase-scenarios.js missing"
curl -s -o /dev/null -m 1 http://127.0.0.1:5199/ && ok "preview server already running (showcase/demo/replay.sh opens it)" || echo "         preview server not running (showcase/demo/replay.sh starts it when needed)"

if [ "$LIVE" = 1 ]; then
  echo "Live AI checks"
  if out="$(timeout 90 node scripts/smoke-claude-agent.mjs 2>&1)" && grep -q -- "--- claude-agent OK" <<<"$out"; then ok "Claude answered (GHOST ONLINE)"; else no "Claude did not answer: log in with 'claude', or check the internet"; fi
  if out="$(timeout 90 node --import ./scripts/lib/register-electron-stub.mjs scripts/smoke-gemini-agent.mjs 2>&1)" && grep -q '^SUCCESS' <<<"$out"; then
    ok "Gemini answered with a tool call"
  else
    wn "Gemini check failed (quota/rate limit?): use GHOST_VOICE_PROVIDER=local for voice"
  fi
fi

echo
echo "Result: $pass OK, $warn warnings, $bad problems"
[ "$bad" -eq 0 ]

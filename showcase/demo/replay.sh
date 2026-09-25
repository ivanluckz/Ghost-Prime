#!/usr/bin/env bash
# OFFLINE REPLAY: the real Ghost-Prime interface playing the rehearsed demos from a script, for
# when the Wi-Fi or Claude fails at the booth. Needs NO internet: fonts, three.js and the replay
# script are all local. (Only the mic needs internet in replay, so type instead.)
#
#   showcase/demo/replay.sh           open the replay in ChromeOS Chrome (it has offline voices)
#   showcase/demo/replay.sh --linux   open it in the Linux Chrome as an app window instead
#   showcase/demo/replay.sh --quiet   same, but don't read every answer aloud (adds &speak=0)
#   showcase/demo/replay.sh --small   normal-size text instead of presenter mode (big text, AUTO),
#                                     which is what bin/ghost-showcase shows in the live app
#
# If the preview server isn't running, this starts it and keeps it in THIS terminal:
# Ctrl+C here stops it. Say out loud that it's a replay (DEMO.md, "Plan C").
set -uo pipefail

GHOST_DIR="$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)"
PORT="${DESIGN_PORT:-5199}"
WHERE=chromeos
EXTRA=""
PRESENTER="&showcase=1"
for a in "$@"; do
  case "$a" in
    --linux) WHERE=linux ;;
    --quiet) EXTRA="&speak=0" ;;
    --small) PRESENTER="" ;;
    -h | --help)
      sed -n '2,13p' "$0"
      exit 0
      ;;
    *)
      echo "usage: replay.sh [--linux] [--quiet] [--small]" >&2
      exit 2
      ;;
  esac
done
QUERY="?skipIntro=1&replay=1$EXTRA$PRESENTER"

up() { curl -s -o /dev/null -m 1 "http://127.0.0.1:$PORT/"; }

open_url() {
  if [ "$WHERE" = linux ] && command -v google-chrome >/dev/null 2>&1; then
    # Own profile, so it never clashes with a Chrome that is already open. F11 = full screen.
    google-chrome --app="http://127.0.0.1:$PORT/$QUERY" --user-data-dir="$HOME/.config/ghost-prime/replay-profile" \
      --no-first-run --window-size=1366,768 >/dev/null 2>&1 &
  elif command -v garcon-url-handler >/dev/null 2>&1; then
    garcon-url-handler "http://localhost:$PORT/$QUERY" # opens a tab in ChromeOS Chrome
  else
    xdg-open "http://localhost:$PORT/$QUERY" >/dev/null 2>&1 &
  fi
  echo
  echo "Replay opened. If no window appeared, type this into Chrome:"
  echo "    http://localhost:$PORT/$QUERY"
  echo "Then press the full-screen key (or F11). The small 'Offline replay' badge stays on screen."
}

if up; then
  echo "Preview server already running on port $PORT."
  open_url
  exit 0
fi

cd "$GHOST_DIR" || exit 1
[ -x node_modules/.bin/vite ] || {
  echo "node_modules is missing. Run 'npm install' in $GHOST_DIR first (needs internet once)." >&2
  exit 1
}
echo "Starting the preview server on port $PORT (Ctrl+C here stops it)…"
(
  for _ in $(seq 1 80); do
    up && break
    sleep 0.5
  done
  if up; then open_url; else echo "The preview server did not start. Check the messages above." >&2; fi
) &
DESIGN_PORT="$PORT" exec ./node_modules/.bin/vite --config design.vite.config.mjs

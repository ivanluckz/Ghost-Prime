#!/usr/bin/env bash
# Run every OFFLINE test: no internet, no API keys, no Claude login, no microphone. Browser tests use
# Playwright's bundled Chromium, headless, with throwaway profiles. Takes a few minutes.
#
#   scripts/run-offline-tests.sh            all suites
#   scripts/run-offline-tests.sh browser    only suites whose name contains "browser"
#
# Not included (they need something this script must not assume):
#   - the database suites under Electron: npm run smoke:db / smoke:summary / smoke:persistence
#     (or scripts/electron-db-smokes.sh on a machine where the Electron rebuild can't run)
#   - the live AI checks: smoke-claude-agent*, smoke-gemini-agent, smoke-gemini-browser-vision,
#     smoke-openrouter (they spend a little Claude allowance / Gemini quota), and smoke-tools
#     (opens example.com). showcase/demo/preflight.sh --live runs the two that matter.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1
ONLY="${1:-}"
LOGS="$(mktemp -d "${TMPDIR:-/tmp}/ghost-tests-XXXXXX")"
export GHOST_BROWSER_HEADLESS=1 GHOST_BROWSER_CHANNEL= GHOST_BROWSER_BACKEND=playwright
E="--import ./scripts/lib/register-electron-stub.mjs"
S="--import ./scripts/lib/register-sdk-stub.mjs"
O="--import ./scripts/lib/register-offline-stubs.mjs"

# name | node flags | script
SUITES=(
  "markdown||smoke-markdown.mjs"
  "friendly-errors||smoke-friendly-errors.mjs"
  "claude-prompt|$E|smoke-claude-prompt.mjs"
  "plan-mode|$S|smoke-plan-mode.mjs"
  "claude-retry|$S|smoke-claude-retry.mjs"
  "claude-stop|$S|smoke-claude-stop.mjs"
  "gemini-loop|$O|smoke-gemini-loop.mjs"
  "brain-router|$E|smoke-brain-router.mjs"
  "run-slot|$E|smoke-run-slot.mjs"
  "env-bool|$E|smoke-env-bool.mjs"
  "attachment-cap||smoke-attachment-cap.mjs"
  "proactive||smoke-proactive.mjs"
  "reminders|$O|smoke-reminders.mjs"
  "voice|$E|smoke-voice.mjs"
  "weather|$E|smoke-weather.mjs"
  "jarvis-fixes|$E|smoke-jarvis-fixes.mjs"
  "web-search||smoke-web-search.mjs"
  "terminal|$E|smoke-terminal.mjs"
  "shell-rc||smoke-shell-rc.mjs"
  "file-undo|$E|smoke-file-undo.mjs"
  "site-policy|$E|smoke-site-policy.mjs"
  "site-gaps|$O|smoke-site-gaps.mjs"
  "browser-control||smoke-browser-control.mjs"
  "browser-click||smoke-browser-click.mjs"
  "browser-backend|$E|smoke-browser-backend.mjs"
  "browser-fallback|$E|smoke-browser-fallback.mjs"
  "browser-refs|$E|smoke-browser-refs.mjs"
  "browser-crash|$E|smoke-browser-crash.mjs"
  "browser-download|$E|smoke-browser-download.mjs"
  "phone-tools|$E|smoke-phone-tools.mjs"
  "extension-e2e|$E|smoke-extension-e2e.mjs"
  "bridge||smoke-bridge.mjs"
  "bridge-e2e||bridge-smoke.mjs"
)

suites=0
bad=0
checks=0
for row in "${SUITES[@]}"; do
  IFS='|' read -r name flags file <<<"$row"
  [ -n "$ONLY" ] && [[ "$name" != *"$ONLY"* ]] && continue
  profile="$(mktemp -d "$LOGS/profile-XXXX")"
  # shellcheck disable=SC2086
  GHOST_BROWSER_PROFILE="$profile" timeout 600 node $flags "scripts/$file" >"$LOGS/$name.log" 2>&1
  code=$?
  # Suites report "N passed", "…: N checks passed", or one "✓ / ok / PASS" line per check.
  n="$(grep -aoE '(^|: )[0-9]+ (checks )?passed' "$LOGS/$name.log" | tail -1 | grep -oE '[0-9]+')"
  [ -z "$n" ] && n="$(grep -acE '^(✓|ok |PASS )' "$LOGS/$name.log")"
  suites=$((suites + 1))
  checks=$((checks + ${n:-0}))
  if [ "$code" -eq 0 ]; then
    printf '  [ OK ] %-18s %s checks\n' "$name" "${n:-?}"
  else
    bad=$((bad + 1))
    printf '  [FAIL] %-18s exit %s — last lines:\n' "$name" "$code"
    grep -avE 'ExperimentalWarning|MODULE_TYPELESS|Reparsing|type": "module|trace-warnings|punycode|trace-deprecation' "$LOGS/$name.log" | tail -8 | sed 's/^/           /'
  fi
done
echo
echo "$suites suites, $checks checks, $bad failed. Logs: $LOGS"
[ "$bad" -eq 0 ]

#!/usr/bin/env bash
# Run the Electron-only DB smokes (smoke-db, smoke-summary, smoke-persistence) WITHOUT rebuilding the
# repo's better-sqlite3: for machines where electron-rebuild can't run (e.g. a cloud container that
# can't download Electron's headers). It copies better-sqlite3 into a scratch dir, drops in the
# official Electron prebuilt from the better-sqlite3 GitHub release, and runs each smoke there under
# Electron (inside xvfb-run when there is no display). The repo's node_modules is never modified.
# On the Chromebook just use: npm run smoke:db / smoke:summary / smoke:persistence
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ELECTRON="$ROOT/node_modules/electron/dist/electron"
V=$(node -p "require('$ROOT/node_modules/better-sqlite3/package.json').version")
ABI=$(ELECTRON_RUN_AS_NODE=1 "$ELECTRON" -p 'process.versions.modules')
W=$(mktemp -d "${TMPDIR:-/tmp}/ghost-edb-XXXXXX")
trap 'rm -rf "$W"' EXIT
mkdir -p "$W/node_modules"
for m in better-sqlite3 bindings file-uri-to-path; do [ -d "$ROOT/node_modules/$m" ] && cp -r "$ROOT/node_modules/$m" "$W/node_modules/"; done
curl -fsSL "https://github.com/WiseLibs/better-sqlite3/releases/download/v$V/better-sqlite3-v$V-electron-v$ABI-linux-x64.tar.gz" | tar xz -C "$W"
cp "$W/build/Release/better_sqlite3.node" "$W/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
(cd "$ROOT" && npx esbuild src/main/memory/db.js --bundle --platform=node --format=cjs --external:better-sqlite3 --external:electron --outfile="$W/_db_bundle.cjs" --log-level=warning)
cp "$ROOT"/scripts/smoke-{db,summary,persistence}.cjs "$W/"
ln -s "$ROOT/migrations" "$W/migrations"
RUN=()
[ -z "${DISPLAY:-}" ] && command -v xvfb-run >/dev/null && RUN=(xvfb-run -a)
fail=0
for t in smoke-db smoke-summary smoke-persistence; do
  out=$(cd "$W" && "${RUN[@]}" "$ELECTRON" --no-sandbox "$t.cjs" 2>&1 | grep -vE 'bus\.cc|dbus|Fontconfig|GLib|libva|viz_main|gpu_' || true)
  if grep -q SMOKE_OK <<<"$out"; then echo "✓ $t ($(grep -c '^ok ' <<<"$out" || true) ok lines)"; else echo "✗ $t"; echo "$out" | tail -20; fail=1; fi
done
exit $fail

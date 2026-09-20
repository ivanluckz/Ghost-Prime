import dotenv from 'dotenv'
// Namespace import on purpose: under plain Node the `electron` package is a CJS module whose only
// export is the binary's path, so `import { app } from 'electron'` throws at link time and takes
// every module that imports env.js (proactive, provider, tools…) down with it — even in smoke
// scripts that never touch the app object. This way it just resolves to an object without `app`.
import * as electron from 'electron'
import { join } from 'node:path'

// Load .env from the project root. Under electron-vite dev, getAppPath() === project root.
// This module is imported FIRST by index.js: ESM evaluates every imported module before the
// importer's body, so it must run before any module reads process.env at top level (hotkey,
// proactive, provider, browser). Only inside a real Electron process — the smoke scripts load
// main-process modules under plain Node with scripts/lib/electron-stub.mjs and set up exactly the
// env they want (some `import 'dotenv/config'` themselves), so .env must not leak into them here.
if (process.versions.electron && electron.app) dotenv.config({ path: join(electron.app.getAppPath(), '.env') })

// Boolean flag parsing — the ONE spelling every GHOST_*/DISCORD_*/CLAUDE_* on/off flag accepts:
//   0 / false / off / no  → disabled        1 / true / on / yes (any other value) → enabled
// Canonical spelling in docs is 1 / 0. Keep this module free of project imports (it is loaded
// before everything else and by every module that reads a flag) to rule out import cycles.
export const parseBool = (v, def) => {
  const s = String(v ?? '').trim().toLowerCase()
  if (!s) return def
  return !['0', 'false', 'off', 'no'].includes(s)
}
// Read at call time so a late dotenv load (or a runtime `process.env` tweak) still counts.
export const envBool = (name, def) => parseBool(process.env[name], def)

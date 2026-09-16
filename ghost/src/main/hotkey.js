import { app, globalShortcut } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

// The global "wake-up" shortcut — press it from anywhere to summon Ghost-Prime and focus the input.
// The accelerator is recordable in Settings and persisted as JSON under userData, then registered
// live (no restart). GHOST_HOTKEY only sets the default/fallback now; a saved combo wins.
const DEFAULT = process.env.GHOST_HOTKEY || 'CommandOrControl+Shift+G'
let cache = null // the desired accelerator (saved or default)
let current = null // what's actually registered with the OS right now
let onTrigger = null // summon callback, set by initHotkey

function file() {
  return join(app.getPath('userData'), 'hotkey.json')
}

function load() {
  if (cache !== null) return cache
  try {
    cache = existsSync(file())
      ? JSON.parse(readFileSync(file(), 'utf8')).accelerator || DEFAULT
      : DEFAULT
  } catch {
    cache = DEFAULT
  }
  return cache
}

function persist(accelerator) {
  cache = accelerator
  try {
    writeFileSync(file(), JSON.stringify({ accelerator }, null, 2))
  } catch (e) {
    console.warn('[hotkey] could not save:', e?.message || e)
  }
}

// (Re)bind an accelerator, unregistering whatever was bound before. Returns { ok, error }.
function bind(accelerator) {
  if (current) {
    try {
      globalShortcut.unregister(current)
    } catch {}
    current = null
  }
  if (!accelerator) return { ok: false, error: 'empty shortcut' }
  try {
    const ok = globalShortcut.register(accelerator, () => onTrigger && onTrigger())
    if (!ok) return { ok: false, error: 'rejected by the OS (already in use?)' }
    current = accelerator
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
}

export function getHotkey() {
  return { accelerator: load(), default: DEFAULT }
}

// Call once at startup with the summon callback.
export function initHotkey(trigger) {
  onTrigger = trigger
  const saved = load()
  const r = bind(saved)
  if (!r.ok) {
    console.error('[hotkey] could not register', saved, '-', r.error)
    if (saved !== DEFAULT) {
      const f = bind(DEFAULT)
      if (f.ok) persist(DEFAULT)
    }
  }
  return getHotkey()
}

// Change the shortcut live. On failure, restore the previous working binding so the user is never
// left without a way to summon. Returns { ok, accelerator, default, error? }.
export function setHotkey(accelerator) {
  const prev = load()
  const r = bind(accelerator)
  if (r.ok) {
    persist(accelerator)
    return { ok: true, accelerator, default: DEFAULT }
  }
  bind(prev) // roll back to what was working
  return { ok: false, error: r.error, accelerator: prev, default: DEFAULT }
}

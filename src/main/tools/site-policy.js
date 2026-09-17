import electron from 'electron'
const app = typeof electron === 'object' && electron?.app ? electron.app : { getPath: () => '/tmp' }
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'


// Per-site permissions for the browser tools — Ghost-Prime's answer to "Claude for Chrome" site
// access. Persisted as JSON under userData and enforced both app-side (navigate / read_pages) and
// inside the extension (any action on an already-open page). Shape:
//   { mode: 'open' | 'strict', allow: [domains], block: [domains] }
//   open   — act anywhere EXCEPT blocked domains (default; nothing changes for existing users)
//   strict — act ONLY on allow-listed domains (and never on blocked ones)
const DEFAULT = { mode: 'open', allow: [], block: [] }
let cache = null

function file() {
  return join(app.getPath('userData'), 'site-policy.json')
}

function normalizeDomain(d) {
  return String(d || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '')
}

function dedupe(list) {
  return [...new Set((Array.isArray(list) ? list : []).map(normalizeDomain).filter(Boolean))]
}

function load() {
  if (cache) return cache
  try {
    cache = existsSync(file()) ? { ...DEFAULT, ...JSON.parse(readFileSync(file(), 'utf8')) } : { ...DEFAULT }
  } catch {
    cache = { ...DEFAULT }
  }
  cache.mode = cache.mode === 'strict' ? 'strict' : 'open'
  cache.allow = dedupe(cache.allow)
  cache.block = dedupe(cache.block)
  return cache
}

export function getPolicy() {
  return { ...load() }
}

export function setPolicy(patch = {}) {
  const cur = load()
  cache = {
    mode: patch.mode === 'strict' ? 'strict' : patch.mode === 'open' ? 'open' : cur.mode,
    allow: dedupe(patch.allow ?? cur.allow),
    block: dedupe(patch.block ?? cur.block)
  }
  try {
    writeFileSync(file(), JSON.stringify(cache, null, 2))
  } catch (e) {
    console.warn('[site-policy] could not save:', e?.message || e)
  }
  return { ...cache }
}

// The compact policy sent to the extension alongside every browser command.
export function policySnapshot() {
  const p = load()
  return { mode: p.mode, allow: p.allow, block: p.block }
}

function hostMatches(host, pattern) {
  if (!host || !pattern) return false
  host = host.toLowerCase().replace(/^www\./, '')
  let p = String(pattern).toLowerCase().trim().replace(/^www\./, '')
  if (p.startsWith('*.')) p = p.slice(2)
  if (!p) return false
  return host === p || host.endsWith('.' + p)
}

// Decide whether the agent may act on a URL. Non-web schemes (about:, file:, chrome:) aren't gated.
export function checkUrl(url) {
  const p = load()
  let host
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: true }
    host = u.hostname
  } catch {
    return { ok: true }
  }
  if (p.block.some((pat) => hostMatches(host, pat))) {
    return { ok: false, reason: `${host} is on your blocked-sites list. Remove it in Settings → Site access to act there.` }
  }
  if (p.mode === 'strict' && !p.allow.some((pat) => hostMatches(host, pat))) {
    return {
      ok: false,
      reason: `Site access is in strict mode and ${host} isn't on your allow-list. Add it in Settings → Site access to act there.`
    }
  }
  return { ok: true }
}

// If the configured browser (default: the Chromebook's Linux Google Chrome, channel "chrome") can't be
// found, the Playwright backend must fall back to Playwright's bundled Chromium instead of failing
// the whole web demo. Needs NO Google Chrome installed to exercise the fallback (true in CI/cloud).
// Local page only, no internet, no LLM.
// Run: GHOST_BROWSER_HEADLESS=1 node --import ./scripts/lib/register-electron-stub.mjs scripts/smoke-browser-fallback.mjs
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

delete process.env.GHOST_BROWSER_CHANNEL // default channel = 'chrome'
process.env.GHOST_BROWSER_BACKEND = 'playwright'
process.env.GHOST_BROWSER_HEADLESS = process.env.GHOST_BROWSER_HEADLESS || '1'
const profile = mkdtempSync(join(tmpdir(), 'ghost-fallback-profile-'))
process.env.GHOST_BROWSER_PROFILE = profile

let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && extra ? `  → ${String(extra).slice(0, 400)}` : ''}`)
}
const hasChrome = existsSync('/opt/google/chrome/chrome') || existsSync('/usr/bin/google-chrome')
if (hasChrome) console.log('(Google Chrome is installed here, so this run only checks that the normal path still works)')

const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html')
  res.end('<title>Fallback OK</title><h1>Photosynthesis</h1><input placeholder="Search Wikipedia">')
}).listen(0, '127.0.0.1')
await new Promise((r) => server.once('listening', r))
const url = `http://127.0.0.1:${server.address().port}/`

const b = await import('../src/main/tools/browser.js')
try {
  const r = await b.browserNavigate({ url })
  check(r?.ok && r.title === 'Fallback OK', 'browser_navigate works although channel "chrome" is not installed', JSON.stringify(r))
  const pg = await b.browserGetPage?.({})
  check(!pg || /Search Wikipedia/.test(JSON.stringify(pg)), 'the page can be read after the fallback', JSON.stringify(pg).slice(0, 200))
} catch (e) {
  check(false, 'browser_navigate works although channel "chrome" is not installed', e?.message || e)
} finally {
  await b.browserClose?.().catch?.(() => {})
  server.close()
  rmSync(profile, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

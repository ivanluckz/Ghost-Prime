// A crashed tab ("Aw, Snap!", e.g. the renderer killed for memory on a 4 GB Chromebook) used to be
// reused forever: every later browser tool failed ("Page crashed", "Target crashed", an empty page)
// until someone closed the tab by hand. Now the next action gets a fresh tab and is told why.
// Local page, bundled Chromium, no internet, no LLM.
// Run: GHOST_BROWSER_HEADLESS=1 node --import ./scripts/lib/register-electron-stub.mjs scripts/smoke-browser-crash.mjs
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.GHOST_BROWSER_BACKEND = 'playwright'
process.env.GHOST_BROWSER_HEADLESS ??= '1'
process.env.GHOST_BROWSER_CHANNEL ??= ''
const profile = mkdtempSync(join(tmpdir(), 'ghost-crash-profile-'))
process.env.GHOST_BROWSER_PROFILE = profile

let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && extra ? `  → ${String(extra).slice(0, 300)}` : ''}`)
}
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html')
  res.end('<title>Photosynthesis</title><h1>Photosynthesis</h1><button>Read more</button>')
}).listen(0, '127.0.0.1')
await new Promise((r) => server.once('listening', r))
const url = `http://127.0.0.1:${server.address().port}/`

const b = await import('../src/main/tools/browser.js')
try {
  await b.browserNavigate({ url })
  await b.browserNavigate({ url: 'chrome://crash' }).catch(() => {}) // kill the tab's renderer
  await new Promise((r) => setTimeout(r, 500))
  const r1 = await b.browserNavigate({ url }).catch((e) => ({ error: e.message }))
  check(!r1.error && r1.title === 'Photosynthesis', 'after a crash, the next navigate works (fresh tab)', JSON.stringify(r1))
  const said = b.describeEvents(r1.events || []).join(' ')
  check(/crash/i.test(said), 'the model is told the old tab crashed', said || JSON.stringify(r1.events))
  const pg = await b.browserGetPage({}).catch((e) => ({ error: e.message }))
  check(!pg.error && pg.buttons?.some((x) => x.label === 'Read more'), 'the page can be read again', JSON.stringify(pg).slice(0, 200))
  const shot = await b.browserScreenshot({}).catch((e) => ({ error: e.message }))
  check(!shot.error && shot.base64?.length > 100, 'screenshots work again', shot.error)
} catch (e) {
  check(false, 'no unexpected error', e?.stack || e)
} finally {
  await b.browserClose?.().catch(() => {})
  server.close()
  rmSync(profile, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

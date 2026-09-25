// Downloads through the browser (found 25 Sep): opening a file link directly threw Playwright's raw
// "page.goto: Download is starting" plus a colour-coded call log, although the file WAS saved, so
// the model told the user it failed. A download that took more than a moment was missing from the
// click's result. Local pages, bundled Chromium, HOME is a temp folder.
// Run: GHOST_BROWSER_HEADLESS=1 node --import ./scripts/lib/register-electron-stub.mjs scripts/smoke-browser-download.mjs
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'ghost-dl-home-'))
process.env.HOME = home
process.env.GHOST_BROWSER_BACKEND = 'playwright'
process.env.GHOST_BROWSER_HEADLESS ??= '1'
process.env.GHOST_BROWSER_CHANNEL ??= ''
process.env.GHOST_BROWSER_PROFILE = join(home, 'profile')

let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && extra ? `  → ${String(extra).slice(0, 300)}` : ''}`)
}
const server = createServer((req, res) => {
  if (req.url === '/notes.csv') {
    res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="notes.csv"' })
    return res.end('a,b\n1,2\n')
  }
  if (req.url === '/slow.csv') {
    res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="slow.csv"' })
    res.write('a,b\n')
    return setTimeout(() => res.end('1,2\n'), 1500)
  }
  res.setHeader('content-type', 'text/html')
  res.end('<title>Files</title><a href="/slow.csv">Slow CSV</a>')
}).listen(0, '127.0.0.1')
await new Promise((r) => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}`

const b = await import('../src/main/tools/browser.js')
try {
  await b.browserNavigate({ url: `${base}/` })
  const r1 = await b.browserNavigate({ url: `${base}/notes.csv` }).catch((e) => ({ error: e.message }))
  check(!r1.error, 'opening a file link directly is not reported as an error', r1.error)
  const said1 = b.describeEvents(r1.events || []).join(' ')
  check(/Download saved to .*notes\.csv/.test(said1) && existsSync(join(home, 'Downloads', 'notes.csv')), 'the result says where the file was saved', said1 || JSON.stringify(r1))
  const r2 = await b.browserClick({ text: 'Slow CSV' }).catch((e) => ({ error: e.message }))
  const said2 = b.describeEvents(r2.events || []).join(' ')
  check(!r2.error && /Download saved to .*slow\.csv/.test(said2), 'a download that takes 1.5 s is in the click result', said2 || JSON.stringify(r2))
  const bad = await b.browserNavigate({ url: 'http://127.0.0.1:1/' }).catch((e) => ({ error: e.message }))
  check(!!bad.error && !/\x1b\[|Call log/.test(bad.error), 'browser errors reach the model without colour codes or call logs', JSON.stringify(bad.error))
} catch (e) {
  check(false, 'no unexpected error', e?.stack || e)
} finally {
  await b.browserClose?.().catch(() => {})
  server.close()
  rmSync(home, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

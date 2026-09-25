// Two demo-breaking browser bugs (Demo 5 is a Wikipedia search):
//  1. Element numbers were re-assigned by every snapshot, and browser_get_page (40 per kind) and an
//     annotated screenshot (60 per kind) numbered differently. A number read from one and used after
//     the other hit a DIFFERENT element: "fill [42]" clicked the 41st link instead.
//  2. On a slow server, fill + pressEnter pressed Enter a SECOND time (double submit), and a click
//     whose page took more than 12 s was reported as "not found", so the model clicked again.
// Local pages, bundled Chromium, no internet, no LLM. About 40 s (it waits on slow pages on purpose).
// Run: GHOST_BROWSER_HEADLESS=1 node --import ./scripts/lib/register-electron-stub.mjs scripts/smoke-browser-refs.mjs
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.GHOST_BROWSER_BACKEND = 'playwright'
process.env.GHOST_BROWSER_HEADLESS ??= '1'
process.env.GHOST_BROWSER_CHANNEL ??= ''
const profile = mkdtempSync(join(tmpdir(), 'ghost-refs-profile-'))
process.env.GHOST_BROWSER_PROFILE = profile

let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && extra ? `  → ${String(extra).slice(0, 300)}` : ''}`)
}

const hits = []
const links = Array.from({ length: 55 }, (_, i) => `<a href="/wiki/Article_${i + 1}">Article ${i + 1}</a>`).join(' ')
const page = (body) => `<!doctype html><title>T</title><body>${body}</body>`
const server = createServer((req, res) => {
  hits.push(`${req.method} ${req.url.split('?')[0]}`)
  res.setHeader('content-type', 'text/html')
  if (req.url === '/') return res.end(page(`<button>Menu</button> ${links} <form method="get" action="/search"><input name="q" placeholder="Search Wikipedia"></form>`))
  if (req.url === '/slowform') return res.end(page('<form method="post" action="/slowpost"><input name="q" placeholder="Search Wikipedia"></form>'))
  if (req.url === '/slowpost') return setTimeout(() => res.end(page('<h1>Results</h1>')), 5000)
  if (req.url === '/slowlink') return res.end(page('<a href="/veryslow">slow link</a>'))
  if (req.url === '/veryslow') return setTimeout(() => res.end(page('<h1>Finally</h1>')), 14000)
  return res.end(page(`<h1>${req.url}</h1>`))
}).listen(0, '127.0.0.1')
await new Promise((r) => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}`

const b = await import('../src/main/tools/browser.js')
const count = (what) => hits.filter((h) => h === what).length
try {
  // ---- 1. numbers stay the same element across get_page and an annotated screenshot -------------
  await b.browserNavigate({ url: `${base}/` })
  const snap = await b.browserGetPage({})
  const field = snap.fields.find((f) => /Search Wikipedia/.test(f.label))
  check(!!field, 'get_page lists the search field', JSON.stringify(snap.fields))
  const shot = await b.browserScreenshot({ annotate: true })
  const again = await b.browserGetPage({})
  const field2 = again.fields.find((f) => /Search Wikipedia/.test(f.label))
  check(field2 && field && field2.ref === field.ref, 'the search field keeps its number after an annotated screenshot', `${field?.ref} → ${field2?.ref}`)
  const mark = (shot?.marks || []).find((m) => m.ref === field?.ref)
  check(!!mark && /Search Wikipedia/.test(mark.label), "the screenshot shows the field under the same number", JSON.stringify(mark))
  const before = await b.browserGetPage({})
  const r1 = await b.browserFill({ ref: field.ref, value: 'photosynthesis' }).catch((e) => ({ error: e.message }))
  check(!r1.error && /\/$/.test(r1.url || ''), 'fill with the number from get_page fills the field (no navigation)', JSON.stringify(r1))
  const val = await b.browserGetPage({})
  check(val.fields.find((f) => f.ref === field.ref)?.value === 'photosynthesis', 'the field holds the typed text', JSON.stringify(val.fields))
  const link = before.links[3]
  const r2 = await b.browserFill({ ref: link.ref, value: 'x' }).catch((e) => ({ error: e.message }))
  check(!!r2.error && /link|not a (text )?field/i.test(r2.error) && /\/$/.test((await b.browserGetPage({})).url), 'fill on a link refuses instead of clicking it', JSON.stringify(r2))
  // A number from before a page change must not hit an element on the new page.
  await b.browserNavigate({ url: `${base}/other` })
  await b.browserNavigate({ url: `${base}/` })
  const r3 = await b.browserClick({ ref: link.ref }).catch((e) => ({ error: e.message }))
  check(!!r3.error && /no longer on the page|Unknown element ref|browser_get_page/i.test(r3.error), 'an old number from a previous page is refused', JSON.stringify(r3))

  // ---- 2. slow pages: one submit, and a slow click is not "not found" ---------------------------
  await b.browserNavigate({ url: `${base}/slowform` })
  const t0 = Date.now()
  const r4 = await b.browserFill({ label: 'Search Wikipedia', value: 'photosynthesis', pressEnter: true }).catch((e) => ({ error: e.message }))
  check(count('POST /slowpost') === 1, 'Enter submits the form ONCE when the server takes 5 s', hits.filter((h) => /slowpost/.test(h)).join(', '))
  check(!r4.error && /\/slowpost$/.test(r4.url || '') && r4.navigated, 'fill + Enter reports the results page, not the old one', JSON.stringify({ ...r4, events: undefined }))
  console.log(`   (fill + Enter took ${((Date.now() - t0) / 1000).toFixed(1)} s)`)

  await b.browserNavigate({ url: `${base}/slowlink` })
  const r5 = await b.browserClick({ text: 'slow link' }).catch((e) => ({ error: e.message }))
  check(!r5.error, 'a link whose page takes 14 s is not reported as "not found"', r5.error)
  check(count('GET /veryslow') === 1, 'the slow link was requested once', hits.filter((h) => /veryslow/.test(h)).join(', '))
} catch (e) {
  check(false, 'no unexpected error', e?.stack || e)
} finally {
  await b.browserClose?.().catch(() => {})
  server.close()
  rmSync(profile, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

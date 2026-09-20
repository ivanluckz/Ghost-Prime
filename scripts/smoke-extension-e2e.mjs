// Verify the Chrome-EXTENSION backend end to end in a real (headless) Chromium: the unpacked
// extension/ is loaded into a throwaway profile, connects to the app-side bridge on a PRIVATE port
// (never 8731 — the user's real Chrome would attach to that), and browser.js drives it exactly as
// the agent does. Covers: getPage refs across frames, annotated screenshots (marks drawn in-page,
// legend + refs, overlay removed), click/fill by ref, JS dialog handling (accept / dismiss / prompt
// / alert reported in the result), waitForNavigation's navigated flag, CDP typing, and the poll
// watchdog on a tab wedged by a load-time alert.
// Run: node --import ./scripts/lib/register-electron-stub.mjs scripts/smoke-extension-e2e.mjs
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const PORT = Number(process.env.GHOST_EXT_TEST_PORT || 8797)
process.env.GHOST_BRIDGE_PORT = String(PORT)
process.env.GHOST_BROWSER_BACKEND = 'extension'
process.env.GHOST_BROWSER_AUTOLAUNCH = 'false'
process.env.GHOST_BROWSER_DIALOGS ??= 'accept'
process.env.GHOST_PAGE_CONTEXT = 'off'

const bridge = await import('../src/main/tools/browser-bridge.js')
const browser = await import('../src/main/tools/browser.js')

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  console.log((ok ? '✅ ' : '❌ ') + name + (extra ? ` — ${extra}` : ''))
  ok ? pass++ : fail++
}

// ---- tiny local site ----
const pages = {
  '/': `<!doctype html><title>Home</title><body>
    <nav><a href="/about" id="about">About us</a></nav>
    <button style="width:0;height:0;padding:0;border:0;overflow:hidden" onclick="document.title='WRONG:hidden'">Save</button>
    <button id="save" onclick="document.title='CLICKED:save'">Save</button>
    <button onclick="document.title='CONFIRMED:'+confirm('Delete this item?')">Delete</button>
    <button onclick="document.title='P:'+prompt('Your name?','bob')">Ask name</button>
    <button onclick="alert('Saved!');document.title='ALERTED'">Notify</button>
    <label>Email <input name="email" placeholder="you@example.com"></label>
    <iframe srcdoc="<button onclick='parent.document.title=&quot;CLICKED:iframe&quot;'>Embedded Action</button>"></iframe>
    <p style="margin-top:2000px">Far below the fold: <a href="/about">Off-screen link</a></p>
  </body>`,
  '/about': `<!doctype html><title>About</title><body><h1>About page</h1><a href="/">Home</a></body>`,
  '/boot-alert': `<!doctype html><title>Boot</title><body><script>alert('boot')</script><p>after</p><button onclick="document.title='CLICKED:after'">After</button></body>`
}
const server = createServer((req, res) => {
  const body = pages[req.url]
  if (body == null) return res.writeHead(404).end('nope')
  res.setHeader('Content-Type', 'text/html')
  res.end(body)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`

// ---- bridge + a real Chromium with the extension ----
bridge.startBridge()
const profile = mkdtempSync(join(tmpdir(), 'ghost-ext-e2e-'))
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
})
let sw = context.serviceWorkers()[0]
if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 })
const extId = new URL(sw.url()).host

// Point this (fresh-profile) extension at the private port: its options are in storage.sync, and
// the worker reloads cfg on storage changes. The options page is an extension page, so it has
// chrome.storage; close it again so the working tab is the active one.
const opts = await context.newPage()
await opts.goto(`chrome-extension://${extId}/options.html`)
await opts.evaluate((port) => chrome.storage.sync.set({ port }), PORT)
await opts.close()
for (let i = 0; i < 60 && !bridge.bridgeConnected(); i++) await sleep(250)
check('extension connected to the bridge on the private port', bridge.bridgeConnected())

const page = context.pages()[0]
const title = async () => (await browser.browserGetText()).title
const refOf = (snap, label) => {
  for (const k of ['buttons', 'links', 'fields', 'selects']) {
    const hit = (snap[k] || []).find((it) => it.label === label)
    if (hit) return hit.ref
  }
  return null
}

try {
  // 1. navigate + getPage refs (main frame and iframe, one numbering)
  const nav = await browser.browserNavigate({ url: BASE + '/' })
  check('navigate returns url/title', nav.url === BASE + '/' && nav.title === 'Home', JSON.stringify({ url: nav.url, title: nav.title }))
  let snap = await browser.browserGetPage()
  check('getPage numbers elements', refOf(snap, 'Save') != null && /\[\d+\] "Save"/.test(snap.formatted))
  check('getPage reaches the iframe button', refOf(snap, 'Embedded Action') != null)
  check('getPage skips the hidden zero-size Save', snap.buttons.filter((b) => b.label === 'Save').length === 1)

  // 2. click / fill by ref
  await browser.browserClick({ ref: refOf(snap, 'Save') })
  check('click { ref } hits the visible Save', (await title()) === 'CLICKED:save')
  await browser.browserClick({ ref: refOf(snap, 'Embedded Action') })
  check('click { ref } inside the iframe', (await title()) === 'CLICKED:iframe')
  await browser.browserFill({ ref: refOf(snap, 'you@example.com'), value: 'a@b.c' })
  check('fill { ref }', (await page.inputValue('input[name=email]')) === 'a@b.c')

  // 3. annotated screenshot: marks drawn in-page, legend, refs usable, overlay removed
  const plain = await browser.browserScreenshot({})
  const shot = await browser.browserScreenshot({ annotate: true })
  check('annotated screenshot returns marks + legend', shot.marks?.length >= 5 && /\[\d+\] Save/.test(browser.formatMarks(shot.marks)), browser.formatMarks(shot.marks))
  check('annotated image differs from the plain one (marks were drawn)', shot.base64.length > 5000 && shot.base64 !== plain.base64)
  check('iframe element is marked (same-origin frame offset)', shot.marks.some((m) => m.label === 'Embedded Action'))
  check('off-screen link is numbered but not drawn', !shot.marks.some((m) => m.label === 'Off-screen link'))
  check('overlay removed after capture', (await page.evaluate(() => !document.getElementById('__ghost_som'))) === true)
  const saveRef = shot.marks.find((m) => m.label === 'Save')?.ref
  await page.evaluate(() => (document.title = 'reset'))
  await browser.browserClick({ ref: saveRef })
  check('ref from the annotated screenshot clicks the right element', (await title()) === 'CLICKED:save')

  // 4. JS dialogs: answered per policy, reported in the result, page never wedges
  let r = await browser.browserClick({ text: 'Delete' })
  check('confirm() accepted + reported', (await title()) === 'CONFIRMED:true' && r.events?.some((e) => e.kind === 'dialog' && e.type === 'confirm' && e.action === 'accepted' && /Delete this item/.test(e.message)), JSON.stringify(r.events))
  check('formatActionResult describes the dialog', /confirm dialog appeared: "Delete this item\?" — accepted/.test(browser.formatActionResult('Clicked', r)))
  r = await bridge.sendCommand('click', { text: 'Delete', target: 'active', dialogs: 'dismiss' })
  check('confirm() dismissed under the dismiss policy', (await title()) === 'CONFIRMED:false' && r.events?.[0]?.action === 'dismissed')
  r = await browser.browserClick({ text: 'Ask name' })
  check('prompt() answered with its default', (await title()) === 'P:bob' && r.events?.[0]?.type === 'prompt')
  r = await browser.browserClick({ text: 'Notify' })
  check('alert() acknowledged', (await title()) === 'ALERTED' && r.events?.[0]?.type === 'alert' && /Saved!/.test(r.events[0].message))
  // The guard is temporary: once the action's events are collected the page (and the user, in
  // active-tab mode) gets its own alert/confirm/prompt back — no lingering hijack.
  const restored = await page.evaluate(() => ({
    guard: !!window.__ghostDialogGuard,
    native: /\[native code\]/.test(String(window.confirm)) && /\[native code\]/.test(String(window.alert)) && /\[native code\]/.test(String(window.prompt))
  }))
  check('dialog guard removed after the action (page keeps its native dialogs)', !restored.guard && restored.native, JSON.stringify(restored))

  // 5. CDP typing (debugger path) into the focused field
  await page.focus('input[name=email]')
  await browser.browserPressKey({ keys: 'Control+A' })
  await browser.browserPressKey({ text: 'typed' })
  check('pressKey types over CDP', (await page.inputValue('input[name=email]')) === 'typed', await page.inputValue('input[name=email]'))

  // 6. waitForNavigation reports navigated
  await browser.browserClick({ text: 'About us' })
  r = await browser.browserWaitForNavigation({ timeoutMs: 5000 })
  check('waitForNavigation → navigated:true after a click that loaded a page', r.navigated === true && /\/about$/.test(r.url), JSON.stringify(r))
  await sleep(3200)
  r = await browser.browserWaitForNavigation({ timeoutMs: 3000 })
  check('waitForNavigation → navigated:false when nothing happens', r.navigated === false, JSON.stringify(r))

  // 7. Watchdog: a load-time alert (no guard installed yet) wedges the renderer. Playwright would
  // auto-dismiss it, so hold it open with a no-op listener — like a real background tab where nobody
  // clicks OK. The extension must time the command out with a clear error and keep polling.
  page.on('dialog', () => {})
  const t0 = Date.now()
  let err = null
  try {
    await browser.browserNavigate({ url: BASE + '/boot-alert' })
    await browser.browserClick({ text: 'After' })
  } catch (e) {
    err = e.message
  }
  const secs = Math.round((Date.now() - t0) / 1000)
  check('wedged tab → clear timeout error (not "did not respond")', /timed out after \d+s/.test(err || '') && !/did not respond/.test(err || ''), `${secs}s: ${err}`)
  console.log('   (recovery note: ' + (/dialog open/.test(err || '') ? 'CDP closed the dialog' : 'no CDP recovery — generic guidance') + ')')
  check('extension still connected after the wedge', bridge.bridgeConnected())
  const tabs = await browser.browserListTabs()
  check('bridge still answers commands after the wedge', Array.isArray(tabs.tabs) && tabs.tabs.length > 0)
  // 8. Recovery: the error told the agent to reload — the debugger is now pinned on that tab, so the
  // load-time alert() is answered over CDP (Page.javascriptDialogOpening), the page loads, the
  // dialog is reported in the result, and the page is usable again.
  check('wedge error tells the agent to reload', /browser_reload/.test(err || ''))
  const t1 = Date.now()
  let rl = null
  try {
    rl = await browser.browserReload()
  } catch (e) {
    rl = { error: e.message }
  }
  check('reload after the wedge completes', rl && !rl.error && /\/boot-alert$/.test(rl.url) && Date.now() - t1 < 20000, JSON.stringify(rl))
  check('load-time alert answered over CDP + reported', rl?.events?.some((e) => e.kind === 'dialog' && e.type === 'alert' && e.message === 'boot' && e.action === 'accepted'), JSON.stringify(rl?.events))
  await browser.browserClick({ text: 'After' })
  check('page usable after the recovered reload', (await title()) === 'CLICKED:after', await title())
} catch (e) {
  check('unexpected error', false, e?.stack || String(e))
} finally {
  await context.close().catch(() => {})
  server.close()
  rmSync(profile, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

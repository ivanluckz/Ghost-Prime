// Verify the ref-based browser control layer end to end on the Playwright backend: numbered
// element refs (across iframes), clicking/filling/hovering by ref, stale-ref detection, annotated
// (Set-of-Mark) screenshots, click-triggered navigation settling, popup following, dialog +
// download reporting, checkbox/select/contenteditable fill, find, cross-frame wait, tab switching.
// Run: GHOST_BROWSER_HEADLESS=1 GHOST_BROWSER_CHANNEL= GHOST_BROWSER_PROFILE=/tmp/ghost-pw GHOST_BROWSER_BACKEND=playwright node scripts/smoke-browser-control.mjs
import { createServer } from 'node:http'
import { existsSync, unlinkSync } from 'node:fs'
import * as browser from '../src/main/tools/browser.js'

// A tiny local site: real navigations, a popup, a dialog and a download need http:// (data: URLs
// can't open popups or serve attachments).
const pages = {
  '/': `<!doctype html><title>Home</title><body>
    <nav><a href="/about" id="about">About us</a> <a href="/popup" target="_blank">Open popup</a></nav>
    <button style="width:0;height:0;padding:0;border:0;overflow:hidden" onclick="document.title='WRONG:hidden'">Save</button>
    <button id="save" onclick="document.title='CLICKED:save'">Save</button>
    <button aria-label="Search"><svg width="16" height="16"></svg></button>
    <button onclick="setTimeout(()=>{const d=document.createElement('p');d.id='late';d.textContent='Loaded late';document.body.appendChild(d)},400)">Load more</button>
    <button onclick="document.title = 'CONFIRMED:' + confirm('Delete this item?')">Delete</button>
    <a href="/report.txt" download="report.txt">Download report</a>
    <div class="menu"><span id="hoverme">Products</span><div class="sub"><a href="/about">Laptops</a></div></div>
    <style>.sub{display:none}.menu:hover .sub{display:block}</style>
    <form onsubmit="event.preventDefault();document.title='SUBMITTED:'+this.q.value">
      <button type="submit" style="display:none">Go</button>
      <label>Email <input name="email" type="email" placeholder="you@example.com"></label>
      <label><input type="checkbox" name="news"> Send me news</label>
      <label>Country <select name="country"><option>Germany</option><option>France</option></select></label>
      <input name="q" placeholder="Search products">
    </form>
    <div id="editor" contenteditable="true" style="border:1px solid #999;min-height:20px"></div>
    <iframe srcdoc="<button onclick='parent.document.title=&quot;CLICKED:iframe&quot;'>Embedded Action</button>"></iframe>
    <p style="margin-top:2000px">The price is <b>$42</b> for the premium plan.</p>
  </body>`,
  '/about': `<!doctype html><title>About</title><body><h1>About page</h1><a href="/">Home</a></body>`,
  '/popup': `<!doctype html><title>Popup</title><body><h1>Popup window</h1><button onclick="window.close()">Done</button></body>`,
  '/report.txt': 'quarterly numbers'
}
const server = createServer((req, res) => {
  const body = pages[req.url]
  if (body == null) return res.writeHead(404).end('nope')
  if (req.url === '/report.txt') res.setHeader('Content-Disposition', 'attachment; filename="report.txt"')
  res.setHeader('Content-Type', req.url.endsWith('.txt') ? 'text/plain' : 'text/html')
  res.end(body)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`

let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  console.log((ok ? '✅ ' : '❌ ') + name + (extra ? ` — ${extra}` : ''))
  ok ? pass++ : fail++
}
const home = () => browser.browserNavigate({ url: BASE + '/' })
const title = async () => (await browser.browserGetText()).title
const refOf = (snap, label, kind) => {
  for (const k of kind ? [kind] : ['buttons', 'links', 'fields', 'selects']) {
    const hit = snap[k].find((it) => it.label === label)
    if (hit) return hit.ref
  }
  return null
}

try {
  // 1. Bare domain gets a scheme; bad host gives a plain-English error.
  let msg = ''
  try {
    await browser.browserNavigate({ url: 'no-such-host-ghost-prime.invalid' })
  } catch (e) {
    msg = e.message
  }
  check('unreachable host → friendly error', /Couldn't load https:\/\/no-such-host/.test(msg), msg.slice(0, 80))

  // 2. Snapshot numbers elements, labels icon buttons, reads iframes, shows field state.
  await home()
  const snap = await browser.browserGetPage()
  check('snapshot assigns refs', snap.buttons.every((b) => Number.isInteger(b.ref)) && snap.buttons.length > 3)
  check('icon-only button labelled via aria-label', refOf(snap, 'Search', 'buttons') != null)
  check('iframe button included with a ref', refOf(snap, 'Embedded Action', 'buttons') != null)
  check('hidden duplicate "Save" skipped', snap.buttons.filter((b) => b.label === 'Save').length === 1)
  const email = snap.fields.find((f) => f.name === 'email')
  check('field label from <label>, not value', email && /Email/.test(email.label) && email.type === 'email')
  const news = snap.fields.find((f) => f.name === 'news')
  check('checkbox reports state', news && news.type === 'checkbox' && news.checked === false)
  const country = snap.selects[0]
  check('select reports options + selected', country && country.options.join() === 'Germany,France' && country.selected === 'Germany')
  check('formatted output shows [ref] and hint', /\[\d+\] "Save"/.test(snap.formatted) && /ref: N/.test(snap.formatted))

  // 3. Click by ref (main frame + iframe).
  let r = await browser.browserClick({ ref: refOf(snap, 'Save', 'buttons') })
  check('click by ref', (await title()) === 'CLICKED:save' && r.navigated === false)
  await browser.browserClick({ ref: refOf(snap, 'Embedded Action', 'buttons') })
  check('click by ref inside iframe', (await title()) === 'CLICKED:iframe')

  // 4. Exact-name preference: "Save" must hit the exact button, not a partial match elsewhere.
  await home()
  r = await browser.browserClick({ text: 'Save' })
  check('click by text still works', (await title()) === 'CLICKED:save')

  // 5. Fill by ref: text, checkbox, select, contenteditable; pressEnter submits.
  let s2 = await browser.browserGetPage()
  await browser.browserFill({ ref: refOf(s2, 'Email', 'fields'), value: 'me@example.com' })
  await browser.browserFill({ ref: refOf(s2, 'Send me news', 'fields'), value: 'true' })
  await browser.browserFill({ ref: refOf(s2, 'Country', 'selects'), value: 'France' })
  const ed = s2.fields.find((f) => f.selector === '#editor')
  await browser.browserFill({ ref: ed.ref, value: 'hello editor' })
  s2 = await browser.browserGetPage()
  check('fill text by ref', s2.fields.find((f) => f.name === 'email').value === 'me@example.com')
  check('fill checkbox "true" checks it', s2.fields.find((f) => f.name === 'news').checked === true)
  check('fill select by option text', s2.selects[0].selected === 'France')
  check('fill contenteditable', s2.fields.find((f) => f.selector === '#editor').value === 'hello editor')
  r = await browser.browserFill({ label: 'Search products', value: 'laptop', pressEnter: true })
  check('fill + pressEnter submits', (await title()) === 'SUBMITTED:laptop')

  // 6. Click that navigates: result says so, and the NEXT call sees the new page (no wait tool).
  await home()
  r = await browser.browserClick({ text: 'About us' })
  check('click-triggered navigation settles', r.navigated === true && /\/about$/.test(r.url) && r.title === 'About')
  check('formatActionResult flags stale refs', /page changed/.test(browser.formatActionResult('Clicked', r)))

  // 7. Stale ref after navigation → clear guidance, not a silent wrong click.
  msg = ''
  try {
    await browser.browserClick({ ref: 1 })
  } catch (e) {
    msg = e.message
  }
  check('stale ref → re-snapshot guidance', /no longer on the page|Unknown element ref/.test(msg) && /browser_get_page/.test(msg))

  // 8. Popup: target=_blank is followed; closing it returns to the opener.
  await home()
  r = await browser.browserClick({ text: 'Open popup' })
  check('popup followed', r.events.some((e) => e.kind === 'popup') && r.title === 'Popup', JSON.stringify(r.events))
  const tabs = (await browser.browserListTabs()).tabs
  check('list_tabs shows both with stable ids', tabs.length >= 2 && tabs.some((t) => t.active && t.title === 'Popup'))
  r = await browser.browserClick({ text: 'Done' })
  check('popup closed → back on opener', r.title === 'Home' && r.events.some((e) => e.kind === 'tab-closed'))

  // 9. Tab switching by id on Playwright.
  const homeTab = tabs.find((t) => t.title === 'Home')
  r = await browser.useTab(homeTab.tabId)
  check('use_tab switches page', r.pinned && r.title === 'Home')
  msg = ''
  try {
    await browser.useTab(9999)
  } catch (e) {
    msg = e.message
  }
  check('use_tab unknown id → error', /No open tab with id 9999/.test(msg))

  // 10. Dialog: confirm() is accepted and reported.
  r = await browser.browserClick({ text: 'Delete' })
  const dlg = r.events.find((e) => e.kind === 'dialog')
  check('confirm dialog accepted + reported', dlg && dlg.type === 'confirm' && /Delete this item/.test(dlg.message) && (await title()) === 'CONFIRMED:true')
  check('describeEvents renders dialog', /confirm dialog appeared/.test(browser.describeEvents(r.events).join('\n')))

  // 11. Download saved to ~/Downloads and reported.
  r = await browser.browserClick({ text: 'Download report' })
  await new Promise((res) => setTimeout(res, 800))
  const dl = [...r.events, ...browser.drainEvents()].find((e) => e.kind === 'download')
  check('download saved + reported', dl && dl.path && existsSync(dl.path), dl?.path || 'no download event')
  if (dl?.path) try { unlinkSync(dl.path) } catch {}

  // 12. Hover reveals a CSS hover menu; the new item shows up in the next snapshot.
  await home()
  await browser.browserHover({ text: 'Products' })
  const s3 = await browser.browserGetPage()
  check('hover opens menu', refOf(s3, 'Laptops', 'links') != null)

  // 13. Wait for late content by text; friendly timeout message otherwise.
  await browser.browserClick({ text: 'Load more' })
  r = await browser.browserWaitFor({ text: 'Loaded late', timeoutMs: 3000 })
  check('wait_for text (rendered later)', r.ok)
  msg = ''
  try {
    await browser.browserWaitFor({ text: 'never appears', timeoutMs: 600 })
  } catch (e) {
    msg = e.message
  }
  check('wait_for timeout is plain English', /Timed out after 1s waiting for text "never appears"/.test(msg), msg.slice(0, 60))

  // 14. Find: count, snippet, scrolls to the match far down the page.
  const f = await browser.browserFind({ text: '$42' })
  const y = (await browser.browserScroll({ direction: 'down', amount: 0 })).scrollY
  check('find returns snippet + scrolls to it', f.count === 1 && /premium plan/.test(f.matches[0]) && f.scrolled && y > 500, `scrollY=${y}`)

  // 15. Annotated screenshot: marks match the refs, overlay removed afterwards.
  await home()
  const shot = await browser.browserScreenshot({ annotate: true })
  const snapAfter = await browser.browserGetPage()
  const leftover = await browser.browserFind({ text: '__ghost_som' })
  check('annotated screenshot has marks + legend', shot.marks?.length > 5 && /\[\d+\] Save/.test(browser.formatMarks(shot.marks)) && shot.base64.length > 5000)
  check('overlay removed after capture', leftover.count === 0 && snapAfter.buttons.length > 3)
  // The marks were drawn from a fresh snapshot, so ref N on the image === ref N for click.
  const saveMark = shot.marks.find((m) => m.label === 'Save')
  await browser.browserClick({ ref: saveMark.ref })
  check('ref from annotated screenshot clicks the right element', (await title()) === 'CLICKED:save')

  // 16. Press Enter in a field settles the submit it triggers.
  await home()
  await browser.browserClick({ selector: 'input[name="q"]' })
  r = await browser.browserPressKey({ text: 'phone', keys: 'Enter' })
  check('press_key Enter settles', (await title()) === 'SUBMITTED:phone' && r.url)

  // 17. wait_for_navigation right after a completed navigation returns promptly.
  await home()
  const t0 = Date.now()
  r = await browser.browserWaitForNavigation({ timeoutMs: 10000 })
  check('wait_for_navigation does not stall after a finished load', Date.now() - t0 < 6000 && r.url.endsWith('/'), `${Date.now() - t0}ms`)

  // 18. close_tab on the last page leaves a usable blank page.
  r = await browser.browserCloseTab()
  const s4 = await browser.browserGetPage()
  check('close_tab keeps the browser usable', s4.url !== undefined)
} catch (e) {
  check('unexpected failure', false, e.stack || e.message)
} finally {
  await browser.browserClose()
  server.close()
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

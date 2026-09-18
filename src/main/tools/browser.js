import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import electron from 'electron'
const clipboard =
  typeof electron === 'object' && electron?.clipboard
    ? electron.clipboard
    : {
        readText: () => '',
        writeText: () => {}
      }
import { chromium } from 'playwright'
import * as bridge from './browser-bridge.js'
import { policySnapshot, checkUrl } from './site-policy.js'

// Which tab the extension acts on. true (default) = the tab you're actually looking at (auto-synced)
let ACTIVE_TAB_MODE = process.env.GHOST_BROWSER_ACTIVE_TAB !== '0'
export function setActiveTabMode(on) {

  ACTIVE_TAB_MODE = !!on
}
export function getActiveTabMode() {
  return ACTIVE_TAB_MODE
}

// A specific tab the agent pinned with browser_use_tab — overrides target/group so commands act on a
// chosen tab/window even with several Chrome windows open. null = no pin (use group/active logic).
let TARGET_TAB_ID = null
export function setTargetTab(tabId) {
  TARGET_TAB_ID = tabId == null ? null : Number(tabId)
  return TARGET_TAB_ID
}
export function getTargetTab() {
  return TARGET_TAB_ID
}

// Metadata sent with every extension command: which tab to target, the live per-site policy
// (checked inside the extension against the real page URL), and whether to bring Ghost's tab to the
// foreground while acting. focus defaults OFF so the bot works in the background on an unfocused
// tab; set GHOST_BROWSER_FOCUS=1 to watch it work.
function meta() {
  return {
    target: ACTIVE_TAB_MODE ? 'active' : 'group',
    tabId: TARGET_TAB_ID, // pinned tab (browser_use_tab) — overrides target when set
    policy: policySnapshot(),
    focus: process.env.GHOST_BROWSER_FOCUS === '1'
  }
}

// Auto page-context: peek at the tab the user is currently looking at so the agent already "sees"
// it (Claude-for-Chrome style) without first calling browser_get_text. Strictly best-effort:
//   • only in active-tab mode (in own-tab mode "the tab I'm on" isn't a thing)
//   • only when the extension is already connected — never auto-launches Chrome or adds wait
//   • short timeout, swallows every error → null
//   • respects per-site policy: a blocked page throws in the extension → null (we won't quietly
//     read a site the user blocked)
// Disable entirely with GHOST_PAGE_CONTEXT=off.
export async function getActiveTabContext({ maxChars = 4000 } = {}) {
  if (!ACTIVE_TAB_MODE) return null
  if ((process.env.GHOST_PAGE_CONTEXT || '').toLowerCase() === 'off') return null
  if (!bridge.bridgeConnected()) return null
  try {
    const r = await bridge.sendCommand('getText', { target: 'active', policy: policySnapshot() }, 4000)
    if (!r || !r.url) return null
    return { url: r.url, title: r.title || '', text: String(r.text || '').slice(0, maxChars) }
  } catch {
    return null
  }
}

// Backend selector. 'auto' (default) uses the Chrome extension whenever it's connected — that
// drives your REAL Chrome via a local bridge, with no profile and no single-instance lock — and
// otherwise falls back to Playwright. 'extension' / 'playwright' force one.
const BROWSER_BACKEND = process.env.GHOST_BROWSER_BACKEND || 'auto'
// When the extension backend is wanted but no Chrome is connected, open Chrome so the (already
// installed) extension can attach. Set GHOST_BROWSER_AUTOLAUNCH=false to disable.
const AUTOLAUNCH = process.env.GHOST_BROWSER_AUTOLAUNCH !== 'false'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function commandExists(cmd) {
  try {
    return spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: ['ignore', 'pipe', 'ignore'] }).status === 0
  } catch {
    return false
  }
}

function findChromeBinary() {
  const candidates = [process.env.GHOST_CHROME_BIN, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].filter(Boolean)
  return candidates.find((c) => (c.startsWith('/') ? existsSync(c) : commandExists(c))) || null
}

let launching = null
// Open the user's real Chrome (detached) so the extension loads and connects to the bridge.
function launchRealChrome() {
  if (launching) return launching
  const bin = findChromeBinary()
  if (!bin) return Promise.resolve(false)
  launching = new Promise((resolve) => {
    try {
      const proc = spawn(bin, [], { detached: true, stdio: 'ignore' })
      proc.on('error', () => resolve(false))
      proc.unref()
      setTimeout(() => resolve(true), 800)
    } catch {
      resolve(false)
    }
  })
  launching.finally(() => setTimeout(() => (launching = null), 8000)) // allow a relaunch if closed again
  return launching
}

// Decide the backend for this action. In extension/auto mode, if nothing's connected and
// auto-launch is on, open Chrome and wait (~12s) for the extension to come online.
async function ensureBrowserBackend() {
  if (BROWSER_BACKEND === 'playwright') return 'playwright'
  if (bridge.bridgeConnected()) return 'extension'
  let launched = false
  if (AUTOLAUNCH) {
    launched = await launchRealChrome()
    if (launched) {
      for (let i = 0; i < 24 && !bridge.bridgeConnected(); i++) await sleep(500)
      if (bridge.bridgeConnected()) return 'extension'
    }
  }
  // Forced extension, or we opened Chrome but the extension didn't attach: don't silently fall to
  // Playwright on the real profile (it would hit Chrome's single-instance lock) — guide instead.
  if (BROWSER_BACKEND === 'extension' || launched) {
    throw new Error(
      (launched
        ? 'Opened Chrome, but the Ghost-Prime extension isn’t connected, so I can’t drive it. '
        : 'The Ghost-Prime browser extension isn’t connected. ') +
        'Load it in Chrome (chrome://extensions → Load unpacked → the extension/ folder) and try again, ' +
        'or set GHOST_BROWSER_BACKEND=playwright to use the built-in browser instead.'
    )
  }
  return 'playwright' // Chrome appears closed and there's no extension — let Playwright launch its own
}

// Ghost-Prime drives your REAL Google Chrome — the Linux app at /usr/bin/google-chrome,
// using your actual default profile (~/.config/google-chrome) — so it's already logged into
// the sites you use. Headed by default so you can watch it click and type.
//
// This is the Chrome installed inside the Crostini Linux container (your Chrome OS host
// browser lives outside the container and can't be driven from here).
//
// Chrome allows only ONE instance per profile, so close Chrome before letting Ghost-Prime
// use it — otherwise the launch is refused (you'll get a clear message).
//
// Env overrides:
//   GHOST_BROWSER_CHANNEL=chromium    use Playwright's bundled Chromium instead of real Chrome
//   GHOST_BROWSER_PROFILE=isolated    use a separate Ghost-Prime profile (log in once; never
//                                     conflicts with your open Chrome) — or pass a custom path
//   GHOST_BROWSER_HEADLESS=true       no visible window (e.g. tests)
//   GHOST_BROWSER_NO_SANDBOX=true     pass --no-sandbox (only if Chrome refuses to start; it
//                                     makes Chrome show an "unsupported flag" warning bar)
const CHANNEL = process.env.GHOST_BROWSER_CHANNEL ?? 'chrome' // '' falls back to bundled Chromium
const HEADLESS = process.env.GHOST_BROWSER_HEADLESS === 'true'
// Chrome on Crostini runs fine with its sandbox (your normal Chrome does). Passing
// --no-sandbox triggers Chrome's yellow "security will suffer" banner, so leave it OFF.
const NO_SANDBOX = process.env.GHOST_BROWSER_NO_SANDBOX === 'true'
const DEFAULT_CHROME_PROFILE = join(homedir(), '.config', 'google-chrome')
const ISOLATED_PROFILE = join(homedir(), '.config', 'ghost-prime', 'browser-profile')

function resolveProfileDir() {
  const p = process.env.GHOST_BROWSER_PROFILE
  if (!p || p === 'default' || p === 'chrome') return DEFAULT_CHROME_PROFILE // your real Chrome profile
  if (p === 'isolated' || p === 'ghost') return ISOLATED_PROFILE
  return p // an explicit user-data-dir path
}

// Make launch failures actionable instead of a raw Playwright stack.
function enrichLaunchError(err, userDataDir) {
  const msg = err?.message || String(err)
  if (/ProcessSingleton|SingletonLock|already (running|in use)|Browser closed unexpectedly|Target.*has been closed|Timed out.*(WS|endpoint)|profile.*in use|cannot create.*lock/i.test(msg)) {
    return new Error(
      `Couldn't open Chrome with your profile (${userDataDir}) — it looks like Chrome is already ` +
        'running. Chrome allows only one instance per profile: close all Chrome windows and try ' +
        'again, or set GHOST_BROWSER_PROFILE=isolated to use a separate Ghost-Prime profile.'
    )
  }
  if (/No such file|executable doesn'?t exist|channel .* not found|Chromium distribution|spawn .* ENOENT/i.test(msg)) {
    return new Error(
      `Couldn't launch Google Chrome (channel="${CHANNEL}"). Is it installed at /usr/bin/google-chrome? ` +
        'Set GHOST_BROWSER_CHANNEL=chromium to use the bundled browser instead.'
    )
  }
  return err
}

let context = null
let page = null

async function ensurePage() {
  if (!context) {
    const userDataDir = resolveProfileDir()
    const opts = {
      headless: HEADLESS,
      viewport: null, // use the real window size
      args: NO_SANDBOX ? ['--no-sandbox', '--disable-setuid-sandbox'] : []
    }
    if (CHANNEL) opts.channel = CHANNEL // 'chrome' = real Google Chrome; '' = bundled Chromium
    try {
      context = await chromium.launchPersistentContext(userDataDir, opts)
    } catch (err) {
      throw enrichLaunchError(err, userDataDir)
    }
    page = context.pages()[0] || (await context.newPage())
  }
  if (!page || page.isClosed()) page = await context.newPage()
  return page
}

export async function browserNavigate({ url, waitUntil } = {}) {
  const gate = checkUrl(url)
  if (!gate.ok) throw new Error(gate.reason)
  if ((await ensureBrowserBackend()) === 'extension') return bridge.sendCommand('navigate', { url, ...meta() }, 35000)
  const p = await ensurePage()
  const mode = waitUntil === 'networkidle' ? 'networkidle' : 'domcontentloaded'
  await p.goto(url, { waitUntil: mode, timeout: 35000 })
  await p.waitForLoadState('load', { timeout: 8000 }).catch(() => {})
  return { url: p.url(), title: await p.title() }
}

export async function browserScreenshot({ fullPage } = {}) {
  if ((await ensureBrowserBackend()) === 'extension') return bridge.sendCommand('screenshot', { fullPage: !!fullPage, ...meta() })
  const p = await ensurePage()
  const buf = await p.screenshot({ type: 'png', fullPage: !!fullPage })
  return { base64: buf.toString('base64'), url: p.url() }
}

// Back / forward / reload in the active tab's own history — the browser's nav buttons, for the
// agent. Extension path runs against your real Chrome tab; Playwright path drives its own page.
export async function browserGoBack() {
  if ((await ensureBrowserBackend()) === 'extension') return bridge.sendCommand('goBack', { ...meta() }, 35000)
  const p = await ensurePage()
  await p.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  return { url: p.url(), title: await p.title() }
}

export async function browserGoForward() {
  if ((await ensureBrowserBackend()) === 'extension') return bridge.sendCommand('goForward', { ...meta() }, 35000)
  const p = await ensurePage()
  await p.goForward({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  return { url: p.url(), title: await p.title() }
}

export async function browserReload() {
  if ((await ensureBrowserBackend()) === 'extension') return bridge.sendCommand('reloadTab', { ...meta() }, 35000)
  const p = await ensurePage()
  await p.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  return { url: p.url(), title: await p.title() }
}

// Playwright's CSS engine parses STANDARD CSS only. jQuery-style pseudo-classes like
// :contains() are invalid and throw. Callers should click by visible text (the `text`
// option) — but if a stray :contains("X") slips through, repair it to Playwright's own
// :has-text("X") so the click still works instead of erroring out.
function normalizeSelector(selector) {
  if (typeof selector !== 'string' || !selector.trim()) {
    throw new Error(
      'No selector provided. Pass a standard CSS selector, or use the "text" option to click an element by its visible text.'
    )
  }
  return selector.replace(/:contains\(\s*(['"]?)([\s\S]*?)\1\s*\)/gi, ':has-text("$2")')
}

// Playwright locator from CSS, xpath=..., or role hints.
function resolveLocator(page, selector) {
  const raw = String(selector).trim()
  if (raw.startsWith('xpath=')) return page.locator(raw)
  if (raw.startsWith('//') || raw.startsWith('(')) return page.locator(`xpath=${raw}`)
  return page.locator(normalizeSelector(raw))
}

export function formatPageSnapshot(s) {
  const lines = [`# ${s.title || '(no title)'}`, s.url || '', '']
  if (s.buttons?.length) {
    lines.push('## Buttons & controls')
    for (const b of s.buttons) lines.push(`- "${b.label}"${b.selector ? ` → ${b.selector}` : ''}`)
    lines.push('')
  }
  if (s.links?.length) {
    lines.push('## Links')
    for (const l of s.links) lines.push(`- "${l.label}" → ${l.href}`)
    lines.push('')
  }
  if (s.fields?.length) {
    lines.push('## Input fields')
    for (const f of s.fields) {
      const hint = [f.type, f.placeholder, f.value ? `value="${f.value.slice(0, 40)}"` : null]
        .filter(Boolean)
        .join(', ')
      lines.push(`- ${f.label || f.name || f.selector}${hint ? ` (${hint})` : ''}`)
    }
    lines.push('')
  }
  if (s.selects?.length) {
    lines.push('## Dropdowns')
    for (const d of s.selects) {
      const opts = (d.options || []).slice(0, 8).join(' | ')
      lines.push(`- ${d.label || d.name || d.selector}: ${opts}${d.options?.length > 8 ? ' …' : ''}`)
    }
    lines.push('')
  }
  if (s.excerpt) {
    lines.push('## Page excerpt')
    lines.push(s.excerpt)
  }
  return lines.join('\n').trim()
}

// Injected in-page: structured list of interactive elements (self-contained for extension).
function pageSnapshotInPage(maxItems) {
  const cap = Math.min(Number(maxItems) || 40, 60)
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return false
    const s = getComputedStyle(el)
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'
  }
  const labelOf = (el) =>
    (el.getAttribute('aria-label') || el.innerText || el.value || el.title || el.placeholder || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 80)
  const selOf = (el) => {
    if (el.id) return `#${CSS.escape(el.id)}`
    const name = el.getAttribute('name')
    if (name) return `[name="${name.replace(/"/g, '\\"')}"]`
    return ''
  }
  const buttons = []
  const links = []
  const fields = []
  const selects = []
  for (const el of document.querySelectorAll(
    'button, [role="button"], [role="link"], [role="menuitem"], [role="tab"], input[type="submit"], input[type="button"], summary'
  )) {
    if (!visible(el)) continue
    const label = labelOf(el)
    if (!label) continue
    buttons.push({ label, selector: selOf(el) })
    if (buttons.length >= cap) break
  }
  for (const el of document.querySelectorAll('a[href]')) {
    if (!visible(el)) continue
    const label = labelOf(el)
    if (!label) continue
    links.push({ label, href: el.href })
    if (links.length >= cap) break
  }
  for (const el of document.querySelectorAll('input, textarea, [contenteditable="true"]')) {
    if (!visible(el)) continue
    if (el.type === 'hidden') continue
    fields.push({
      label: labelOf(el),
      name: el.name || '',
      type: el.type || el.tagName.toLowerCase(),
      placeholder: el.placeholder || '',
      value: el.value || el.textContent?.slice(0, 40) || '',
      selector: selOf(el)
    })
    if (fields.length >= cap) break
  }
  for (const el of document.querySelectorAll('select')) {
    if (!visible(el)) continue
    selects.push({
      label: labelOf(el),
      name: el.name || '',
      selector: selOf(el),
      options: [...el.options].map((o) => o.text.trim()).filter(Boolean)
    })
    if (selects.length >= cap) break
  }
  const excerpt = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1200)
  return { url: location.href, title: document.title, buttons, links, fields, selects, excerpt }
}

// A locator (on `root`, the page or a frame) restricted to elements Playwright counts as
// visible — so we never commit to a hidden / zero-size duplicate that would just time out.
function vis(root) {
  return root.locator(':visible')
}

// Find the best clickable element for some visible text, searching the main page AND every
// iframe (chat widgets, OAuth popups, embeds render in frames — page.locator never crosses
// into them). Prefers a real accessible control, then any visible element with the text.
// Returns a single-element locator, or null if nothing visible matches.
async function findClickable(page, text) {
  for (const frame of page.frames()) {
    const candidates = [
      frame.getByRole('button', { name: text }),
      frame.getByRole('link', { name: text }),
      frame.getByRole('menuitem', { name: text }),
      frame.getByRole('tab', { name: text }),
      frame.getByRole('option', { name: text }),
      frame.getByRole('checkbox', { name: text }),
      frame.getByText(text, { exact: false })
    ]
    for (const loc of candidates) {
      const hit = loc.and(vis(frame)).first()
      if (await hit.count().catch(() => 0)) return hit
    }
  }
  return null
}

// List the page's visible clickable elements (across frames), so a failed click can tell the
// agent exactly what IS clickable instead of dead-ending on a bare timeout.
async function listClickables(page, limit = 25) {
  const labels = new Set()
  for (const frame of page.frames()) {
    try {
      const found = await frame.evaluate((max) => {
        const out = []
        const sel =
          'button, a[href], [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"], input[type="submit"], input[type="button"], summary'
        for (const el of document.querySelectorAll(sel)) {
          const r = el.getBoundingClientRect()
          if (r.width < 1 || r.height < 1) continue
          const s = getComputedStyle(el)
          if (s.visibility === 'hidden' || s.display === 'none') continue
          const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.title || '')
            .trim()
            .replace(/\s+/g, ' ')
          if (label) out.push(label.slice(0, 60))
          if (out.length >= max) break
        }
        return out
      }, limit)
      for (const l of found) labels.add(l)
    } catch {
      // cross-origin / detached frame — skip
    }
    if (labels.size >= limit) break
  }
  return [...labels].slice(0, limit)
}

// Robust "click by visible text". Scrolls into view, and if a transient overlay intercepts
// the click, retries once with force. Throws (to be enriched with a clickable listing) when
// the text matches nothing visible.
async function clickByText(page, text, timeout) {
  const loc = await findClickable(page, text)
  if (!loc) {
    const e = new Error(`no visible clickable element matched the text "${text}"`)
    e.ghostNotFound = true
    throw e
  }
  await loc.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {})
  try {
    await loc.click({ timeout })
  } catch (err) {
    if (/intercept|not stable|obscur/i.test(err?.message || '')) {
      await loc.click({ timeout: 4000, force: true }) // overlay was in the way — push through
    } else {
      throw err
    }
  }
}

// Turn Playwright's cryptic selector/timeout errors into guidance the agent can act on,
// including the page's currently-clickable elements so it can self-correct in one step.
async function clarifyClickError(page, err, { selector, text }) {
  const msg = err?.message || String(err)
  if (/unknown engine|parsing css selector|unexpected token|not a valid selector|malformed/i.test(msg)) {
    return new Error(
      `Invalid selector ${JSON.stringify(selector)}. Do NOT use jQuery selectors (:contains, :visible, :eq, :first). ` +
        'To click by visible text, call browser_click with { text: "Log In" }. ' +
        'Otherwise use a standard CSS selector: #id, .class, or [attribute] such as [aria-label="Log In"] or [data-action="login"].'
    )
  }
  if (err?.ghostNotFound || /timeout|not found|no element|not visible|intercept|waiting for/i.test(msg)) {
    const what = text ? `text "${text}"` : `selector ${JSON.stringify(selector)}`
    const clickables = await listClickables(page).catch(() => [])
    const list = clickables.length
      ? ` The visible, clickable elements right now are: ${clickables.map((c) => `"${c}"`).join(', ')}.`
      : ''
    return new Error(
      `Couldn't click ${what} — it wasn't found or wasn't clickable in time.${list} ` +
        'Retry browser_click with the EXACT visible text of the element you want (one from that list), ' +
        'or call browser_get_text / browser_screenshot to inspect the page first.'
    )
  }
  return err
}

export async function browserClick({ selector, text, double, button = 'left' } = {}) {
  if ((await ensureBrowserBackend()) === 'extension') {
    return bridge.sendCommand('click', { selector, text, double: !!double, button, ...meta() })
  }
  const p = await ensurePage()
  const clickOpts = { timeout: 12000, button: button === 'right' ? 'right' : button === 'middle' ? 'middle' : 'left' }
  try {
    let loc
    if (text != null && String(text).trim() !== '') {
      loc = await findClickable(p, String(text))
      if (!loc) {
        const e = new Error(`no visible clickable element matched the text "${text}"`)
        e.ghostNotFound = true
        throw e
      }
    } else {
      loc = resolveLocator(p, selector).and(p.locator(':visible')).first()
      if (!(await loc.count().catch(() => 0))) loc = resolveLocator(p, selector).first()
    }
    await loc.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {})
    if (double) await loc.dblclick({ timeout: 12000 })
    else {
      try {
        await loc.click(clickOpts)
      } catch (err) {
        if (/intercept|not stable|obscur/i.test(err?.message || '')) {
          await loc.click({ ...clickOpts, timeout: 4000, force: true })
        } else throw err
      }
    }
  } catch (err) {
    throw await clarifyClickError(p, err, { selector, text })
  }
  return { ok: true, url: p.url() }
}

export async function browserFill({ selector, value, label } = {}) {
  if ((await ensureBrowserBackend()) === 'extension') return bridge.sendCommand('fill', { selector, label, value, ...meta() })
  const p = await ensurePage()
  const val = value ?? ''
  try {
    let target
    if (label != null && String(label).trim() !== '') {
      target = p.getByLabel(String(label)).and(p.locator(':visible')).first()
      if (!(await target.count().catch(() => 0))) {
        target = p
          .getByPlaceholder(String(label))
          .or(p.getByRole('textbox', { name: String(label) }))
          .or(p.getByRole('combobox', { name: String(label) }))
          .first()
      }
    } else {
      target = resolveLocator(p, selector).and(p.locator(':visible')).first()
      if (!(await target.count().catch(() => 0))) target = resolveLocator(p, selector).first()
    }
    await target.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {})
    const tag = await target.evaluate((el) => el.tagName).catch(() => '')
    if (tag === 'SELECT') {
      try {
        await target.selectOption({ label: val }, { timeout: 12000 })
      } catch {
        try {
          await target.selectOption({ value: val }, { timeout: 12000 })
        } catch {
          const options = await target.evaluate((el) => [...el.options].map((o) => o.text.trim()).filter(Boolean))
          throw new Error(
            `Couldn't match "${val}" to a dropdown option.` +
              (options.length ? ` Choose one of: ${options.slice(0, 20).map((o) => `"${o}"`).join(', ')}.` : '')
          )
        }
      }
    } else {
      await target.fill(val, { timeout: 12000 })
    }
  } catch (err) {
    throw await clarifyClickError(p, err, { selector, text: label })
  }
  return { ok: true }
}

export async function browserGetPage({ limit } = {}) {
  const cap = Math.min(Number(limit) || 40, 60)
  if ((await ensureBrowserBackend()) === 'extension') {
    const r = await bridge.sendCommand('getPage', { limit: cap, ...meta() })
    return { ...r, formatted: formatPageSnapshot(r) }
  }
  const p = await ensurePage()
  const snapshot = await p.evaluate(pageSnapshotInPage, cap)
  return { ...snapshot, formatted: formatPageSnapshot(snapshot) }
}

export async function browserGetText({ offset } = {}) {
  const off = Math.max(0, Number(offset) || 0)
  if ((await ensureBrowserBackend()) === 'extension') return bridge.sendCommand('getText', { offset: off, ...meta() })
  const p = await ensurePage()
  const text = await p.evaluate(() => document.body?.innerText || '')
  const slice = text.slice(off, off + 20000)
  const nextOffset = off + slice.length < text.length ? off + slice.length : null
  return { url: p.url(), title: await p.title(), text: slice, offset: off, nextOffset, totalChars: text.length }
}

// Open several URLs at once and return each page's readable text — the fast path for multi-page
// research. Pages load in parallel (separate tabs in your real Chrome, or separate Playwright
// pages in the fallback), so N pages cost roughly one page's wait instead of N sequential trips.
export async function browserReadPages({ urls, keepOpen } = {}) {
  const list = (Array.isArray(urls) ? urls : []).map(String).filter(Boolean).slice(0, 8)
  if (!list.length) throw new Error('browser_read_pages needs a non-empty "urls" array')

  if ((await ensureBrowserBackend()) === 'extension') {
    return bridge.sendCommand('readPages', { urls: list, keepOpen: keepOpen !== false, ...meta() }, 60000)
  }

  // Playwright fallback: open each page concurrently in the persistent context.
  await ensurePage() // make sure context exists
  const pages = await Promise.all(
    list.map(async (url) => {
      const gate = checkUrl(url)
      if (!gate.ok) return { url, title: '', text: '', error: gate.reason }
      let pg = null
      try {
        pg = await context.newPage()
        await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
        const text = await pg.evaluate(() => document.body?.innerText || '')
        const out = { url: pg.url(), title: await pg.title(), text: text.slice(0, 12000) }
        if (keepOpen === false && pg !== page) await pg.close().catch(() => {})
        return out
      } catch (e) {
        if (pg && keepOpen === false && pg !== page) await pg.close().catch(() => {})
        return { url, title: '', text: '', error: String(e?.message || e) }
      }
    })
  )
  return { pages }
}

// Click at a point located from a screenshot (vision-grounded). x,y are fractions of the viewport
// (0..1, top-left origin) — or raw pixels if > 1. The fix for sites where text/selector fails.
export async function browserClickAt({ x, y } = {}) {
  if (x == null || y == null) throw new Error('browser_click_at needs x and y (fractions of the viewport, 0..1)')
  if ((await ensureBrowserBackend()) === 'extension') return bridge.sendCommand('clickAt', { x: Number(x), y: Number(y), ...meta() })
  const p = await ensurePage()
  const { w, h } = await p.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
  const px = Number(x) <= 1 ? Number(x) * w : Number(x)
  const py = Number(y) <= 1 ? Number(y) * h : Number(y)
  await p.mouse.click(px, py)
  return { ok: true, url: p.url() }
}

// Scroll the page (or a specific scrollable element) to reveal off-screen content / load more.
export async function browserScroll({ direction = 'down', amount, selector } = {}) {
  if ((await ensureBrowserBackend()) === 'extension') return bridge.sendCommand('scroll', { direction, amount, selector, ...meta() })
  const p = await ensurePage()
  const scrollY = await p.evaluate(
    ({ direction, amount, selector }) => {
      function largestScrollable() {
        let best = null
        let bestArea = 0
        for (const e of document.querySelectorAll('*')) {
          if (e.scrollHeight - e.clientHeight > 40) {
            const r = e.getBoundingClientRect()
            const area = r.width * r.height
            if (area > bestArea) {
              best = e
              bestArea = area
            }
          }
        }
        return best
      }
      let el = null
      if (selector) {
        try {
          el = document.querySelector(selector)
        } catch {}
      }
      const root = document.scrollingElement || document.documentElement
      if (!el && root.scrollHeight - root.clientHeight <= 40) el = largestScrollable()
      const viewH = el ? el.clientHeight : window.innerHeight
      const step = amount != null ? Number(amount) : Math.round((viewH || 800) * 0.85)
      if (direction === 'top') {
        if (el) el.scrollTop = 0
        else window.scrollTo(0, 0)
      } else if (direction === 'bottom') {
        if (el) el.scrollTop = el.scrollHeight
        else window.scrollTo(0, document.body.scrollHeight)
      } else {
        const dy = direction === 'up' ? -step : step
        if (el) el.scrollBy(0, dy)
        else window.scrollBy(0, dy)
      }
      return el ? el.scrollTop : window.scrollY
    },
    { direction, amount, selector }
  )
  return { ok: true, scrollY, url: p.url() }
}

// Normalize a key combo to Playwright's naming (Ctrl→Control, Cmd→Meta, esc→Escape, …).
function normalizeCombo(combo) {
  return String(combo)
    .split('+')
    .map((part) => {
      const p = part.trim()
      const lp = p.toLowerCase()
      if (lp === 'ctrl' || lp === 'control') return 'Control'
      if (lp === 'cmd' || lp === 'command' || lp === 'meta' || lp === 'super') return 'Meta'
      if (lp === 'alt' || lp === 'option') return 'Alt'
      if (lp === 'shift') return 'Shift'
      if (lp === 'esc') return 'Escape'
      if (lp === 'space') return ' '
      return p
    })
    .join('+')
}

// Is this combo a clipboard shortcut (Ctrl/Cmd + C/V/X)? Those can't be done with a synthetic
// keystroke — Chrome won't read/write the real clipboard for a scripted key event — so we route
// them through Electron's native clipboard instead. Returns 'copy' | 'paste' | 'cut' | null.
function clipboardIntent(combo) {
  const parts = String(combo).toLowerCase().split('+').map((s) => s.trim()).filter(Boolean)
  if (parts.length < 2) return null
  const hasMod = parts.slice(0, -1).some((p) => ['ctrl', 'control', 'cmd', 'command', 'meta', 'super'].includes(p))
  if (!hasMod) return null
  return { c: 'copy', v: 'paste', x: 'cut' }[parts[parts.length - 1]] || null
}

// Send real keystrokes to whatever has focus on the page. `text` types literal characters;
// `keys` presses one combo or a list of them ("Enter", "Control+A", "Control+V", "ArrowDown").
// This is what lets the agent type into Google Docs/Slides, Monaco, and other editors that have
// no fillable form field for browser_fill to target. Copy/paste/cut (Ctrl/Cmd+C/V/X) are handled
// via the real system clipboard: paste inserts the clipboard text; copy/cut read the page
// selection back into the clipboard so it can be pasted elsewhere.
export async function browserPressKey({ keys, text } = {}) {
  const hasText = text != null && String(text) !== ''
  const keyList = keys == null ? [] : Array.isArray(keys) ? keys : [keys]
  if (!hasText && !keyList.length) throw new Error('browser_press_key needs "text" to type and/or "keys" to press')
  if ((await ensureBrowserBackend()) === 'extension') {
    // Hand the extension the current clipboard text (for paste) and take back any copied selection.
    const r = await bridge.sendCommand('pressKey', { keys, text, clipboardText: clipboard.readText(), ...meta() }, 30000)
    if (r && typeof r.copied === 'string' && r.copied) {
      try {
        clipboard.writeText(r.copied)
      } catch {}
    }
    return r
  }
  const p = await ensurePage()
  if (hasText) await p.keyboard.type(String(text))
  for (const combo of keyList) {
    const intent = clipboardIntent(combo)
    if (intent === 'paste') await p.keyboard.insertText(clipboard.readText())
    else if (intent === 'copy' || intent === 'cut') {
      const sel = await p.evaluate(() => {
        const el = document.activeElement
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && typeof el.selectionStart === 'number')
          return el.value.slice(el.selectionStart, el.selectionEnd)
        return String(window.getSelection() || '')
      })
      if (sel) clipboard.writeText(sel)
      if (intent === 'cut') await p.keyboard.press('Backspace')
    } else await p.keyboard.press(normalizeCombo(combo))
  }
  return { ok: true, url: p.url() }
}

// Wait until a selector or visible text appears — for pages that render content after load
// (SPAs, spinners, lazy lists, post-login redirects). Resolves when found, throws on timeout.
export async function browserWaitFor({ selector, text, timeoutMs } = {}) {
  const hasText = text != null && String(text).trim() !== ''
  if (!selector && !hasText) throw new Error('browser_wait_for needs a "selector" or "text" to wait for')
  const ms = Math.min(Number(timeoutMs) || 10000, 30000)
  if ((await ensureBrowserBackend()) === 'extension') {
    // Give the bridge call headroom beyond the in-page wait so it never times out first.
    return bridge.sendCommand('waitFor', { selector, text, timeoutMs: ms, ...meta() }, ms + 6000)
  }
  const p = await ensurePage()
  if (selector) {
    await p.waitForSelector(selector, { timeout: ms, state: 'visible' })
  } else {
    await p.waitForFunction(
      (t) => !!document.body && document.body.innerText.toLowerCase().includes(String(t).toLowerCase()),
      text,
      { timeout: ms }
    )
  }
  return { ok: true, url: p.url() }
}

// Wait for navigation to complete (after a click that triggers a page load).
// Use this after browser_click or browser_click_at when you expect a new page to load.
export async function browserWaitForNavigation({ timeoutMs } = {}) {
  const ms = Math.min(Number(timeoutMs) || 30000, 60000)
  if ((await ensureBrowserBackend()) === 'extension') {
    return bridge.sendCommand('waitForNavigation', { timeoutMs: ms, ...meta() }, ms + 6000)
  }
  const p = await ensurePage()
  try {
    await p.waitForLoadState('domcontentloaded', { timeout: ms })
  } catch (e) {
    // Ignore timeout - page might already be loaded
  }
  return { ok: true, url: p.url() }
}

export async function browserClose() {
  if (context) {
    await context.close().catch(() => {})
    context = null
    page = null
  }
  return { ok: true, closed: true }
}

// Close the CURRENT tab/page (not the whole browser). For Playwright, creates a new
// about:blank page if the closed one was the last — so subsequent commands still work.
export async function browserCloseTab() {
  if ((await ensureBrowserBackend()) === 'extension') return bridge.sendCommand('closeTab', { ...meta() }, 15000)
  await ensurePage()
  if (context.pages().length <= 1) {
    // Don't kill the last page — open a blank one and go there.
    const pg = await context.newPage()
    await page.close().catch(() => {})
    page = pg
  } else {
    const closed = page
    page = context.pages().find((p) => p !== closed) || (await context.newPage())
    await closed.close().catch(() => {})
  }
  return { ok: true, url: page ? page.url() : '' }
}

// List every open tab — url, title, which window, and whether it's playing audio (audible) — so the
// agent can see what's open / what's playing and then pin one with setTargetTab.
export async function browserListTabs() {
  if ((await ensureBrowserBackend()) === 'extension') return bridge.sendCommand('listTabs', { ...meta() }, 15000)
  // Playwright fallback: enumerate the context's pages (no per-tab audible signal here).
  await ensurePage()
  const pages = context.pages()
  const tabs = await Promise.all(
    pages.map(async (pg, i) => ({
      tabId: i,
      windowId: 0,
      url: pg.url(),
      title: await pg.title().catch(() => ''),
      active: pg === page,
      audible: false,
      muted: false,
      focusedWindow: pg === page
    }))
  )
  return { tabs }
}

// Connected executor browsers (separate Chrome/Brave/profiles) from the bridge — for picking which
// one to drive when more than one is connected.
export function listBrowsers() {
  return bridge.listDevices()
}
export function useBrowser(id) {
  return bridge.selectDevice(id)
}

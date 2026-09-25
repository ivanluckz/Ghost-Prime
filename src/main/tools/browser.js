import { homedir } from 'node:os'
import { join, basename, extname } from 'node:path'
import { existsSync, lstatSync, mkdirSync } from 'node:fs'
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
import { envBool } from '../env.js'

// Which tab the extension acts on. true (default) = the tab you're actually looking at (auto-synced)
let ACTIVE_TAB_MODE = envBool('GHOST_BROWSER_ACTIVE_TAB', true)
export function setActiveTabMode(on) {

  ACTIVE_TAB_MODE = !!on
}
export function getActiveTabMode() {
  return ACTIVE_TAB_MODE
}

// A specific tab the agent pinned with browser_use_tab — overrides target/group so commands act on a
// chosen tab/window even with several Chrome windows open. null = no pin (use group/active logic).
// Extension backend only: on Playwright, useTab() switches the live page directly.
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
    focus: envBool('GHOST_BROWSER_FOCUS', false),
    dialogs: DIALOG_POLICY // how the extension answers alert()/confirm()/prompt() (GHOST_BROWSER_DIALOGS)
  }
}

// Auto page-context: peek at the tab the user is currently looking at so the agent already "sees"
// it (Claude-for-Chrome style) without first calling browser_get_text. Strictly best-effort:
//   • only in active-tab mode (in own-tab mode "the tab I'm on" isn't a thing)
//   • only when the extension is already connected — never auto-launches Chrome or adds wait
//   • short timeout, swallows every error → null
//   • respects per-site policy: a blocked page throws in the extension → null (we won't quietly
//     read a site the user blocked)
// Disable entirely with GHOST_PAGE_CONTEXT=0.
export async function getActiveTabContext({ maxChars = 4000 } = {}) {
  if (!ACTIVE_TAB_MODE) return null
  if (!envBool('GHOST_PAGE_CONTEXT', true)) return null
  if (!bridge.browserConnected()) return null
  try {
    const r = await bridge.sendBrowserCommand('getText', { target: 'active', policy: policySnapshot() }, 4000)
    if (!r || !r.url) return null
    return { url: r.url, title: r.title || '', text: String(r.text || '').slice(0, maxChars) }
  } catch {
    return null
  }
}

// Backend selector. 'auto' (default) uses the Chrome extension whenever it's connected — that
// drives your REAL Chrome via a local bridge, with no profile and no single-instance lock. If no
// extension is connected (and auto-launching Chrome didn't bring one online within ~12s) it falls
// back to Playwright: on the configured profile when that can't collide with the Chrome we just
// opened, otherwise on the separate Ghost-Prime profile. 'extension' / 'playwright' force one.
const BROWSER_BACKEND = process.env.GHOST_BROWSER_BACKEND || 'auto'
// Longest in-page wait the extension will honour (WAIT_CAP_MS in extension/background.js): the
// extension can't poll while it runs a command, and the bridge counts a device as gone after 30s.
const EXT_WAIT_CAP = 24000
// When the extension backend is wanted but no Chrome is connected, open Chrome so the (already
// installed) extension can attach. Set GHOST_BROWSER_AUTOLAUNCH=0 to disable.
const AUTOLAUNCH = envBool('GHOST_BROWSER_AUTOLAUNCH', true)
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

// Is the user's real Chrome running on its default profile right now? Chrome keeps a SingletonLock
// symlink in the profile dir while it's open (lstat: the link's target is a "host-pid" that never
// exists, so existsSync would say no).
function chromeProfileLocked() {
  try {
    lstatSync(join(DEFAULT_CHROME_PROFILE, 'SingletonLock'))
    return true
  } catch {
    return false
  }
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
// auto-launch is on, open Chrome ONCE and wait (~12s) for the extension to come online.
//
// The launch outcome is remembered: if Chrome came up without an extension (not loaded, or
// dev-mode extensions blocked), we don't try again for EXTENSION_RETRY_MS — otherwise every single
// tool call would spawn another Chrome window (ProcessSingleton just opens a new window in the
// running instance) and stall ~13s before falling back. The cheap browserConnected() check always
// runs first, so an extension loaded later is picked up on the very next action, and a Playwright
// context that's already open is kept (no auto-launch while it runs).
const EXTENSION_RETRY_MS = 10 * 60_000
let extensionAbsentUntil = 0 // Date.now() before which auto-launch is skipped (last launch brought no extension)
let lastBackend = null
let fallbackProfile = null // set once 'auto' had to sidestep the real profile's single-instance lock
let fallbackWarned = false
async function ensureBrowserBackend() {
  const b = await pickBrowserBackend()
  // Refs from a snapshot on the OTHER backend point at a different page/DOM — never replay them.
  if (b !== lastBackend) {
    lastBackend = b
    lastRefs = new Map()
    lastRefsBackend = null
    refGen++
  }
  return b
}
async function pickBrowserBackend() {
  if (BROWSER_BACKEND === 'playwright') return 'playwright'
  if (bridge.browserConnected()) {
    extensionAbsentUntil = 0 // the extension is here — a later disconnect may auto-launch again
    return 'extension'
  }
  let launched = false
  const skipLaunch = !AUTOLAUNCH || Date.now() < extensionAbsentUntil || (BROWSER_BACKEND !== 'extension' && !!context)
  if (!skipLaunch) {
    launched = await launchRealChrome()
    if (launched) {
      for (let i = 0; i < 24 && !bridge.browserConnected(); i++) await sleep(500)
      if (bridge.browserConnected()) {
        extensionAbsentUntil = 0
        return 'extension'
      }
      // Chrome is up but no extension connected: don't spawn/wait again on every action.
      extensionAbsentUntil = Date.now() + EXTENSION_RETRY_MS
    }
  }
  // Forced extension: don't silently switch — guide instead.
  if (BROWSER_BACKEND === 'extension') {
    throw new Error(
      (launched || (chromeProfileLocked() && Date.now() < extensionAbsentUntil)
        ? 'Opened Chrome, but the Ghost-Prime extension isn’t connected, so I can’t drive it. '
        : 'The Ghost-Prime browser extension isn’t connected. ') +
        'Load it in Chrome (chrome://extensions → Load unpacked → the extension/ folder) and try again, ' +
        'or set GHOST_BROWSER_BACKEND=playwright to use the built-in browser instead.'
    )
  }
  // 'auto' with no extension: fall back to Playwright. Chrome allows one instance per profile, so if
  // we just opened the user's real Chrome (or it was already running) and Playwright would use that
  // same profile, it would hit the single-instance lock — use the separate Ghost-Prime profile then.
  // Only when no Playwright context exists yet: an open context may itself be the Chrome holding
  // the default profile's lock, and it must keep running on that (logged-in) profile.
  if (!context && !fallbackProfile && (launched || chromeProfileLocked()) && CHANNEL === 'chrome' && resolveProfileDir() === DEFAULT_CHROME_PROFILE) {
    fallbackProfile = ISOLATED_PROFILE
    console.warn(
      `[browser] Chrome is open but the Ghost-Prime extension isn’t connected — falling back to the built-in ` +
        `Playwright browser on the separate profile ${ISOLATED_PROFILE} (your real profile is locked by the running Chrome). ` +
        'Load the extension in Chrome (chrome://extensions → Load unpacked → extension/) to drive your real browser instead.'
    )
  } else if (!fallbackWarned) {
    console.warn(`[browser] Ghost-Prime extension not connected — using the built-in Playwright browser (profile: ${resolveProfileDir()}).`)
  }
  fallbackWarned = true
  return 'playwright'
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
//   GHOST_BROWSER_HEADLESS=1          no visible window (e.g. tests)
//   GHOST_BROWSER_NO_SANDBOX=1        pass --no-sandbox (only if Chrome refuses to start; it
//                                     makes Chrome show an "unsupported flag" warning bar)
//   GHOST_BROWSER_DIALOGS=dismiss     answer confirm()/prompt() with Cancel instead of OK
const CHANNEL = process.env.GHOST_BROWSER_CHANNEL ?? 'chrome' // '' falls back to bundled Chromium
const HEADLESS = envBool('GHOST_BROWSER_HEADLESS', false)
// Chrome on Crostini runs fine with its sandbox (your normal Chrome does). Passing
// --no-sandbox triggers Chrome's yellow "security will suffer" banner, so leave it OFF.
const NO_SANDBOX = envBool('GHOST_BROWSER_NO_SANDBOX', false)
const DEFAULT_CHROME_PROFILE = join(homedir(), '.config', 'google-chrome')
const ISOLATED_PROFILE = join(homedir(), '.config', 'ghost-prime', 'browser-profile')

function resolveProfileDir() {
  if (fallbackProfile) return fallbackProfile // 'auto' backend sidestepping a running Chrome (pickBrowserBackend)
  const p = process.env.GHOST_BROWSER_PROFILE
  if (!p || p === 'default' || p === 'chrome') return DEFAULT_CHROME_PROFILE // your real Chrome profile
  if (p === 'isolated' || p === 'ghost') return ISOLATED_PROFILE
  return p // an explicit user-data-dir path
}

// The browser binary itself is missing (channel not installed, bundled Chromium not downloaded).
const isMissingBrowser = (err) =>
  /No such file|executable doesn'?t exist|channel .* not found|Chromium distribution|spawn .* ENOENT|is not found at/i.test(err?.message || String(err))

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

// ---------------------------------------------------------------------------
// Playwright page lifecycle. Every page gets a stable tabId (browser_list_tabs / browser_use_tab),
// popups the PAGE opens are followed the way a new tab takes focus for a human (OAuth windows,
// target=_blank links), JS dialogs are answered instead of silently dismissed, and downloads land
// in ~/Downloads — and all of it is reported in the next action's result so the agent knows what
// just happened instead of acting on a stale picture of the page.
// ---------------------------------------------------------------------------
let context = null
let page = null
const pageIds = new WeakMap() // Page -> stable tabId
const openerOf = new WeakMap() // popup Page -> the Page that opened it (to return to on close)
const followed = new WeakSet() // popups we've already switched to
const lastNavAt = new WeakMap() // Page -> timestamp of its last main-frame navigation
// Page -> { at, req } of its last main-frame navigation REQUEST. On a slow server the request goes out
// long before the new page commits, and Playwright's click/press time out waiting for that commit:
// this tells "the action worked, the page is slow" apart from "the action never happened".
const lastNavReq = new WeakMap()
// Tabs whose renderer crashed ("Aw, Snap!", often out of memory). A crashed Page is not closed, so
// without this it was reused and every later browser tool failed until the tab was closed by hand.
const crashedPages = new WeakSet()
const navRequestedSince = (pg, t0) => (lastNavReq.get(pg)?.at || 0) >= t0
let nextPageId = 1
let pendingEvents = [] // notable things since the last action result: dialog / download / popup

// Dialog policy: 'accept' (default — the agent triggered the action on purpose, so confirm() gets
// OK and prompt() its default value) or 'dismiss'. alert() is always acknowledged. Either way the
// dialog's text is reported back in the action result.
const DIALOG_POLICY = (process.env.GHOST_BROWSER_DIALOGS || 'accept').toLowerCase()

function idOf(pg) {
  if (!pageIds.has(pg)) pageIds.set(pg, nextPageId++)
  return pageIds.get(pg)
}

function noteEvent(ev) {
  pendingEvents.push(ev)
  if (pendingEvents.length > 20) pendingEvents.shift()
}

// Hand back (and clear) the events that piled up since the last action.
export function drainEvents() {
  const out = pendingEvents
  pendingEvents = []
  return out
}

async function saveDownload(dl) {
  const dir = join(homedir(), 'Downloads')
  mkdirSync(dir, { recursive: true })
  const name = dl.suggestedFilename() || 'download'
  const ext = extname(name)
  let target = join(dir, name)
  for (let i = 1; existsSync(target); i++) target = join(dir, `${basename(name, ext)} (${i})${ext}`)
  await dl.saveAs(target)
  return target
}

function trackPage(pg) {
  if (pageIds.has(pg)) return
  idOf(pg)
  pg.on('dialog', async (d) => {
    const type = d.type()
    const message = d.message()
    let action = 'accepted'
    try {
      if (type === 'alert' || type === 'beforeunload') await d.accept()
      else if (DIALOG_POLICY === 'dismiss') {
        await d.dismiss()
        action = 'dismissed'
      } else if (type === 'prompt') await d.accept(d.defaultValue())
      else await d.accept()
    } catch {
      action = 'closed'
    }
    noteEvent({ kind: 'dialog', type, message, action })
  })
  pg.on('download', async (dl) => {
    try {
      noteEvent({ kind: 'download', path: await saveDownload(dl), url: dl.url() })
    } catch (e) {
      noteEvent({ kind: 'download', error: e?.message || String(e), url: dl.url() })
    }
  })
  pg.on('framenavigated', (f) => {
    if (f === pg.mainFrame()) lastNavAt.set(pg, Date.now())
  })
  pg.on('crash', () => {
    crashedPages.add(pg)
    console.warn(`[browser] tab crashed: ${pg.url()}`)
  })
  pg.on('request', (req) => {
    if (req.isNavigationRequest() && req.frame() === pg.mainFrame()) lastNavReq.set(pg, { at: Date.now(), req })
  })
  pg.on('close', () => {
    if (page !== pg) return
    // The tab we were acting on closed (popup finished, window closed): go back to the page that
    // opened it, else the newest one still open.
    const back = openerOf.get(pg)
    const open = context ? context.pages().filter((x) => x !== pg && !x.isClosed()) : []
    page = back && !back.isClosed() ? back : open[open.length - 1] || null
    if (page) noteEvent({ kind: 'tab-closed', url: page.url() })
  })
}

// A page opened BY the current page (popup / target=_blank) becomes the page we act on — that's
// what the user sees happen. Pages we open ourselves (read_pages, close_tab) have no opener and
// stay under the caller's control.
async function followPopup(pg) {
  if (followed.has(pg)) return false
  let opener = null
  try {
    opener = await pg.opener()
  } catch {}
  if (!opener) return false
  followed.add(pg)
  openerOf.set(pg, opener)
  page = pg
  await pg.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
  noteEvent({ kind: 'popup', url: pg.url(), title: await pg.title().catch(() => '') })
  return true
}

function attachContext(ctx) {
  ctx.pages().forEach(trackPage)
  ctx.on('page', (pg) => {
    trackPage(pg)
    followPopup(pg).catch(() => {})
  })
  ctx.on('close', () => {
    if (context === ctx) {
      context = null
      page = null
    }
  })
}

async function ensurePage(retry = true) {
  try {
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
        // The chosen browser isn't installed (or its binary vanished): rather than fail the whole
        // web demo, fall back to Playwright's bundled Chromium once, and say so in the log.
        if (!CHANNEL || !isMissingBrowser(err)) throw enrichLaunchError(err, userDataDir)
        console.warn(`[browser] channel "${CHANNEL}" not available (${String(err?.message || err).split('\n')[0]}) — using the bundled Chromium`)
        try {
          context = await chromium.launchPersistentContext(userDataDir, { ...opts, channel: undefined })
        } catch (err2) {
          throw isMissingBrowser(err2)
            ? new Error(
                `Couldn't launch a browser: Google Chrome (channel "${CHANNEL}") isn't installed and Playwright's own Chromium isn't either. ` +
                  'Install one: sudo apt install google-chrome-stable, or npx playwright install chromium.'
              )
            : enrichLaunchError(err2, userDataDir)
        }
      }
      attachContext(context)
      page = context.pages()[0] || (await context.newPage())
    }
    if (page && crashedPages.has(page)) {
      // Replace a crashed tab with a fresh one (the model is told, and opens the page again).
      const dead = page
      page = null
      noteEvent({ kind: 'tab-crashed', url: dead.url() })
      await dead.close().catch(() => {})
    }
    if (!page || page.isClosed()) {
      const open = context.pages().filter((x) => !x.isClosed() && !crashedPages.has(x))
      page = open[open.length - 1] || (await context.newPage())
    }
    trackPage(page)
    return page
  } catch (err) {
    // The user closed the browser window (or Chrome died) since last time: start fresh once.
    if (retry && context && /closed|disconnected|Target crashed/i.test(err?.message || '')) {
      await context.close().catch(() => {})
      context = null
      page = null
      return ensurePage(false)
    }
    throw err
  }
}

// After an action, give a navigation it may have kicked off a moment to start (Playwright's click
// no longer waits for that itself), follow any popup it opened, and let the new document reach
// DOMContentLoaded — so the NEXT tool call sees the page the user would, not the one that just
// went away. Returns the standard action result.
// `since`: when the action started. A navigation that already committed DURING the action (a fast
// link) still counts, and one whose request went out but whose server hasn't answered yet (slow
// Wi-Fi) is waited for, so the result names the new page instead of the one that's going away.
async function settle(p, beforeUrl, grace = 600, since = Date.now()) {
  const t0 = since
  const navP = p
    .waitForEvent('framenavigated', { predicate: (f) => f === p.mainFrame(), timeout: grace })
    .then(() => true, () => false)
  const popP = context ? context.waitForEvent('page', { timeout: grace }).then((pg) => pg, () => null) : Promise.resolve(null)
  const [started, popup] = await Promise.all([navP, popP])
  if (popup) await followPopup(popup)
  const cur = page && !page.isClosed() ? page : p
  let navStarted = started || (lastNavAt.get(p) || 0) >= t0
  const pending = lastNavReq.get(p)
  if (!navStarted && cur === p && !p.isClosed() && pending && pending.at >= t0 && (lastNavAt.get(p) || 0) < pending.at) {
    // The request is out, the page hasn't committed yet: wait for it (or for it to fail / turn out
    // to be a download), up to 20 s.
    navStarted = await Promise.race([
      p.waitForEvent('framenavigated', { predicate: (f) => f === p.mainFrame(), timeout: 20000 }).then(() => true),
      p.waitForEvent('requestfailed', { predicate: (r) => r === pending.req, timeout: 20000 }).then(() => false),
      p.waitForEvent('download', { timeout: 20000 }).then(() => false)
    ]).catch(() => false)
  }
  if (navStarted || cur !== p) await cur.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {})
  return actionResult(cur, { navigated: navStarted || cur !== p || cur.url() !== beforeUrl })
}

async function actionResult(pg, extra = {}) {
  const alive = pg && !pg.isClosed()
  // Landed on a site the policy forbids (link, redirect, back): say so, hide title/text — the next
  // action's assertPageAllowed() will refuse to act there.
  const g = alive ? checkUrl(pg.url()) : { ok: true }
  if (!g.ok) return { ok: true, blocked: g.reason, url: pg.url(), title: '', tabId: idOf(pg), navigated: !!extra.navigated, events: drainEvents() }
  return {
    ok: true,
    url: alive ? pg.url() : '',
    title: alive ? await pg.title().catch(() => '') : '',
    tabId: alive ? idOf(pg) : null,
    navigated: false,
    ...extra,
    events: drainEvents()
  }
}

// Plain-English lines for the events an action produced (dialogs, downloads, popups).
export function describeEvents(events = []) {
  return events
    .map((e) => {
      if (e.kind === 'dialog') return `A ${e.type} dialog appeared: "${e.message}" — ${e.action}.`
      if (e.kind === 'download') return e.error ? `A download started (${e.url}) but couldn't be saved: ${e.error}` : `Download saved to ${e.path}`
      if (e.kind === 'popup') return `That opened a new tab — now acting on it: ${e.title ? `"${e.title}" · ` : ''}${e.url}`
      if (e.kind === 'tab-closed') return `That tab closed — now acting on ${e.url}`
      if (e.kind === 'tab-crashed') return `The tab showing ${e.url} had crashed (often low memory), so a fresh tab was opened. Open the page again if you still need it.`
      return ''
    })
    .filter(Boolean)
}

// One consistent, agent-readable summary of an action result (used by both brains).
export function formatActionResult(lead, r = {}) {
  const where = r.url ? ` — now at ${r.url}${r.title ? ` — "${r.title}"` : ''}` : ''
  const changed = r.navigated ? ' (page changed — element refs are stale; call browser_get_page again)' : ''
  const why = r.blocked ? `\n${r.blocked}` : '' // landed on a blocked site — say so now, not on the next call
  return [`${lead}${where}${changed}${why}`, ...describeEvents(r.events)].join('\n')
}

function normalizeUrl(url) {
  let u = String(url || '').trim()
  if (!u) throw new Error('browser_navigate needs a url')
  if (/^javascript:/i.test(u)) throw new Error('javascript: URLs cannot be navigated to.')
  if (/^(about|chrome|file|data|blob):/i.test(u)) return u
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'https://' + u.replace(/^\/+/, '') // "example.com" → https://
  return u
}

// Per-action site-policy gate for the Playwright backend (the extension checks tab.url itself):
// refuse to read or act on a page the user blocked / didn't allow-list, however we got there.
function assertPageAllowed(p) {
  const g = checkUrl(p.url())
  if (!g.ok) throw new Error(g.reason)
}

export async function browserNavigate({ url, waitUntil } = {}) {
  url = normalizeUrl(url)
  const gate = checkUrl(url)
  if (!gate.ok) throw new Error(gate.reason)
  if ((await ensureBrowserBackend()) === 'extension') return bridge.sendBrowserCommand('navigate', { url, ...meta() }, 35000)
  const p = await ensurePage()
  const mode = waitUntil === 'networkidle' ? 'networkidle' : 'domcontentloaded'
  const before = p.url()
  try {
    try {
      await p.goto(url, { waitUntil: mode, timeout: 35000 })
    } catch (err) {
      // Chrome's error page from a previous failed load can interrupt the very next goto — retry once.
      if (!/interrupted by another navigation/i.test(err?.message || '')) throw err
      await sleep(300)
      await p.goto(url, { waitUntil: mode, timeout: 35000 })
    }
  } catch (err) {
    const msg = err?.message || String(err)
    const net = msg.match(/net::[A-Z_]+/)?.[0]
    if (net) throw new Error(`Couldn't load ${url} (${net}). Check the address — or the network — and try again.`)
    // Slow page: it's on screen but still loading when the timeout hit — hand it over anyway.
    if (/Timeout/i.test(msg) && p.url() !== before && p.url() !== 'about:blank') {
      return { ...(await actionResult(p, { navigated: true })), partial: true }
    }
    throw err
  }
  await p.waitForLoadState('load', { timeout: 8000 }).catch(() => {})
  return actionResult(p, { navigated: true })
}

// Draw every numbered element's ref onto the page (Set-of-Mark) so the screenshot itself tells
// the model which number to click. Removed right after the capture. Runs in-page.
function drawMarksInPage(marks) {
  const old = document.getElementById('__ghost_som')
  if (old) old.remove()
  const root = document.createElement('div')
  root.id = '__ghost_som'
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;font:bold 11px/1.2 system-ui,sans-serif'
  for (const m of marks) {
    const box = document.createElement('div')
    box.style.cssText = `position:absolute;left:${m.x}px;top:${m.y}px;width:${m.w}px;height:${m.h}px;outline:2px solid #e6194b;outline-offset:-1px;box-sizing:border-box`
    const tag = document.createElement('span')
    tag.textContent = String(m.ref)
    // Label sits just above the box; if the box touches the top edge, tuck it inside instead.
    const inside = m.y < 14
    tag.style.cssText =
      `position:absolute;left:0;top:0;${inside ? '' : 'transform:translateY(-100%);'}` +
      'background:#e6194b;color:#fff;padding:1px 4px;border-radius:2px;white-space:nowrap;line-height:1.2'
    box.appendChild(tag)
    root.appendChild(box)
  }
  ;(document.body || document.documentElement).appendChild(root)
}
function removeMarksInPage() {
  const el = document.getElementById('__ghost_som')
  if (el) el.remove()
}

export async function browserScreenshot({ fullPage, annotate } = {}) {
  if ((await ensureBrowserBackend()) === 'extension') {
    // The extension snapshots the page, draws the [N] marks in-page before the capture (same overlay
    // as below) and returns `marks` (drawn) + `refs` (every numbered element with its
    // data-ghost-ref selector) — remembered here so browser_click { ref: N } acts on what's drawn.
    const r = await bridge.sendBrowserCommand('screenshot', { fullPage: !!fullPage, annotate: !!annotate, ...meta() })
    if (annotate && Array.isArray(r?.refs)) {
      rememberExtensionRefs(r.refs.map((it) => ({ ...it, refSelector: it.selector })))
      return { base64: r.base64, url: r.url, marks: r.marks || [] }
    }
    // An older extension build that can't draw marks: say so (the brains append r.note to the tool
    // output) instead of silently returning a plain image.
    return annotate && !r?.marks
      ? {
          ...r,
          marks: null,
          note: 'annotate is not supported by the loaded Chrome-extension build (reload it from extension/); use browser_get_page refs, browser_click { text } or browser_click_at { x, y } (0..1 fractions)'
        }
      : r
  }
  const p = await ensurePage()
  assertPageAllowed(p)
  let marks = null
  if (annotate) {
    // Fresh snapshot so the numbers on the image match what browser_click { ref } will act on.
    const snap = await takeSnapshot(p, 60)
    marks = [...snap.buttons, ...snap.links, ...snap.fields, ...snap.selects].filter((it) => it.rect && it.rect.w > 2 && it.rect.h > 2)
    await p.evaluate(drawMarksInPage, marks.map((m) => ({ ref: m.ref, ...m.rect }))).catch(() => {})
  }
  let buf
  try {
    // scale:'css' → 1 CSS px = 1 image px even on HiDPI, so click_at fractions line up with what
    // the model sees (and screenshots stay a sane size for the free-tier token budget).
    buf = await p.screenshot({ type: 'png', fullPage: !!fullPage && !annotate, scale: 'css' })
  } finally {
    if (annotate) await p.evaluate(removeMarksInPage).catch(() => {})
  }
  return {
    base64: buf.toString('base64'),
    url: p.url(),
    marks: marks ? marks.map((m) => ({ ref: m.ref, label: m.label || m.href || '' })) : null
  }
}

// Compact legend for an annotated screenshot: "[3] Log In · [4] Search · …"
export function formatMarks(marks) {
  if (!marks?.length) return ''
  return marks.map((m) => `[${m.ref}] ${String(m.label || '').slice(0, 40)}`).join(' · ')
}

// Back / forward / reload in the active tab's own history — the browser's nav buttons, for the
// agent. Extension path runs against your real Chrome tab; Playwright path drives its own page.
export async function browserGoBack() {
  if ((await ensureBrowserBackend()) === 'extension') return bridge.sendBrowserCommand('goBack', { ...meta() }, 35000)
  const p = await ensurePage() // no assertPageAllowed: going back is the way OFF a blocked page
  await p.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  return actionResult(p, { navigated: true })
}

export async function browserGoForward() {
  if ((await ensureBrowserBackend()) === 'extension') return bridge.sendBrowserCommand('goForward', { ...meta() }, 35000)
  const p = await ensurePage()
  await p.goForward({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  return actionResult(p, { navigated: true })
}

export async function browserReload() {
  if ((await ensureBrowserBackend()) === 'extension') return bridge.sendBrowserCommand('reloadTab', { ...meta() }, 35000)
  const p = await ensurePage()
  assertPageAllowed(p)
  await p.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  return actionResult(p, { navigated: true })
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

// Playwright locator from CSS, xpath=..., or role hints — on `root` (the page or a frame).
function resolveLocator(root, selector) {
  const raw = String(selector).trim()
  if (raw.startsWith('xpath=')) return root.locator(raw)
  if (raw.startsWith('//') || raw.startsWith('(')) return root.locator(`xpath=${raw}`)
  return root.locator(normalizeSelector(raw))
}

export function formatPageSnapshot(s) {
  const hasRefs = ['buttons', 'links', 'fields', 'selects'].some((k) => s[k]?.some((it) => it.ref != null))
  const ref = (it) => (it.ref != null ? `[${it.ref}] ` : '')
  const lines = [`# ${s.title || '(no title)'}`, s.url || '']
  if (hasRefs) lines.push('(Act on a numbered element with browser_click / browser_fill { ref: N }.)')
  lines.push('')
  if (s.buttons?.length) {
    lines.push('## Buttons & controls')
    for (const b of s.buttons) {
      const flags = [b.disabled ? 'disabled' : null, b.pressed ? 'pressed' : null, b.expanded === true ? 'expanded' : null].filter(Boolean)
      lines.push(`- ${ref(b)}"${b.label}"${flags.length ? ` (${flags.join(', ')})` : ''}${b.selector && b.ref == null ? ` → ${b.selector}` : ''}`)
    }
    lines.push('')
  }
  if (s.links?.length) {
    lines.push('## Links')
    for (const l of s.links) lines.push(`- ${ref(l)}"${l.label}" → ${l.href}`)
    lines.push('')
  }
  if (s.fields?.length) {
    lines.push('## Input fields')
    for (const f of s.fields) {
      const isCheck = f.type === 'checkbox' || f.type === 'radio'
      const hint = [
        f.type,
        isCheck ? (f.checked ? 'checked' : 'unchecked') : null,
        f.placeholder ? `placeholder "${f.placeholder.slice(0, 40)}"` : null,
        f.value ? `value "${f.value.slice(0, 40)}"` : null,
        f.disabled ? 'disabled' : null
      ]
        .filter(Boolean)
        .join(', ')
      lines.push(`- ${ref(f)}${f.label || f.name || f.selector || '(unlabeled)'}${hint ? ` (${hint})` : ''}`)
    }
    lines.push('')
  }
  if (s.selects?.length) {
    lines.push('## Dropdowns')
    for (const d of s.selects) {
      const opts = (d.options || []).slice(0, 8).join(' | ')
      const sel = d.selected ? ` (selected: "${d.selected}")` : ''
      lines.push(`- ${ref(d)}${d.label || d.name || d.selector || '(unlabeled)'}: ${opts}${d.options?.length > 8 ? ' …' : ''}${sel}`)
    }
    lines.push('')
  }
  if (s.excerpt) {
    lines.push('## Page excerpt')
    lines.push(s.excerpt)
  }
  return lines.join('\n').trim()
}

// ---------------------------------------------------------------------------
// Page snapshot with element refs. Every visible button / link / field / select gets a number
// and a data-ghost-ref attribute, so the agent can say { ref: 12 } instead of guessing a
// selector or hoping a text label is unique. Refs carry the snapshot generation, so a stale
// number from before a page change never silently hits a different element.
// ---------------------------------------------------------------------------
const REF_ATTR = 'data-ghost-ref'
// A number names ONE element for as long as it exists: snapshots keep the numbers they already gave
// (so browser_get_page and an annotated screenshot agree) and new elements get fresh numbers from
// refSeq, which never goes back. So an old number either finds the same element or nothing, never a
// different one. refGen only changes when the backend switches (tags from before don't count).
let refGen = 0
let refSeq = 1
let lastRefs = new Map() // ref -> { label, selector, kind } from recent snapshots
let lastRefsBackend = null // 'playwright' | 'extension' — which backend numbered lastRefs

// Injected in-page (self-contained): tag + describe the interactive elements of ONE frame.
function snapshotInPage({ cap, startRef, gen, attr }) {
  let next = startRef
  const used = new Set() // a cloned node can carry a copy of another element's tag
  const vw = window.innerWidth
  const vh = window.innerHeight
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return false
    const s = getComputedStyle(el)
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'
  }
  // Where the element is on screen (viewport coords), or null when it's scrolled out of view.
  const rectOf = (el) => {
    const r = el.getBoundingClientRect()
    if (r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) return null
    const x = Math.max(0, r.left)
    const y = Math.max(0, r.top)
    return { x, y, w: Math.min(r.right, vw) - x, h: Math.min(r.bottom, vh) - y }
  }
  const byIds = (ids) =>
    norm(
      String(ids)
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.innerText || '')
        .join(' ')
    )
  // Accessible-ish name: aria-label → aria-labelledby → <label> → placeholder/name → own text →
  // icon alt/title. Form fields never use their current value as a name (it isn't one).
  const labelOf = (el) => {
    const aria = norm(el.getAttribute('aria-label'))
    if (aria) return aria
    const lb = el.getAttribute('aria-labelledby')
    if (lb) {
      const t = byIds(lb)
      if (t) return t
    }
    // A <label> that wraps the control also contains the control's own text (a select's options)
    // — strip that so "Country Germany France" reads as "Country".
    const labelText = (lab) => norm((lab.textContent || '').replace(el.textContent || '', ''))
    if (el.labels && el.labels.length) {
      const t = norm([...el.labels].map(labelText).join(' '))
      if (t) return t
    }
    const tag = el.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const wrap = el.closest('label')
      if (wrap) {
        const t = labelText(wrap)
        if (t) return t
      }
      return norm(el.placeholder || el.title || el.getAttribute('name') || '')
    }
    const inner = norm(el.innerText)
    if (inner) return inner.slice(0, 80)
    if (el.value) return norm(el.value).slice(0, 80)
    const t = norm(el.title)
    if (t) return t
    const inside = el.querySelector('[aria-label], img[alt], [title]')
    if (inside) return norm(inside.getAttribute('aria-label') || inside.getAttribute('alt') || inside.getAttribute('title')).slice(0, 80)
    return ''
  }
  const selOf = (el) => {
    if (el.id) return `#${CSS.escape(el.id)}`
    const name = el.getAttribute('name')
    if (name) return `${el.tagName.toLowerCase()}[name="${name.replace(/"/g, '\\"')}"]`
    return ''
  }
  // Keep the number this element already has (same backend generation); otherwise a new one.
  const tag = (el) => {
    const m = /^(\d+):(\d+)$/.exec(el.getAttribute(attr) || '')
    if (m && Number(m[1]) === gen && !used.has(Number(m[2]))) {
      used.add(Number(m[2]))
      return Number(m[2])
    }
    const ref = next++
    used.add(ref)
    el.setAttribute(attr, `${gen}:${ref}`)
    return ref
  }
  const disabledOf = (el) => !!(el.disabled || el.getAttribute('aria-disabled') === 'true')
  const seen = new Set()
  const buttons = []
  const links = []
  const fields = []
  const selects = []
  for (const el of document.querySelectorAll(
    'button, [role="button"], [role="link"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="tab"], [role="option"], [role="switch"], [role="checkbox"], [role="radio"], input[type="submit"], input[type="button"], input[type="reset"], input[type="image"], summary'
  )) {
    if (buttons.length >= cap) break
    if (seen.has(el) || !visible(el)) continue
    const label = labelOf(el)
    if (!label) continue
    seen.add(el)
    const pressed = el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-checked') === 'true'
    const exp = el.getAttribute('aria-expanded')
    buttons.push({
      ref: tag(el),
      label,
      selector: selOf(el),
      disabled: disabledOf(el),
      pressed,
      expanded: exp == null ? undefined : exp === 'true',
      rect: rectOf(el)
    })
  }
  for (const el of document.querySelectorAll('a[href]')) {
    if (links.length >= cap) break
    if (seen.has(el) || !visible(el)) continue
    const label = labelOf(el)
    if (!label) continue
    seen.add(el)
    links.push({ ref: tag(el), label, href: el.href, rect: rectOf(el) })
  }
  for (const el of document.querySelectorAll(
    'input, textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"], [role="combobox"], [role="searchbox"]'
  )) {
    if (fields.length >= cap) break
    if (seen.has(el) || !visible(el)) continue
    const type = el.isContentEditable && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA'
      ? 'editor'
      : String(el.type || el.getAttribute('role') || el.tagName).toLowerCase()
    if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue
    seen.add(el)
    const isCheck = type === 'checkbox' || type === 'radio'
    fields.push({
      ref: tag(el),
      label: labelOf(el),
      name: el.getAttribute('name') || '',
      type,
      placeholder: el.placeholder || '',
      value: isCheck ? '' : norm(el.value ?? el.textContent).slice(0, 40),
      checked: isCheck ? !!el.checked : undefined,
      disabled: disabledOf(el),
      selector: selOf(el),
      rect: rectOf(el)
    })
  }
  for (const el of document.querySelectorAll('select')) {
    if (selects.length >= cap) break
    if (!visible(el)) continue
    selects.push({
      ref: tag(el),
      label: labelOf(el),
      name: el.getAttribute('name') || '',
      selector: selOf(el),
      options: [...el.options].map((o) => o.text.trim()).filter(Boolean),
      selected: el.options[el.selectedIndex]?.text?.trim() || '',
      disabled: disabledOf(el),
      rect: rectOf(el)
    })
  }
  const excerpt = norm(document.body?.innerText).slice(0, 1200)
  return { url: location.href, title: document.title, buttons, links, fields, selects, excerpt, nextRef: next }
}

// Snapshot the page AND every iframe it contains (chat widgets, embeds, OAuth frames), with one
// ref numbering across all of them. Iframe element positions are shifted into main-viewport
// coordinates so annotated screenshots line up.
async function takeSnapshot(p, cap) {
  const gen = refGen
  const out = { url: p.url(), title: await p.title().catch(() => ''), buttons: [], links: [], fields: [], selects: [], excerpt: '' }
  const refs = lastRefsBackend === 'playwright' ? lastRefs : new Map()
  for (const frame of p.frames()) {
    const isMain = frame === p.mainFrame()
    let offset = { x: 0, y: 0 }
    if (!isMain) {
      try {
        const box = await (await frame.frameElement()).boundingBox()
        if (!box) continue // frame isn't rendered
        offset = { x: box.x, y: box.y }
      } catch {
        continue // detached / inaccessible frame
      }
    }
    let r
    try {
      r = await frame.evaluate(snapshotInPage, { cap, startRef: refSeq, gen, attr: REF_ATTR })
    } catch {
      continue
    }
    if (!r) continue
    refSeq = Math.max(refSeq, r.nextRef)
    for (const k of ['buttons', 'links', 'fields', 'selects']) {
      for (const it of r[k]) {
        if (it.rect) {
          it.rect.x += offset.x
          it.rect.y += offset.y
        }
        refs.delete(it.ref) // re-insert: the Map keeps the most recently seen last
        refs.set(it.ref, { label: it.label, selector: it.selector, kind: k })
        out[k].push(it)
      }
    }
    if (isMain) out.excerpt = r.excerpt
    else if (r.excerpt && r.excerpt.length > 40 && out.excerpt.length < 1500) out.excerpt += `\n(frame) ${r.excerpt.slice(0, 300)}`
  }
  for (const k of ['buttons', 'links', 'fields', 'selects']) out[k] = out[k].slice(0, cap)
  for (const old of refs.keys()) {
    if (refs.size <= 3000) break
    refs.delete(old) // only for the "no longer on the page" message; oldest first
  }
  lastRefs = refs
  lastRefsBackend = 'playwright'
  return out
}

async function locateRef(p, ref) {
  const sel = `[${REF_ATTR}="${refGen}:${Number(ref)}"]`
  for (const frame of p.frames()) {
    const loc = frame.locator(sel)
    if (await loc.count().catch(() => 0)) return loc.first()
  }
  return null
}

function refError(ref) {
  const known = lastRefs.get(Number(ref))
  return new Error(
    known
      ? `Element [${ref}] ("${known.label}") is no longer on the page — it changed since the last snapshot. Call browser_get_page again and use the new number.`
      : `Unknown element ref [${ref}] — it may be from a previous page or browser backend. Call browser_get_page again and use one of its numbers, or act by visible text with { text } / by position with browser_click_at.`
  )
}

// Extension backend: record the numbered elements of a getPage snapshot / annotated screenshot so
// { ref: N } resolves to the `[data-ghost-ref=…]` selector the extension tagged them with. Links
// carry no selector on older extension builds — those fall back to their label.
function rememberExtensionRefs(items) {
  const refs = new Map()
  for (const it of items || []) {
    if (it.ref == null) continue
    refs.set(Number(it.ref), { label: it.label, selector: it.refSelector || it.selector || '', kind: it.kind })
  }
  lastRefs = refs
  lastRefsBackend = 'extension'
  refGen++
}

// Extension backend: translate a ref from the last EXTENSION snapshot into the data-ghost-ref
// selector (or label) it was recorded with. Refs numbered by a Playwright snapshot never apply.
function refToExtensionArgs({ ref, text, selector }) {
  if (ref == null || ref === '') return { text, selector }
  if (lastRefsBackend !== 'extension') throw refError(ref)
  const k = lastRefs.get(Number(ref))
  if (!k) throw refError(ref)
  return k.selector ? { selector: k.selector } : { text: k.label }
}

// Extension backend: a ref-based action that fails with "not found" means the page changed since
// the snapshot — give the same re-snapshot guidance as the Playwright path instead of leaking the
// internal data-ghost-ref selector the bridge complains about.
async function withRefError(ref, fn) {
  try {
    return await fn()
  } catch (e) {
    if (ref != null && ref !== '' && /not found/i.test(e?.message || '')) throw refError(ref)
    throw e
  }
}

// A locator (on `root`, the page or a frame) restricted to elements Playwright counts as
// visible — so we never commit to a hidden / zero-size duplicate that would just time out.
function vis(root) {
  return root.locator(':visible')
}

// Find the best clickable element for some visible text, searching the main page AND every
// iframe (chat widgets, OAuth popups, embeds render in frames — page.locator never crosses
// into them). Exact accessible-name matches win over partial ones ("Edit" beats "Edit profile"),
// then a real control beats any element that merely contains the text.
// Returns a single-element locator, or null if nothing visible matches.
async function findClickable(page, text) {
  const roles = ['button', 'link', 'menuitem', 'tab', 'option', 'checkbox', 'radio', 'switch']
  for (const exact of [true, false]) {
    for (const frame of page.frames()) {
      const candidates = roles.map((r) => frame.getByRole(r, { name: text, exact }))
      if (!exact) candidates.push(frame.getByText(text, { exact: false }))
      for (const loc of candidates) {
        const hit = loc.and(vis(frame)).first()
        if (await hit.count().catch(() => 0)) return hit
      }
    }
  }
  return null
}

// Same idea for form fields: by <label>, placeholder, or accessible name — across frames.
async function findField(page, label) {
  for (const exact of [true, false]) {
    for (const frame of page.frames()) {
      const candidates = [
        frame.getByLabel(label, { exact }),
        frame.getByPlaceholder(label, { exact }),
        frame.getByRole('textbox', { name: label, exact }),
        frame.getByRole('combobox', { name: label, exact }),
        frame.getByRole('searchbox', { name: label, exact }),
        frame.getByRole('checkbox', { name: label, exact }),
        frame.getByRole('radio', { name: label, exact })
      ]
      for (const loc of candidates) {
        const hit = loc.and(vis(frame)).first()
        if (await hit.count().catch(() => 0)) return hit
      }
    }
  }
  return null
}

// Resolve the element an action targets — by snapshot ref, visible text/label, or CSS/xpath
// selector (selectors are searched in every frame too; a visible match wins over a hidden one).
async function resolveTarget(page, { ref, text, selector }, kind = 'click') {
  if (ref != null && ref !== '') {
    if (lastRefsBackend !== 'playwright') throw refError(ref) // a number from the other backend
    const loc = await locateRef(page, ref)
    if (!loc) throw refError(ref)
    return loc
  }
  if (text != null && String(text).trim() !== '') {
    const loc = kind === 'fill' ? await findField(page, String(text)) : await findClickable(page, String(text))
    if (!loc) {
      const e = new Error(`no visible ${kind === 'fill' ? 'field' : 'clickable element'} matched "${text}"`)
      e.ghostNotFound = true
      throw e
    }
    return loc
  }
  if (selector != null && String(selector).trim() !== '') {
    let hidden = null
    for (const frame of page.frames()) {
      const base = resolveLocator(frame, selector)
      const shown = base.and(vis(frame)).first()
      if (await shown.count().catch(() => 0)) return shown
      if (!hidden && (await base.count().catch(() => 0))) hidden = base.first()
    }
    return hidden || resolveLocator(page, selector).first()
  }
  const verb = kind === 'fill' ? 'browser_fill' : kind === 'hover' ? 'browser_hover' : 'browser_click'
  throw new Error(`${verb} needs { ref } (a number from browser_get_page), { ${kind === 'fill' ? 'label' : 'text'} } (visible text), or { selector } (CSS).`)
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

// Turn Playwright's cryptic selector/timeout errors into guidance the agent can act on,
// including the page's currently-clickable elements so it can self-correct in one step.
async function clarifyClickError(page, err, { selector, text, ref }) {
  const msg = err?.message || String(err)
  if (ref != null && /no longer on the page|Unknown element ref/.test(msg)) return err
  if (/unknown engine|parsing css selector|unexpected token|not a valid selector|malformed/i.test(msg)) {
    return new Error(
      `Invalid selector ${JSON.stringify(selector)}. Do NOT use jQuery selectors (:contains, :visible, :eq, :first). ` +
        'To click by visible text, call browser_click with { text: "Log In" }, or by number with { ref: N } from browser_get_page. ' +
        'Otherwise use a standard CSS selector: #id, .class, or [attribute] such as [aria-label="Log In"] or [data-action="login"].'
    )
  }
  if (err?.ghostNotFound || /timeout|not found|no element|not visible|intercept|waiting for/i.test(msg)) {
    const what = ref != null ? `element [${ref}]` : text ? `text "${text}"` : `selector ${JSON.stringify(selector)}`
    const clickables = await listClickables(page).catch(() => [])
    const list = clickables.length
      ? ` The visible, clickable elements right now are: ${clickables.map((c) => `"${c}"`).join(', ')}.`
      : ''
    return new Error(
      `Couldn't act on ${what} — it wasn't found or wasn't ready in time.${list} ` +
        'Call browser_get_page and use the element\'s { ref: N }, retry with its EXACT visible text, ' +
        'or take browser_screenshot { annotate: true } and click the number you see.'
    )
  }
  return err
}

export async function browserClick({ ref, selector, text, double, button = 'left' } = {}) {
  if ((await ensureBrowserBackend()) === 'extension') {
    const t = refToExtensionArgs({ ref, text, selector })
    return withRefError(ref, () => bridge.sendBrowserCommand('click', { ...t, double: !!double, button, ...meta() }))
  }
  const p = await ensurePage()
  assertPageAllowed(p)
  const before = p.url()
  const t0 = Date.now()
  const clickOpts = { timeout: 12000, button: button === 'right' ? 'right' : button === 'middle' ? 'middle' : 'left' }
  try {
    const loc = await resolveTarget(p, { ref, text, selector }, 'click')
    await loc.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {})
    if (double) await loc.dblclick({ timeout: 12000 })
    else {
      try {
        await loc.click(clickOpts)
      } catch (err) {
        if (/intercept|not stable|obscur/i.test(err?.message || '')) {
          await loc.click({ ...clickOpts, timeout: 4000, force: true }) // overlay was in the way — push through
        } else throw err
      }
    }
  } catch (err) {
    // The click happened and started loading a slow page: Playwright timed out waiting for it to
    // commit. That's success, not "not found" (the model would click again).
    if (!(/timeout/i.test(err?.message || '') && navRequestedSince(p, t0))) throw await clarifyClickError(p, err, { selector, text, ref })
  }
  return settle(p, before, 600, t0)
}

// Hover an element — the only way to open hover-driven menus (nav dropdowns, row action icons,
// tooltips) before clicking what appears.
export async function browserHover({ ref, selector, text } = {}) {
  if ((await ensureBrowserBackend()) === 'extension') {
    const t = refToExtensionArgs({ ref, text, selector })
    const r = await withRefError(ref, () => bridge.sendBrowserCommand('hover', { ...t, ...meta() }))
    await sleep(250) // let a hover menu open before the agent looks
    // Keep the events (dialogs the guard/CDP answered) so a hover-raised dialog is reported now,
    // not on the next action.
    return { ok: true, url: r?.url || '', events: r?.events || [] }
  }
  const p = await ensurePage()
  assertPageAllowed(p)
  try {
    const loc = await resolveTarget(p, { ref, text, selector }, 'hover')
    await loc.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {})
    await loc.hover({ timeout: 8000 })
  } catch (err) {
    throw await clarifyClickError(p, err, { selector, text, ref })
  }
  await sleep(250) // let a hover menu open before the agent looks
  return actionResult(p)
}

export async function browserFill({ ref, selector, value, label, pressEnter } = {}) {
  if ((await ensureBrowserBackend()) === 'extension') {
    const t = refToExtensionArgs({ ref, text: label, selector })
    const r = await withRefError(ref, () => bridge.sendBrowserCommand('fill', { selector: t.selector, label: t.text, value, ...meta() }))
    if (pressEnter) {
      // Enter usually submits/navigates: report the post-Enter url and any dialogs from BOTH steps.
      const pk = await bridge.sendBrowserCommand('pressKey', { keys: 'Enter', ...meta() }, 30000)
      return { ...(r || {}), ...(pk || {}), events: [...(r?.events || []), ...(pk?.events || [])] }
    }
    return r
  }
  const p = await ensurePage()
  assertPageAllowed(p)
  const val = value == null ? '' : String(value)
  const before = p.url()
  let enterAt = Date.now()
  try {
    const target = await resolveTarget(p, { ref, text: label, selector }, 'fill')
    await target.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {})
    const info = await target
      .evaluate((el) => ({ tag: el.tagName, type: String(el.type || '').toLowerCase(), label: (el.innerText || el.value || '').trim().slice(0, 60) }))
      .catch(() => ({ tag: '', type: '' }))
    // Never "fill" a link or a button: the old fallback clicked it, so a wrong number opened a random
    // page and still reported "Filled".
    if (info.tag === 'A' || info.tag === 'BUTTON' || (info.tag === 'INPUT' && ['submit', 'button', 'reset', 'image'].includes(info.type))) {
      const what = `${ref != null && ref !== '' ? `[${ref}] ` : ''}${info.label ? `"${info.label}" ` : ''}`
      throw new Error(
        `${what}is a ${info.tag === 'A' ? 'link' : 'button'}, not a text field. Use browser_click to click it, or call browser_get_page and use a number from its fields list.`
      )
    }
    if (info.tag === 'SELECT') {
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
    } else if (info.type === 'checkbox' || info.type === 'radio') {
      // value decides the state: "false"/"no"/"off"/"unchecked" clears it, anything else sets it
      await target.setChecked(!/^(false|no|off|0|unchecked|uncheck)$/i.test(val.trim()), { timeout: 12000 })
    } else {
      try {
        await target.fill(val, { timeout: 12000 })
      } catch (err) {
        // Not a native input (custom editor / div-based field): focus it and type instead.
        if (/not an? <input>|not.*editable|contenteditable/i.test(err?.message || '')) {
          await target.click({ timeout: 4000 })
          await p.keyboard.press('Control+A')
          await p.keyboard.type(val)
        } else throw err
      }
    }
    if (pressEnter) {
      enterAt = Date.now()
      await target.press('Enter', { timeout: 4000 }).catch(async () => {
        // Press Enter again only if the first one never got through. On a slow server it did (the
        // form's request is out) and Playwright just timed out waiting: a second Enter would submit
        // the form twice.
        if (!navRequestedSince(p, enterAt)) await p.keyboard.press('Enter')
      })
    }
  } catch (err) {
    throw await clarifyClickError(p, err, { selector, text: label, ref })
  }
  return pressEnter ? settle(p, before, 600, enterAt) : actionResult(p)
}

export async function browserGetPage({ limit } = {}) {
  const cap = Math.min(Number(limit) || 40, 60)
  if ((await ensureBrowserBackend()) === 'extension') {
    const r = await bridge.sendBrowserCommand('getPage', { limit: cap, ...meta() })
    // The extension numbers its items (ref + a data-ghost-ref selector); remember them so
    // browser_click / browser_fill / browser_hover { ref } resolve on this backend too.
    rememberExtensionRefs(['buttons', 'links', 'fields', 'selects'].flatMap((k) => (r?.[k] || []).map((it) => ({ ...it, kind: k }))))
    return { ...r, formatted: formatPageSnapshot(r) }
  }
  const p = await ensurePage()
  assertPageAllowed(p)
  const snapshot = await takeSnapshot(p, cap)
  return { ...snapshot, formatted: formatPageSnapshot(snapshot) }
}

export async function browserGetText({ offset } = {}) {
  const off = Math.max(0, Number(offset) || 0)
  if ((await ensureBrowserBackend()) === 'extension') return bridge.sendBrowserCommand('getText', { offset: off, ...meta() })
  const p = await ensurePage()
  assertPageAllowed(p)
  // Main document first, then any iframe with real content (chat widgets, embeds, OAuth frames).
  const parts = []
  for (const frame of p.frames()) {
    try {
      const t = await frame.evaluate(() => document.body?.innerText || '')
      if (frame === p.mainFrame()) parts.unshift(t)
      else if (t.trim().length > 40) parts.push(t)
    } catch {}
  }
  const text = parts.join('\n\n--- (frame) ---\n\n')
  const slice = text.slice(off, off + 20000)
  const nextOffset = off + slice.length < text.length ? off + slice.length : null
  return { url: p.url(), title: await p.title(), text: slice, offset: off, nextOffset, totalChars: text.length }
}

// Injected in-page: find a phrase in the page text, return snippets around each hit, and scroll
// the first on-screen occurrence into view.
function findInPage({ needle, max }) {
  const body = document.body?.innerText || ''
  const hay = body.toLowerCase()
  const n = needle.toLowerCase()
  const matches = []
  let count = 0
  for (let i = hay.indexOf(n); i !== -1; i = hay.indexOf(n, i + n.length)) {
    count++
    if (matches.length < max) {
      const s = Math.max(0, i - 100)
      const e = Math.min(body.length, i + n.length + 100)
      matches.push((s > 0 ? '…' : '') + body.slice(s, e).replace(/\s+/g, ' ').trim() + (e < body.length ? '…' : ''))
    }
  }
  let scrolled = false
  if (count) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.nodeValue.toLowerCase().includes(n)) continue
      const el = node.parentElement
      if (el && el.getBoundingClientRect().width > 0) {
        el.scrollIntoView({ block: 'center' })
        scrolled = true
        break
      }
    }
  }
  return { count, matches, scrolled }
}

// Find text on the current page (like Ctrl+F): how many hits, a snippet around each, and the
// page scrolled to the first one — far cheaper than paging through browser_get_text.
export async function browserFind({ text, limit } = {}) {
  const needle = String(text ?? '').trim()
  if (!needle) throw new Error('browser_find needs the "text" to look for')
  if ((await ensureBrowserBackend()) === 'extension') {
    return bridge.sendBrowserCommand('find', { needle, max: Math.min(Number(limit) || 5, 20), ...meta() })
  }
  const p = await ensurePage()
  assertPageAllowed(p)
  const r = await p.evaluate(findInPage, { needle, max: Math.min(Number(limit) || 5, 20) })
  return { ...r, url: p.url() }
}

// Open several URLs at once and return each page's readable text — the fast path for multi-page
// research. Pages load in parallel (separate tabs in your real Chrome, or separate Playwright
// pages in the fallback), so N pages cost roughly one page's wait instead of N sequential trips.
export async function browserReadPages({ urls, keepOpen } = {}) {
  const list = (Array.isArray(urls) ? urls : []).map(String).filter(Boolean).slice(0, 8)
  if (!list.length) throw new Error('browser_read_pages needs a non-empty "urls" array')

  if ((await ensureBrowserBackend()) === 'extension') {
    // Normalize first ("example.com" → https://…) so the extension never opens a bare domain as an
    // extension-relative path, and the site check sees the real host. Bad entries stay in place
    // as error rows; only valid URLs go to the bridge, then everything is merged back in order.
    const entries = list.map((raw) => {
      try {
        return { url: normalizeUrl(raw) }
      } catch (e) {
        return { url: raw, title: '', text: '', error: e.message }
      }
    })
    const valid = entries.filter((e) => !e.error).map((e) => e.url)
    const r = valid.length ? await bridge.sendBrowserCommand('readPages', { urls: valid, keepOpen: keepOpen !== false, ...meta() }, 60000) : { pages: [] }
    const got = Array.isArray(r?.pages) ? r.pages : []
    let i = 0
    return { ...r, pages: entries.map((e) => (e.error ? e : got[i++] || { url: e.url, title: '', text: '', error: 'no result' })) }
  }

  // Playwright fallback: open each page concurrently in the persistent context.
  await ensurePage() // make sure context exists
  const pages = await Promise.all(
    list.map(async (raw) => {
      let url
      try {
        url = normalizeUrl(raw)
      } catch (e) {
        return { url: raw, title: '', text: '', error: e.message }
      }
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
  if ((await ensureBrowserBackend()) === 'extension') return bridge.sendBrowserCommand('clickAt', { x: Number(x), y: Number(y), ...meta() })
  const p = await ensurePage()
  assertPageAllowed(p)
  const before = p.url()
  const { w, h } = await p.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
  const px = Number(x) <= 1 ? Number(x) * w : Number(x)
  const py = Number(y) <= 1 ? Number(y) * h : Number(y)
  const t0 = Date.now()
  await p.mouse.click(px, py)
  return settle(p, before, 600, t0)
}

// Drag-and-drop. Two modes:
//   • element → element: pass { fromSelector, toSelector } (standard CSS).
//   • point → point:     pass { from:{x,y}, to:{x,y} } as viewport fractions (0..1) or pixels —
//     the vision-grounded mode (locate the handle in a screenshot, drag it to the target point).
// Playwright backend only for now (the active backend when dev-mode extensions are blocked).
export async function browserDrag({ fromSelector, toSelector, from, to } = {}) {
  if ((await ensureBrowserBackend()) === 'extension')
    throw new Error("browser_drag isn't available on the Chrome-extension backend — use browser_click_at on the handle and target, or browser_scroll.")
  const p = await ensurePage()
  assertPageAllowed(p)
  if (fromSelector && toSelector) {
    await p.locator(fromSelector).first().dragTo(p.locator(toSelector).first())
    return { ...(await actionResult(p)), mode: 'element' }
  }
  if (from && to && from.x != null && to.x != null) {
    const { w, h } = await p.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
    const toPx = (v, span) => (Number(v) <= 1 ? Number(v) * span : Number(v))
    const fx = toPx(from.x, w)
    const fy = toPx(from.y, h)
    const tx = toPx(to.x, w)
    const ty = toPx(to.y, h)
    await p.mouse.move(fx, fy)
    await p.mouse.down()
    await p.mouse.move((fx + tx) / 2, (fy + ty) / 2, { steps: 6 }) // move in steps so DnD libs register it
    await p.mouse.move(tx, ty, { steps: 12 })
    await p.mouse.up()
    return { ...(await actionResult(p)), mode: 'point' }
  }
  throw new Error('browser_drag needs { fromSelector, toSelector } or { from:{x,y}, to:{x,y} }')
}

// Scroll the page (or a specific scrollable element) to reveal off-screen content / load more.
export async function browserScroll({ direction = 'down', amount, selector } = {}) {
  if ((await ensureBrowserBackend()) === 'extension') return bridge.sendBrowserCommand('scroll', { direction, amount, selector, ...meta() })
  const p = await ensurePage()
  assertPageAllowed(p)
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
  await sleep(150) // let lazy content render before the agent looks
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
      if (lp === 'return') return 'Enter'
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
    const r = await bridge.sendBrowserCommand('pressKey', { keys, text, clipboardText: clipboard.readText(), ...meta() }, 30000)
    if (r && typeof r.copied === 'string' && r.copied) {
      try {
        clipboard.writeText(r.copied)
      } catch {}
    }
    return r
  }
  const p = await ensurePage()
  assertPageAllowed(p)
  const before = p.url()
  const t0 = Date.now()
  if (hasText) await p.keyboard.type(String(text))
  let submitted = hasText && /\n$/.test(String(text))
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
    } else {
      const k = normalizeCombo(combo)
      if (/(^|\+)Enter$/.test(k)) submitted = true
      await p.keyboard.press(k)
    }
  }
  // Enter often submits a form / follows a link — let that navigation land before returning.
  return submitted ? settle(p, before, 600, t0) : actionResult(p)
}

// Wait until a selector or visible text appears — for pages that render content after load
// (SPAs, spinners, lazy lists, post-login redirects). Looks in every frame. Resolves when
// found, throws a plain-English timeout otherwise.
export async function browserWaitFor({ selector, text, timeoutMs } = {}) {
  const hasText = text != null && String(text).trim() !== ''
  if (!selector && !hasText) throw new Error('browser_wait_for needs a "selector" or "text" to wait for')
  const ms = Math.min(Number(timeoutMs) || 10000, 30000)
  if ((await ensureBrowserBackend()) === 'extension') {
    // The extension caps a wait at ~24s (it can't poll the bridge while a command runs, and the bridge
    // counts it as gone after 30s of silence); give the bridge call headroom beyond that so it never
    // times out first.
    const extMs = Math.min(ms, EXT_WAIT_CAP)
    return bridge.sendBrowserCommand('waitFor', { selector, text, timeoutMs: extMs, ...meta() }, extMs + 6000)
  }
  const p = await ensurePage()
  assertPageAllowed(p)
  const needle = hasText ? String(text).toLowerCase() : null
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    for (const frame of p.frames()) {
      try {
        if (selector) {
          if (await resolveLocator(frame, selector).and(vis(frame)).count()) return actionResult(p)
        } else if (await frame.evaluate((t) => (document.body?.innerText || '').toLowerCase().includes(t), needle)) {
          return actionResult(p)
        }
      } catch (e) {
        if (/parsing css selector|unexpected token|not a valid selector|unknown engine/i.test(e?.message || ''))
          throw new Error(`Invalid selector ${JSON.stringify(selector)} — use standard CSS, or wait for visible { text } instead.`)
      }
    }
    await sleep(250)
  }
  throw new Error(
    `Timed out after ${Math.round(ms / 1000)}s waiting for ${selector ? `selector ${JSON.stringify(selector)}` : `text "${text}"`} to appear. ` +
      'Call browser_get_page or browser_screenshot to see what the page shows instead.'
  )
}

// Wait for a page navigation to complete (after a click that triggers a page load). Actions
// already wait for the navigation they trigger, so this is for slow pages that are still loading
// (or a redirect chain) — if nothing starts within a few seconds, it returns rather than stalling.
export async function browserWaitForNavigation({ timeoutMs } = {}) {
  const ms = Math.min(Number(timeoutMs) || 30000, 60000)
  if ((await ensureBrowserBackend()) === 'extension') {
    const extMs = Math.min(ms, EXT_WAIT_CAP) // see browserWaitFor
    return bridge.sendBrowserCommand('waitForNavigation', { timeoutMs: extMs, ...meta() }, extMs + 6000)
  }
  const p = await ensurePage()
  const before = p.url()
  const recent = Date.now() - (lastNavAt.get(p) || 0) < 3000 // one just happened — don't wait for another
  let started = recent
  if (!recent) {
    started = await p
      .waitForEvent('framenavigated', { predicate: (f) => f === p.mainFrame(), timeout: Math.min(ms, 8000) })
      .then(() => true, () => false)
  }
  await p.waitForLoadState('domcontentloaded', { timeout: ms }).catch(() => {})
  await p.waitForLoadState('load', { timeout: 5000 }).catch(() => {})
  return actionResult(p, { navigated: started || p.url() !== before })
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
// Closing a popup returns to the page that opened it.
export async function browserCloseTab() {
  if ((await ensureBrowserBackend()) === 'extension') return bridge.sendBrowserCommand('closeTab', { ...meta() }, 15000)
  await ensurePage()
  const closing = page
  const others = context.pages().filter((x) => x !== closing && !x.isClosed())
  if (!others.length) {
    page = await context.newPage() // don't kill the last page — open a blank one and go there
    trackPage(page)
  } else {
    const back = openerOf.get(closing)
    page = back && !back.isClosed() ? back : others[others.length - 1]
  }
  await closing.close().catch(() => {})
  return actionResult(page)
}

// List every open tab — url, title, which window, and whether it's playing audio (audible) — so the
// agent can see what's open / what's playing and then pin one with browser_use_tab.
// Tabs on blocked / non-allow-listed sites are listed (so the agent can still pin or close them)
// but their url and title are redacted.
function redactBlockedTab(t) {
  return checkUrl(t.url).ok ? t : { ...t, url: '(blocked site)', title: '', blocked: true }
}

export async function browserListTabs() {
  if ((await ensureBrowserBackend()) === 'extension') {
    const r = await bridge.sendBrowserCommand('listTabs', { ...meta() }, 15000)
    return { ...r, tabs: (r?.tabs || []).map(redactBlockedTab) }
  }
  // Playwright fallback: enumerate the context's pages (no per-tab audible signal here).
  await ensurePage()
  const pages = context.pages().filter((pg) => !pg.isClosed())
  const tabs = await Promise.all(
    pages.map(async (pg) =>
      redactBlockedTab({
        tabId: idOf(pg),
        windowId: 0,
        url: pg.url(),
        title: await pg.title().catch(() => ''),
        active: pg === page,
        audible: false,
        muted: false,
        focusedWindow: pg === page
      })
    )
  )
  return { tabs }
}

// Make a tab (by tabId from browser_list_tabs) the one actions act on. null = unpin.
export async function useTab(tabId) {
  if ((await ensureBrowserBackend()) === 'extension') {
    const set = setTargetTab(tabId)
    return { ok: true, tabId: set, pinned: set != null }
  }
  await ensurePage()
  if (tabId == null) return { ...(await actionResult(page)), pinned: false }
  const pg = context.pages().find((x) => !x.isClosed() && idOf(x) === Number(tabId))
  if (!pg) throw new Error(`No open tab with id ${tabId}. Call browser_list_tabs to see the current ids.`)
  page = pg
  await pg.bringToFront().catch(() => {})
  return { ...(await actionResult(pg)), pinned: true }
}

// Connected executor browsers (separate Chrome/Brave/profiles) from the bridge — for picking which
// one to drive when more than one is connected.
export function listBrowsers() {
  return bridge.listDevices()
}
export function useBrowser(id) {
  return bridge.selectDevice(id)
}

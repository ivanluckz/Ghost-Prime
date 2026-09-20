// Ghost-Prime browser bridge — service worker.
// Long-polls the app's local bridge (127.0.0.1) for commands, runs them against the active tab,
// and posts results back. The app side lives in src/main/tools/browser-bridge.js.

// glow: highlight the page while Ghost acts on it. quietDebugger: avoid chrome.debugger entirely
// (no "being debugged" banner) at the cost of canvas-editor typing + background screenshots.
const DEFAULTS = { host: '127.0.0.1', port: 8731, token: 'ghost-local', glow: true, quietDebugger: false }
let cfg = { ...DEFAULTS }
let looping = false

const base = () => `http://${cfg.host || '127.0.0.1'}:${cfg.port}`
const q = (path) => `${base()}${path}?token=${encodeURIComponent(cfg.token)}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function loadCfg() {
  try {
    cfg = await chrome.storage.sync.get(DEFAULTS)
  } catch {
    cfg = { ...DEFAULTS }
  }
}

// Stable per-install identity for the bridge's device registry, so two browsers / profiles running
// this extension show up as two devices (browser_list_browsers) instead of collapsing into one and
// evicting each other's held poll. storage.local is per-profile (sync would share the id across
// signed-in profiles; session wouldn't survive a browser restart).
let deviceId = null
async function loadDeviceId() {
  if (deviceId) return deviceId
  try {
    const s = await chrome.storage.local.get('deviceId')
    deviceId = s.deviceId || crypto.randomUUID()
    if (!s.deviceId) await chrome.storage.local.set({ deviceId })
  } catch {
    deviceId = deviceId || crypto.randomUUID()
  }
  return deviceId
}
// Browser brand for the device list ("Chrome", "Brave", "Microsoft Edge", …).
function browserBrand() {
  const brands = (navigator.userAgentData && navigator.userAgentData.brands) || []
  return brands.map((b) => b.brand).find((b) => !/Not.?A.?Brand|Chromium/i.test(b)) || 'Chrome'
}

// Ghost-Prime works in its OWN tab, inside a dedicated "Ghost-Prime" tab group — so it never
// hijacks the tab you're looking at (no more loading Gmail over your YouTube tab). When the app
// turns on "current tab" mode it instead acts on the tab you're focused on (see resolveTab).
let ghostTabId = null
let ghostGroupId = null
const GHOST_GROUP_TITLE = 'Ghost-Prime'

// MV3 service workers are torn down when idle and restarted on demand, which wipes the two ids
// above — so without this, every restart "forgot" its tab and created a brand-new one (that's the
// pile-of-Ghost-tabs bug). Persist in session storage (survives SW restarts, clears when Chrome
// fully closes — which is fine, since tab ids don't survive a browser restart anyway).
async function loadGhostRefs() {
  try {
    const s = await chrome.storage.session.get(['ghostTabId', 'ghostGroupId'])
    if (s.ghostTabId != null) ghostTabId = s.ghostTabId
    if (s.ghostGroupId != null) ghostGroupId = s.ghostGroupId
  } catch {}
}
async function saveGhostRefs() {
  try {
    await chrome.storage.session.set({ ghostTabId, ghostGroupId })
  } catch {}
}

async function tabExists(id) {
  if (id == null) return false
  try {
    await chrome.tabs.get(id)
    return true
  } catch {
    return false
  }
}

async function groupExists(id) {
  if (id == null) return false
  try {
    await chrome.tabGroups.get(id)
    return true
  } catch {
    return false
  }
}

// If we lost our ids but a "Ghost-Prime" group still exists on screen, adopt it (and one of its
// tabs) instead of spawning yet another. The second line of defense against duplicate tabs/groups.
async function recoverGhostTab() {
  try {
    const groups = await chrome.tabGroups.query({ title: GHOST_GROUP_TITLE })
    if (groups.length) {
      ghostGroupId = groups[0].id
      const tabs = await chrome.tabs.query({ groupId: ghostGroupId })
      if (tabs.length) {
        ghostTabId = tabs[0].id
        return true
      }
    }
  } catch {}
  return false
}

async function addToGroup(tabId) {
  try {
    if (await groupExists(ghostGroupId)) {
      await chrome.tabs.group({ tabIds: tabId, groupId: ghostGroupId })
    } else {
      ghostGroupId = await chrome.tabs.group({ tabIds: tabId })
      await chrome.tabGroups.update(ghostGroupId, { title: GHOST_GROUP_TITLE, color: 'cyan' })
    }
  } catch {
    // tab groups unsupported / failed — not fatal; the tab still works, just ungrouped
  }
}

// Ghost's working tab — created in its group if missing/closed. active=true brings it forward
// (only when GHOST_BROWSER_FOCUS is on, so you can watch); by default it stays in the background.
async function ghostTab(active = false) {
  await loadGhostRefs() // the SW may have restarted since the last command
  if (!(await tabExists(ghostTabId))) {
    if (!(await recoverGhostTab()) || !(await tabExists(ghostTabId))) {
      const tab = await chrome.tabs.create({ url: 'about:blank', active })
      ghostTabId = tab.id
      await addToGroup(tab.id)
    }
  }
  if (active) await chrome.tabs.update(ghostTabId, { active: true }).catch(() => {})
  await saveGhostRefs()
  return chrome.tabs.get(ghostTabId)
}

// The currently focused tab — what "act on the tab I'm looking at" targets. Falls back to Ghost's
// own tab if there's no usable active tab (e.g. only the side panel is focused).
async function activeTab() {
  try {
    let [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (!t) [t] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (t && t.id != null) return t
  } catch {}
  return null
}

// Pick the tab a command runs against. target:'active' → your focused tab; otherwise Ghost's own
// tab. We DON'T bring the tab to the foreground — every action (navigate, type, click, scroll, even
// screenshot) runs against the tab in the BACKGROUND, so the bot keeps working while you're on a
// different tab or in another app. Set GHOST_BROWSER_FOCUS=1 (app side → args.focus) to bring
// Ghost's tab forward so you can watch it work.
async function resolveTab(cmd, args) {
  // Explicit tab pin (from browser_use_tab) wins — lets the agent act on a chosen tab/window even
  // when several Chrome windows are open.
  if (args && args.tabId != null) {
    try {
      const t = await chrome.tabs.get(args.tabId)
      if (t && t.id != null) return t
    } catch {}
  }
  if (args && args.target === 'active') {
    const t = await activeTab()
    if (t) return t
  }
  return ghostTab(!!(args && args.focus))
}

// ---- Per-site permissions ----
// The app sends the current policy with every tab-touching command (args.policy), so the check
// happens where the real URL is known and needs no separate sync. Shape:
//   { mode: 'open' | 'strict', allow: ['github.com', ...], block: ['*.bank.com', ...] }
function hostMatches(host, pattern) {
  if (!host || !pattern) return false
  host = host.toLowerCase().replace(/^www\./, '')
  let p = String(pattern).toLowerCase().trim().replace(/^www\./, '')
  if (p.startsWith('*.')) p = p.slice(2)
  if (!p) return false
  return host === p || host.endsWith('.' + p)
}
function siteCheck(policy, url) {
  if (!policy || !url) return { ok: true }
  let host
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: true } // about:/chrome:/file: — not gated here
    host = u.hostname
  } catch {
    return { ok: true }
  }
  const block = policy.block || []
  if (block.some((p) => hostMatches(host, p))) {
    return { ok: false, reason: `${host} is on Ghost-Prime's blocked-sites list. Remove it in the app (Settings → Site access) to act here.` }
  }
  if (policy.mode === 'strict') {
    const allow = policy.allow || []
    if (!allow.some((p) => hostMatches(host, p))) {
      return { ok: false, reason: `Site access is in strict mode and ${host} isn't on the allow-list. Add it in the app (Settings → Site access) to act here.` }
    }
  }
  return { ok: true }
}

function waitComplete(tabId, timeout = 30000) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(to)
      chrome.tabs.onUpdated.removeListener(listener)
      resolve()
    }
    const to = setTimeout(done, timeout)
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') done()
    }
    chrome.tabs.onUpdated.addListener(listener)
  })
}

// Run an injected function in every frame; return the array of per-frame results.
function injectAllFrames(tabId, func, arg) {
  return chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func, args: [arg] })
}

// Act in exactly ONE frame: probe every frame (func with { probe: true } only reports a match), pick
// the top document if it matched, else the first subframe that did, and run the real action there.
// Returns the probe results too so callers can build their not-found / options errors as before.
async function actInOneFrame(tabId, func, args) {
  const frames = await injectAllFrames(tabId, func, { ...args, probe: true })
  const hits = frames.filter((f) => f?.result?.ok)
  if (!hits.length) return { frames, result: null }
  const frame = hits.find((f) => f.frameId === 0) || hits[0]
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frame.frameId] }, func, args: [args] })
  return { frames, result }
}

// ---- Keyboard via the Chrome DevTools Protocol (debugger) ----
// chrome.scripting can set <input>.value, but it CANNOT type into editors that render their own
// surface (Google Docs/Slides on a canvas, Monaco, Notion). Those need real keyboard events sent
// to whatever element has focus. CDP's Input.insertText / Input.dispatchKeyEvent do exactly that.

// CDP modifier bitmask.
const CDP_MOD = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, super: 4, shift: 8 }
// Non-printable / named keys → the fields CDP wants. (Printable single chars are derived below.)
const CDP_KEYS = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  esc: { key: 'Escape', code: 'Escape', vk: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  del: { key: 'Delete', code: 'Delete', vk: 46 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  up: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  down: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  right: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 }
}

// Turn one combo string ("Control+V", "Enter", "Shift+ArrowRight", "a") into a CDP keyDown/keyUp pair.
function cdpKeyEvents(combo) {
  let modifiers = 0
  let main = null
  for (const raw of String(combo).split('+')) {
    const p = raw.trim()
    if (!p) continue
    const lp = p.toLowerCase()
    if (lp in CDP_MOD && p.length > 1) modifiers |= CDP_MOD[lp]
    else main = p
  }
  if (!main) return null
  let def = CDP_KEYS[main.toLowerCase()]
  if (!def) {
    // A single printable character: derive code/virtual-key from it.
    const ch = main.length === 1 ? main : null
    if (!ch) return null
    const upper = ch.toUpperCase()
    const code = /[a-zA-Z]/.test(ch) ? `Key${upper}` : /[0-9]/.test(ch) ? `Digit${ch}` : undefined
    def = { key: ch, code, vk: upper.charCodeAt(0), text: ch }
  }
  const base = { modifiers, key: def.key, code: def.code, windowsVirtualKeyCode: def.vk, nativeVirtualKeyCode: def.vk }
  // Send `text` only for a bare printable key (no modifiers) so it actually inserts a character;
  // with Ctrl/Alt/Meta held it's a shortcut (paste, select-all…) and must carry no text.
  const down = { type: def.text && !modifiers ? 'keyDown' : 'rawKeyDown', ...base }
  if (def.text && !modifiers) down.text = def.text
  return [down, { type: 'keyUp', ...base }]
}

function cdpSend(target, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params || {}, (res) => {
      const e = chrome.runtime.lastError
      e ? reject(new Error(e.message)) : resolve(res)
    })
  })
}

// Ctrl/Cmd + C/V/X → 'copy' | 'paste' | 'cut' | null. These go through the real system clipboard
// (the app passes clipboardText in for paste and reads `copied` back out) — a synthetic Ctrl+V
// won't make Chrome paste, and a synthetic Ctrl+C won't write the clipboard.
function clipboardIntent(combo) {
  const parts = String(combo).toLowerCase().split('+').map((s) => s.trim()).filter(Boolean)
  if (parts.length < 2) return null
  const hasMod = parts.slice(0, -1).some((p) => ['ctrl', 'control', 'cmd', 'command', 'meta', 'super'].includes(p))
  if (!hasMod) return null
  return { c: 'copy', v: 'paste', x: 'cut' }[parts[parts.length - 1]] || null
}

// Injected: the current selection — handles <input>/<textarea> carets and normal page selections.
function getSelectionInPage() {
  const el = document.activeElement
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && typeof el.selectionStart === 'number') {
    return el.value.slice(el.selectionStart, el.selectionEnd)
  }
  const s = window.getSelection()
  return s ? s.toString() : ''
}

// Reusable debugger session. The CDP keyboard / background screenshot need chrome.debugger, which
// shows a "started debugging this browser" banner while attached. Re-attaching per command made the
// banner FLICKER on every keystroke and screenshot — so instead we attach once, keep the session
// warm for a short idle window (so a burst of CDP ops reuses it), then auto-detach so the banner
// clears once the agent pauses. Commands run one at a time, so no locking is needed.
const dbg = { tabId: null, timer: null }

function detachDebugger() {
  const id = dbg.tabId
  if (dbg.timer) {
    clearTimeout(dbg.timer)
    dbg.timer = null
  }
  dbg.tabId = null
  if (id == null) return Promise.resolve()
  return new Promise((r) => chrome.debugger.detach({ tabId: id }, () => { void chrome.runtime.lastError; r() }))
}

// Chrome detached us (DevTools opened, or the tab navigated/closed) — drop our state so the next
// command re-attaches cleanly instead of erroring on a stale session.
chrome.debugger.onDetach?.addListener((source) => {
  if (source && source.tabId === dbg.tabId) {
    if (dbg.timer) clearTimeout(dbg.timer)
    dbg.timer = null
    dbg.tabId = null
  }
})

async function withDebugger(tabId, fn) {
  if (dbg.timer) {
    clearTimeout(dbg.timer) // cancel any pending idle-detach — we're about to reuse the session
    dbg.timer = null
  }
  if (dbg.tabId !== tabId) {
    if (dbg.tabId != null) await detachDebugger() // targeting a different tab now
    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, '1.3', () => {
        const e = chrome.runtime.lastError
        e ? reject(new Error(e.message + ' (close DevTools on this tab if it is open, then retry)')) : resolve()
      })
    })
    dbg.tabId = tabId
  }
  try {
    return await fn({ tabId })
  } finally {
    if (dbg.tabId === tabId) dbg.timer = setTimeout(detachDebugger, 1800) // keep warm, then auto-detach
  }
}

// ---- Injected page functions (must be fully self-contained) ----

// `probe`: only report whether a match exists in this frame — don't act. The background probes every
// frame, then runs the real click in exactly one (actInOneFrame) so a label present in the page AND
// an iframe isn't clicked twice.
function clickInPage({ selector, text, double, button, probe }) {
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return false
    const s = getComputedStyle(el)
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'
  }
  const fire = (el) => {
    if (probe) return true
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    const btn = button === 'right' ? 2 : button === 'middle' ? 1 : 0
    if (double) {
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, button: btn }))
      return true
    }
    if (btn === 2) el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
    else el.click()
    return true
  }
  if (text && String(text).trim()) {
    const t = String(text).trim().toLowerCase()
    const sel = 'button, a, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"], input[type="submit"], input[type="button"], summary'
    const controls = [...document.querySelectorAll(sel)].filter(visible)
    const label = (e) => (e.getAttribute('aria-label') || e.innerText || e.value || e.title || '').trim().toLowerCase()
    // If the only match is a plain text leaf (a <span> inside a button), climb to the nearest real
    // clickable ancestor so the click lands on the control rather than the inner node.
    const clickableAncestor = (node) => {
      for (let e = node; e && e !== document.body; e = e.parentElement) {
        if (e.matches?.(sel) || typeof e.onclick === 'function' || e.getAttribute?.('tabindex') === '0') return e
      }
      return node
    }
    let el = controls.find((e) => label(e) === t) || controls.find((e) => label(e).includes(t))
    if (!el) {
      const leaf = [...document.querySelectorAll('*')].find(
        (e) => visible(e) && e.childElementCount === 0 && (e.innerText || '').trim().toLowerCase().includes(t)
      )
      if (leaf) el = clickableAncestor(leaf)
    }
    if (el) return { ok: fire(el) }
    const clickables = controls
      .map((e) => (e.getAttribute('aria-label') || e.innerText || e.value || e.title || '').trim().replace(/\s+/g, ' '))
      .filter(Boolean)
      .slice(0, 25)
    return { ok: false, clickables }
  }
  if (selector) {
    let el = null
    try {
      el = [...document.querySelectorAll(selector)].find(visible) || document.querySelector(selector)
    } catch {
      return { ok: false, invalid: true }
    }
    if (el) return { ok: fire(el) }
  }
  return { ok: false, clickables: [] }
}

function fillInPage({ selector, label, value, probe }) {
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return false
    const s = getComputedStyle(el)
    return s.visibility !== 'hidden' && s.display !== 'none'
  }
  let el = null
  if (selector) {
    try {
      el = [...document.querySelectorAll(selector)].find(visible) || document.querySelector(selector)
    } catch {}
  }
  if (!el && label) {
    const l = String(label).trim().toLowerCase()
    el = [...document.querySelectorAll('input, textarea, select, [contenteditable="true"]')].filter(visible).find((e) => {
      const al = (e.getAttribute('aria-label') || e.placeholder || '').trim().toLowerCase()
      if (al.includes(l)) return true
      if (e.id) {
        const lab = document.querySelector(`label[for="${CSS.escape(e.id)}"]`)
        if (lab && lab.innerText.trim().toLowerCase().includes(l)) return true
      }
      return false
    })
  }
  if (!el) return { ok: false }
  if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
    if (probe) return { ok: true, found: true }
    // value decides the state: "false"/"no"/"off"/"unchecked" clears it, anything else sets it
    const on = !/^(false|no|off|0|unchecked|uncheck)$/i.test(String(value ?? '').trim())
    el.focus()
    if (el.checked !== on) {
      if (on || el.type === 'checkbox') {
        el.click() // toggles .checked and fires input/change natively
      } else {
        // a click never unchecks a radio; clear it directly
        el.checked = false
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      }
    }
    return { ok: true }
  }
  if (el.tagName === 'SELECT') {
    // Native dropdown: choose the option whose value or visible text matches (exact, then contains).
    const want = String(value ?? '').trim().toLowerCase()
    const opts = [...el.options]
    const opt =
      opts.find((o) => o.value.toLowerCase() === want || o.text.trim().toLowerCase() === want) ||
      (want && opts.find((o) => o.text.trim().toLowerCase().includes(want)))
    if (!opt) return { ok: false, options: opts.map((o) => o.text.trim()).filter(Boolean).slice(0, 30) }
    if (probe) return { ok: true, found: true }
    el.focus()
    el.value = opt.value
  } else if (probe) {
    return { ok: true, found: true }
  } else if (el.isContentEditable) {
    el.focus()
    el.textContent = value ?? ''
  } else {
    el.focus()
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    setter ? setter.call(el, value ?? '') : (el.value = value ?? '')
  }
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true }
}

function getTextInPage(maxChars) {
  const cap = Number(maxChars) || 20000
  return { url: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, cap) }
}

// Every collected element gets a data-ghost-ref="<nonce>:<i>" attribute (nonce is per frame, so
// the value is unique across frames); the background numbers the merged list and hands the app a
// `[data-ghost-ref=…]` selector per item, which clickInPage/fillInPage's selector path resolves.
function pageSnapshotInPage(maxItems) {
  const cap = Math.min(Number(maxItems) || 40, 60)
  const ATTR = 'data-ghost-ref'
  for (const el of document.querySelectorAll(`[${ATTR}]`)) el.removeAttribute(ATTR)
  const nonce = Math.random().toString(36).slice(2, 8)
  let i = 0
  const tag = (el) => {
    // Old attrs were stripped above, so a present one is from THIS snapshot — reuse it rather
    // than re-tag an element that shows up in two loops (breaks the first entry's ref).
    if (el.hasAttribute(ATTR)) return el.getAttribute(ATTR)
    const refAttr = `${nonce}:${i++}`
    el.setAttribute(ATTR, refAttr)
    return refAttr
  }
  const rectOf = (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.left, y: r.top, w: r.width, h: r.height }
  }
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
    buttons.push({ label, selector: selOf(el), refAttr: tag(el), rect: rectOf(el) })
    if (buttons.length >= cap) break
  }
  for (const el of document.querySelectorAll('a[href]')) {
    if (!visible(el)) continue
    const label = labelOf(el)
    if (!label) continue
    links.push({ label, href: el.href, refAttr: tag(el), rect: rectOf(el) })
    if (links.length >= cap) break
  }
  for (const el of document.querySelectorAll('input, textarea, [contenteditable="true"]')) {
    if (!visible(el)) continue
    if (el.type === 'hidden') continue
    if (['submit', 'button', 'reset', 'image'].includes(el.type)) continue // already listed as a button
    const isCheck = el.type === 'checkbox' || el.type === 'radio'
    fields.push({
      label: labelOf(el),
      name: el.name || '',
      type: el.type || el.tagName.toLowerCase(),
      placeholder: el.placeholder || '',
      value: isCheck ? '' : el.value || el.textContent?.slice(0, 40) || '',
      checked: isCheck ? !!el.checked : undefined,
      selector: selOf(el),
      refAttr: tag(el),
      rect: rectOf(el)
    })
    if (fields.length >= cap) break
  }
  for (const el of document.querySelectorAll('select')) {
    if (!visible(el)) continue
    selects.push({
      label: labelOf(el),
      name: el.name || '',
      selector: selOf(el),
      options: [...el.options].map((o) => o.text.trim()).filter(Boolean),
      refAttr: tag(el),
      rect: rectOf(el)
    })
    if (selects.length >= cap) break
  }
  const excerpt = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1200)
  return { url: location.href, title: document.title, buttons, links, fields, selects, excerpt }
}

function clickAtInPage({ x, y }) {
  const px = Math.round(x <= 1 ? x * window.innerWidth : x)
  const py = Math.round(y <= 1 ? y * window.innerHeight : y)
  const el = document.elementFromPoint(px, py)
  if (!el) return { ok: false }
  if (el.scrollIntoView) el.scrollIntoView({ block: 'center' })
  el.click()
  return { ok: true }
}

// Injected: locate an element the way clickInPage does (selector, then visible text), scroll it into
// view and return its centre in viewport px — the background then moves the real cursor there via
// CDP so CSS :hover menus open (synthetic mouseover events alone wouldn't trigger them).
function locateInPage({ selector, text }) {
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return false
    const s = getComputedStyle(el)
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'
  }
  let el = null
  if (selector) {
    try {
      el = [...document.querySelectorAll(selector)].find(visible) || document.querySelector(selector)
    } catch {
      return { ok: false, invalid: true }
    }
  }
  if (!el && text && String(text).trim()) {
    const t = String(text).trim().toLowerCase()
    const sel = 'button, a, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"], input[type="submit"], input[type="button"], summary'
    const controls = [...document.querySelectorAll(sel)].filter(visible)
    const label = (e) => (e.getAttribute('aria-label') || e.innerText || e.value || e.title || '').trim().toLowerCase()
    el = controls.find((e) => label(e) === t) || controls.find((e) => label(e).includes(t))
    if (!el) {
      el = [...document.querySelectorAll('*')].find(
        (e) => visible(e) && e.childElementCount === 0 && (e.innerText || '').trim().toLowerCase().includes(t)
      )
    }
  }
  if (!el) return { ok: false }
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }) // smooth scroll would give mid-animation coords
  const r = el.getBoundingClientRect()
  return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2 }
}

// Injected: find a phrase in the page text (Ctrl+F for the agent) — count, a snippet around each
// hit, and the first on-screen occurrence scrolled into view. Copy of browser.js findInPage.
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

// Injected (async): poll until a selector or visible text shows up, or the timeout elapses.
// chrome.scripting awaits the returned promise, so the command resolves only once it's found.
async function waitInPage({ selector, text, timeoutMs }) {
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return false
    const s = getComputedStyle(el)
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'
  }
  const hit = () => {
    if (selector) {
      let els
      try {
        els = document.querySelectorAll(selector)
      } catch {
        return 'invalid'
      }
      if ([...els].some(visible)) return true
    }
    if (text) {
      const t = String(text).toLowerCase()
      const ok = [...document.querySelectorAll('body *')].some(
        (e) => e.childElementCount === 0 && visible(e) && (e.textContent || '').toLowerCase().includes(t)
      )
      if (ok) return true
    }
    return false
  }
  const deadline = Date.now() + (Number(timeoutMs) || 10000)
  for (;;) {
    const h = hit()
    if (h === 'invalid') return { ok: false, invalid: true }
    if (h === true) return { ok: true }
    if (Date.now() >= deadline) return { ok: false, timeout: true }
    await new Promise((r) => setTimeout(r, 200))
  }
}

function scrollInPage({ direction = 'down', amount, selector }) {
  // Find the element that actually scrolls (app UIs scroll an inner container, not the window).
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
  return { ok: true, scrollY: el ? el.scrollTop : window.scrollY }
}

// Injected: a glowing border overlay that says "Ghost is acting here". Refreshes on each action and
// fades after a short idle. Self-contained, pointer-events:none, top z-index — never blocks the page.
function glowPage() {
  const ID = '__ghost_glow__'
  // Inject the keyframes once: a slow hue drift makes the cyan→violet border shimmer "alive".
  if (!document.getElementById('__ghost_glow_style__')) {
    const st = document.createElement('style')
    st.id = '__ghost_glow_style__'
    st.textContent = '@keyframes __ghostGlowHue{0%,100%{filter:hue-rotate(0deg)}50%{filter:hue-rotate(38deg)}}'
    ;(document.head || document.documentElement).appendChild(st)
  }
  let el = document.getElementById(ID)
  if (!el) {
    el = document.createElement('div')
    el.id = ID
    el.setAttribute('aria-hidden', 'true')
    el.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:2147483647;opacity:0;transition:opacity .35s ease;' +
      'animation:__ghostGlowHue 4s ease-in-out infinite;' +
      'box-shadow:inset 0 0 0 2px rgba(0,230,255,.95),inset 0 0 22px 4px rgba(0,230,255,.45),inset 0 0 78px 16px rgba(124,92,255,.24)'
    ;(document.documentElement || document.body || document).appendChild(el)
    requestAnimationFrame(() => {
      el.style.opacity = '1'
    })
  } else {
    el.style.opacity = '1'
  }
  clearTimeout(window.__ghostGlowTimer)
  window.__ghostGlowTimer = setTimeout(() => {
    const e = document.getElementById(ID)
    if (!e) return
    e.style.opacity = '0'
    setTimeout(() => e.remove(), 400)
  }, 1400)
}

// Injected: remove the glow immediately (so it never ends up inside a screenshot).
function removeGlowInPage() {
  clearTimeout(window.__ghostGlowTimer)
  document.getElementById('__ghost_glow__')?.remove()
}

// Injected: keyboard input WITHOUT the debugger (quiet mode). Inserts text into the focused field and
// dispatches synthetic key events; handles paste/copy/cut via the page selection. Works on normal
// inputs/textareas/contenteditable — canvas editors (Docs/Slides/Monaco) need the real debugger.
function typeInPage({ text, keys, clipboardText }) {
  const NAMED = { enter: 'Enter', tab: 'Tab', escape: 'Escape', esc: 'Escape', backspace: 'Backspace', delete: 'Delete', del: 'Delete', space: ' ', arrowup: 'ArrowUp', up: 'ArrowUp', arrowdown: 'ArrowDown', down: 'ArrowDown', arrowleft: 'ArrowLeft', left: 'ArrowLeft', arrowright: 'ArrowRight', right: 'ArrowRight', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown' }
  const setValue = (el, next, caret) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    setter ? setter.call(el, next) : (el.value = next)
    try {
      el.selectionStart = el.selectionEnd = caret
    } catch {}
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const insert = (s) => {
    const el = document.activeElement
    if (!el) return
    if (el.isContentEditable) return void document.execCommand('insertText', false, s)
    if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && typeof el.selectionStart === 'number') {
      const a = el.selectionStart
      const b = el.selectionEnd
      return void setValue(el, el.value.slice(0, a) + s + el.value.slice(b), a + s.length)
    }
    document.execCommand('insertText', false, s)
  }
  const readSel = () => {
    const el = document.activeElement
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && typeof el.selectionStart === 'number')
      return el.value.slice(el.selectionStart, el.selectionEnd)
    return String(window.getSelection() || '')
  }
  const del = () => {
    const el = document.activeElement
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && typeof el.selectionStart === 'number') {
      const a = el.selectionStart
      const b = el.selectionEnd
      if (a !== b) setValue(el, el.value.slice(0, a) + el.value.slice(b), a)
      else if (a > 0) setValue(el, el.value.slice(0, a - 1) + el.value.slice(a), a - 1)
    } else document.execCommand('delete')
  }
  const fireKey = (combo) => {
    const parts = String(combo).split('+').map((s) => s.trim()).filter(Boolean)
    const main = parts[parts.length - 1] || ''
    const mods = parts.slice(0, -1).map((m) => m.toLowerCase())
    const key = NAMED[main.toLowerCase()] || main
    const init = { key, bubbles: true, cancelable: true, ctrlKey: mods.includes('ctrl') || mods.includes('control'), shiftKey: mods.includes('shift'), altKey: mods.includes('alt'), metaKey: mods.includes('meta') || mods.includes('cmd') || mods.includes('command') }
    const el = document.activeElement || document.body
    el.dispatchEvent(new KeyboardEvent('keydown', init))
    if ((key === 'Backspace' || key === 'Delete') && !init.ctrlKey && !init.metaKey) del()
    el.dispatchEvent(new KeyboardEvent('keyup', init))
  }
  let copied = null
  if (text != null && String(text) !== '') insert(String(text))
  const list = keys == null ? [] : Array.isArray(keys) ? keys : [keys]
  for (const combo of list) {
    const lc = String(combo).toLowerCase()
    const mod = /(ctrl|control|cmd|command|meta)\+/.test(lc)
    if (mod && lc.endsWith('+v')) {
      insert(String(clipboardText || ''))
      continue
    }
    if (mod && lc.endsWith('+c')) {
      copied = readSel()
      continue
    }
    if (mod && lc.endsWith('+x')) {
      copied = readSel()
      del()
      continue
    }
    fireKey(combo)
  }
  return { ok: true, copied }
}

// Fire the "acting here" glow on a tab (no-op when the toggle is off). Fire-and-forget.
async function maybeGlow(tabId) {
  if (cfg.glow === false) return
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: glowPage })
  } catch {}
}

// ---- Command dispatch ----

// Open one URL in a background tab, read its text, optionally close it again.
async function readOnePage(url, keepOpen) {
  let tab
  try {
    tab = await chrome.tabs.create({ url, active: false })
    await addToGroup(tab.id) // multi-page reads also land in the Ghost-Prime group
    await waitComplete(tab.id)
    await sleep(400) // let late-rendered content settle
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: getTextInPage })
    const out = { url: (result && result.url) || url, title: (result && result.title) || '', text: (result && result.text) || '' }
    if (!keepOpen && tab) await chrome.tabs.remove(tab.id)
    return out
  } catch (e) {
    try {
      if (tab && !keepOpen) await chrome.tabs.remove(tab.id)
    } catch {}
    return { url, title: '', text: '', error: String((e && e.message) || e) }
  }
}

async function run(cmd, args) {
  if (cmd === 'reload') {
    chrome.runtime.reload() // re-reads the unpacked files from disk → picks up edits live
    return { ok: true }
  }
  // readPages opens its own tabs in parallel — it doesn't touch the active tab.
  if (cmd === 'readPages') {
    const urls = (args.urls || []).slice(0, 8)
    const keepOpen = args.keepOpen !== false
    return {
      pages: await Promise.all(
        urls.map((u) => {
          const g = siteCheck(args.policy, u)
          return g.ok ? readOnePage(u, keepOpen) : Promise.resolve({ url: u, title: '', text: '', error: g.reason })
        })
      )
    }
  }
  // List every open tab (across all Chrome windows) so the agent can see what's open, what's playing
  // audio, and which window each tab is in — and then target one with browser_use_tab. Doesn't touch
  // any tab. Covers "what tabs are open" (#5), "what's playing" (audible, #8), and window targeting.
  if (cmd === 'listTabs') {
    const all = await chrome.tabs.query({})
    const focused = await chrome.windows.getLastFocused().catch(() => null)
    return {
      tabs: all
        .filter((t) => t.id != null)
        .map((t) => ({
          tabId: t.id,
          windowId: t.windowId,
          url: t.url || t.pendingUrl || '',
          title: t.title || '',
          active: !!t.active,
          audible: !!t.audible,
          muted: !!(t.mutedInfo && t.mutedInfo.muted),
          focusedWindow: focused ? t.windowId === focused.id : false
        }))
    }
  }
  const tab = await resolveTab(cmd, args)
  // Per-site permission gate: navigate is judged by where it's GOING; every other action by the
  // page it would act ON. Back/forward/close only LEAVE the page, so they're the way off a blocked one.
  if (cmd !== 'goBack' && cmd !== 'goForward' && cmd !== 'closeTab') {
    const gate = siteCheck(args.policy, cmd === 'navigate' ? args.url : tab.url)
    if (!gate.ok) throw new Error(gate.reason)
  }
  // Visual "I'm acting here" glow (toggleable). Skip passive reads (getText/screenshot/waitFor) and
  // navigate (page is about to change — it glows once it has loaded, below).
  if (cmd === 'click' || cmd === 'fill' || cmd === 'clickAt' || cmd === 'scroll' || cmd === 'pressKey') maybeGlow(tab.id)
  switch (cmd) {
    case 'navigate': {
      await chrome.tabs.update(tab.id, { url: args.url })
      await waitComplete(tab.id)
      const t = await chrome.tabs.get(tab.id)
      maybeGlow(tab.id)
      return { url: t.url, title: t.title }
    }
    case 'goBack':
    case 'goForward': {
      const back = cmd === 'goBack'
      try {
        await (back ? chrome.tabs.goBack(tab.id) : chrome.tabs.goForward(tab.id))
      } catch {
        throw new Error(`Can't go ${back ? 'back' : 'forward'} — no ${back ? 'previous' : 'next'} page in this tab's history.`)
      }
      await waitComplete(tab.id)
      const t = await chrome.tabs.get(tab.id)
      maybeGlow(tab.id)
      return { url: t.url, title: t.title }
    }
    case 'reloadTab': {
      await chrome.tabs.reload(tab.id)
      await waitComplete(tab.id)
      const t = await chrome.tabs.get(tab.id)
      maybeGlow(tab.id)
      return { url: t.url, title: t.title }
    }
    case 'getPage': {
      const frames = await injectAllFrames(tab.id, pageSnapshotInPage, args.limit || 40)
      const main = { ...(frames.find((f) => f.frameId === 0)?.result || frames[0]?.result || {}) }
      for (const f of frames) {
        if (f.frameId === 0 || !f?.result) continue
        for (const k of ['buttons', 'links', 'fields', 'selects']) {
          main[k] = [...(main[k] || []), ...(f.result[k] || [])]
        }
      }
      const cap = Math.min(Number(args.limit) || 40, 60)
      for (const k of ['buttons', 'links', 'fields', 'selects']) main[k] = (main[k] || []).slice(0, cap)
      // Number the merged list here (one sequence across frames); the app keeps ref → selector.
      let n = 1
      for (const k of ['buttons', 'links', 'fields', 'selects']) {
        for (const it of main[k]) {
          it.ref = n++
          if (it.refAttr) it.refSelector = `[data-ghost-ref="${it.refAttr}"]`
        }
      }
      return main
    }
    case 'getText': {
      const offset = Math.max(0, Number(args.offset) || 0)
      const limit = Math.min(Number(args.limit) || 20000, 50000)
      // Read EVERY frame (like click/fill do) — chat widgets, embeds and OAuth popups render inside
      // iframes that a top-frame-only read misses. Each frame returns up to offset+limit chars so
      // pagination can still reach deep into a long main document.
      const frames = await injectAllFrames(tab.id, getTextInPage, offset + limit)
      const main = (frames.find((f) => f.frameId === 0) || frames[0] || {}).result || {}
      const subs = frames
        .filter((f) => f.frameId !== 0 && f?.result?.text && f.result.text.trim().length > 40)
        .map((f) => f.result.text)
      const full = [main.text || '', ...subs].filter(Boolean).join('\n\n--- (frame) ---\n\n')
      const text = full.slice(offset, offset + limit)
      const nextOffset = offset + text.length < full.length ? offset + text.length : null
      return { url: main.url || tab.url, title: main.title || '', text, offset, nextOffset, totalChars: full.length }
    }
    case 'screenshot': {
      const fullPage = !!args.fullPage
      // Clear the glow first so it never shows up inside the screenshot the agent looks at.
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: removeGlowInPage }).catch(() => {})
      // Cheap path (no debugger banner): a visible tab, viewport only — captureVisibleTab can't do
      // full-page, so skip it when fullPage was asked for.
      if (!fullPage && tab.active) {
        try {
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
          return { base64: String(dataUrl).split(',')[1] || '', url: tab.url }
        } catch {}
      }
      // CDP path: screenshots a background tab WITHOUT bringing it forward, and is the ONLY way to
      // capture the full scrollable page (captureBeyondViewport). Needs the debugger, so quiet mode
      // skips it and falls through to a visible-viewport capture instead.
      if (!cfg.quietDebugger) {
        try {
          const shot = await withDebugger(tab.id, async (target) => {
            await cdpSend(target, 'Page.enable').catch(() => {})
            const params = { format: 'png', captureBeyondViewport: fullPage }
            if (fullPage) {
              const m = await cdpSend(target, 'Page.getLayoutMetrics').catch(() => null)
              const c = m && (m.cssContentSize || m.contentSize)
              if (c) params.clip = { x: 0, y: 0, width: Math.ceil(c.width), height: Math.ceil(c.height), scale: 1 }
            }
            return cdpSend(target, 'Page.captureScreenshot', params)
          })
          if (shot && shot.data) return { base64: shot.data, url: tab.url }
        } catch {}
      }
      // Quiet mode, or debugger blocked/failed: bring it forward and capture the visible viewport.
      await chrome.tabs.update(tab.id, { active: true }).catch(() => {})
      await sleep(150)
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
      return { base64: String(dataUrl).split(',')[1] || '', url: tab.url }
    }
    case 'click': {
      const { frames, result } = await actInOneFrame(tab.id, clickInPage, args)
      if (result?.ok) return { ok: true, url: tab.url }
      if (frames.some((f) => f?.result?.invalid)) {
        throw new Error(
          `Invalid CSS selector ${JSON.stringify(args.selector)}. Use a standard CSS selector, or click by visible text with { text: "..." }.`
        )
      }
      const clickables = [...new Set(frames.flatMap((f) => f?.result?.clickables || []))].slice(0, 25)
      const what = args.text ? `text "${args.text}"` : `selector ${JSON.stringify(args.selector)}`
      const list = clickables.length ? ` Visible clickable elements: ${clickables.map((c) => `"${c}"`).join(', ')}.` : ''
      throw new Error(`Couldn't click ${what} — not found on the page.${list} Retry with the exact visible text of the element you want.`)
    }
    case 'fill': {
      const { frames, result } = await actInOneFrame(tab.id, fillInPage, args)
      if (result?.ok) return { ok: true }
      const opts = [...new Set(frames.flatMap((f) => f?.result?.options || []))]
      if (opts.length) {
        throw new Error(`Couldn't match "${args.value}" to a dropdown option. Choose one of: ${opts.map((o) => `"${o}"`).join(', ')}.`)
      }
      throw new Error(`Couldn't find a field for ${args.label ? `label "${args.label}"` : `selector ${JSON.stringify(args.selector)}`}.`)
    }
    case 'find': {
      const needle = String(args.needle ?? '').trim()
      if (!needle) throw new Error('browser_find needs the "text" to look for')
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: findInPage,
        args: [{ needle, max: Math.min(Number(args.max) || 5, 20) }]
      })
      return { ...(result || { count: 0, matches: [], scrolled: false }), url: tab.url }
    }
    case 'hover': {
      // Resolve the element in whichever frame has it, then move the REAL cursor there over CDP so
      // CSS :hover menus open. Quiet mode (no debugger) falls back to synthetic mouse events.
      const frames = await injectAllFrames(tab.id, locateInPage, { selector: args.selector, text: args.text })
      if (frames.some((f) => f?.result?.invalid)) {
        throw new Error(`Invalid CSS selector ${JSON.stringify(args.selector)}. Use a standard CSS selector, or hover by visible text with { text: "..." }.`)
      }
      const hit = frames.find((f) => f?.result?.ok)
      if (!hit) {
        const what = args.text ? `text "${args.text}"` : `selector ${JSON.stringify(args.selector)}`
        throw new Error(`Couldn't hover ${what} — not found on the page. Call browser_get_page and use the element's { ref: N } or exact visible text.`)
      }
      const { x, y } = hit.result
      // CDP coords are top-document viewport px; a subframe's coords would need its offset, which
      // this extension can't look up (no webNavigation permission) — so only the top frame gets the
      // real cursor move, and subframes / quiet mode / a blocked debugger use synthetic events.
      let moved = false
      if (hit.frameId === 0 && !cfg.quietDebugger) {
        try {
          await withDebugger(tab.id, (target) =>
            cdpSend(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y) })
          )
          moved = true
        } catch {}
      }
      if (!moved) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, frameIds: [hit.frameId] },
          func: ({ x, y }) => {
            const el = document.elementFromPoint(x, y)
            if (!el) return false
            for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove'])
              el.dispatchEvent(new MouseEvent(type, { bubbles: type !== 'mouseenter' && type !== 'pointerenter', clientX: x, clientY: y }))
            return true
          },
          args: [hit.result]
        }).catch(() => {})
      }
      return { ok: true, url: tab.url }
    }
    case 'clickAt': {
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: clickAtInPage, args: [args] })
      if (result && result.ok) return { ok: true, url: tab.url }
      throw new Error('no clickable element at that point')
    }
    case 'scroll': {
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scrollInPage, args: [args] })
      return result || { ok: true }
    }
    case 'waitFor': {
      const timeoutMs = Math.min(Number(args.timeoutMs) || 10000, 30000)
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: waitInPage,
        args: [{ selector: args.selector, text: args.text, timeoutMs }]
      })
      if (result?.invalid) throw new Error(`Invalid CSS selector ${JSON.stringify(args.selector)}.`)
      if (result?.ok) return { ok: true, url: tab.url }
      throw new Error(
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ` +
          `${args.selector ? `selector ${JSON.stringify(args.selector)}` : `text "${args.text}"`} to appear.`
      )
    }
    case 'pressKey': {
      // Real keyboard input to the focused element — the only way to type into Google Docs/Slides,
      // Monaco, and other editors that have no fillable <input>. `text` is inserted verbatim;
      // `keys` is one combo or an array of them ("Enter", "Control+A", "Control+V", "ArrowDown").
      // Copy/paste/cut go through the real clipboard: paste inserts args.clipboardText; copy/cut
      // read the page selection back into `copied` (the app writes it to the system clipboard).
      // Quiet mode: type without the debugger (no banner) via a content-script typer instead.
      if (cfg.quietDebugger) {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: typeInPage,
          args: [{ text: args.text, keys: args.keys, clipboardText: args.clipboardText }]
        })
        return { ok: true, url: tab.url, copied: result?.copied ?? null }
      }
      const keys = args.keys == null ? [] : Array.isArray(args.keys) ? args.keys : [args.keys]
      const ops = []
      if (args.text != null && String(args.text) !== '') ops.push({ kind: 'insert', text: String(args.text) })
      for (const combo of keys) {
        const intent = clipboardIntent(combo)
        if (intent === 'paste') ops.push({ kind: 'insert', text: String(args.clipboardText || '') })
        else if (intent === 'copy') ops.push({ kind: 'copy' })
        else if (intent === 'cut') ops.push({ kind: 'cut' })
        else ops.push({ kind: 'key', combo })
      }

      const readSelection = async () => {
        try {
          const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: getSelectionInPage })
          return result || ''
        } catch {
          return ''
        }
      }

      let copied = null
      // Copy-only needs no debugger (so no "started debugging" banner). Anything that types does.
      const needsDebugger = ops.some((o) => o.kind === 'insert' || o.kind === 'key' || o.kind === 'cut')
      const runOps = async (target) => {
        for (const op of ops) {
          if (op.kind === 'insert') {
            if (op.text) await cdpSend(target, 'Input.insertText', { text: op.text })
          } else if (op.kind === 'key') {
            const evs = cdpKeyEvents(op.combo)
            if (!evs) continue
            for (const ev of evs) await cdpSend(target, 'Input.dispatchKeyEvent', ev)
            await sleep(15) // let the editor process each keystroke
          } else if (op.kind === 'copy') {
            copied = await readSelection()
          } else if (op.kind === 'cut') {
            copied = await readSelection()
            const evs = cdpKeyEvents('Backspace') // remove the cut selection
            for (const ev of evs) await cdpSend(target, 'Input.dispatchKeyEvent', ev)
          }
        }
      }

      if (needsDebugger) await withDebugger(tab.id, runOps)
      else await runOps(null)
      return { ok: true, url: tab.url, copied }
    }
    case 'closeTab': {
      try {
        const tabsInWindow = await chrome.tabs.query({ windowId: tab.windowId })
        if (tabsInWindow.length > 1) {
          await chrome.tabs.remove(tab.id)
          const remaining = tabsInWindow.filter((t) => t.id !== tab.id)
          await chrome.tabs.update(remaining[0].id, { active: true }).catch(() => {})
          const after = await chrome.tabs.get(remaining[0].id)
          return { ok: true, url: after.url, closedTabId: tab.id }
        }
        // Last tab in the window: create a new tab instead of closing the window.
        await chrome.tabs.update(tab.id, { url: 'about:blank' })
        return { ok: true, url: 'about:blank:', replaced: true }
      } catch (e) {
        throw new Error(`Couldn't close the tab: ${e?.message || e}`)
      }
    }
    case 'waitForNavigation': {
      // A navigation that's already under way (status 'loading') or one that starts within ~8s counts
      // as "started"; then wait (up to timeoutMs) for it to complete. If nothing starts, return
      // early instead of stalling for the whole timeout — mirrors the Playwright path.
      try {
        const total = Number(args.timeoutMs) || 30000
        const t0 = Date.now()
        let started = tab.status === 'loading'
        await new Promise((resolve) => {
          let startTimer = null
          let hardTimer = null
          let poll = null
          const finish = () => {
            clearTimeout(startTimer)
            clearTimeout(hardTimer)
            clearInterval(poll)
            chrome.tabs.onUpdated.removeListener(listener)
            resolve()
          }
          const listener = (tabId, info) => {
            if (tabId !== tab.id) return
            if (info.status === 'loading') {
              started = true
              clearTimeout(startTimer)
            } else if (info.status === 'complete' && started) finish()
          }
          chrome.tabs.onUpdated.addListener(listener)
          // Nothing started within the cap → give up waiting for a start.
          if (!started) startTimer = setTimeout(() => !started && finish(), Math.min(total, 8000))
          hardTimer = setTimeout(finish, total)
          // Belt and braces: the 'complete' event can slip past between tabs.get and addListener.
          poll = setInterval(async () => {
            const t = await chrome.tabs.get(tab.id).catch(() => null)
            if (!t) return finish()
            if (started && t.status === 'complete') finish()
          }, 500)
        })
        const t = await chrome.tabs.get(tab.id)
        return { ok: true, url: t.url, title: t.title, navigated: started || t.url !== tab.url, waitedMs: Date.now() - t0 }
      } catch (e) {
        throw new Error(`Navigation wait failed: ${e?.message || e}`)
      }
    }
    default:
      throw new Error(`unknown command "${cmd}"`)
  }
}

// ---- Poll loop ----

// The bridge holds /poll open for ~25s (long-poll). Abort a bit past that so a DEAD socket — app
// crashed mid-request, laptop suspend/resume, a stalled hold — THROWS instead of leaving this await
// hanging forever. A hung await would wedge the loop: the `looping` guard then blocks the keepalive
// alarm from ever restarting it, so the bridge would silently stop until Chrome killed the worker.
const POLL_TIMEOUT = 35000

async function pollOnce() {
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), POLL_TIMEOUT)
  let r
  try {
    if (!deviceId) await loadDeviceId()
    const brand = browserBrand()
    const ident = `&id=${encodeURIComponent(deviceId)}&kind=browser&brand=${encodeURIComponent(brand)}&name=${encodeURIComponent(brand)}`
    r = await fetch(q('/poll') + ident, { signal: ctrl.signal })
  } finally {
    clearTimeout(to)
  }
  if (!r.ok) throw new Error(`poll ${r.status}`)
  const job = await r.json()
  if (!job || !job.cmd) {
    await sleep(250) // empty hold ended early (e.g. another poller with our id) — never tight-loop
    return
  }
  let result
  try {
    result = { id: job.id, ok: true, data: await run(job.cmd, job.args || {}) }
  } catch (e) {
    result = { id: job.id, ok: false, error: String((e && e.message) || e) }
  }
  await fetch(q('/result'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(result)
  })
}

// Toolbar badge as a connection light: no badge when connected to the Ghost-Prime app, a red "!"
// when not — and the icon tooltip always spells out the state. Lets you tell at a glance whether
// the bridge is live (the thing that was invisible before).
let lastConnected = null
function setConnected(on) {
  if (on === lastConnected) return
  lastConnected = on
  try {
    chrome.action?.setBadgeText?.({ text: on ? '' : '!' })
    chrome.action?.setBadgeBackgroundColor?.({ color: on ? '#1f9d55' : '#c0392b' })
    chrome.action?.setTitle?.({
      title: on
        ? 'Ghost-Prime — connected to the app · click for the chat panel'
        : 'Ghost-Prime — app not connected (is Ghost-Prime running?)'
    })
  } catch {}
}

async function loop() {
  if (looping) return
  looping = true
  try {
    for (;;) {
      try {
        await pollOnce()
        setConnected(true)
      } catch {
        setConnected(false)
        await sleep(2000) // app not up yet / lost connection — back off, then retry
      }
    }
  } finally {
    looping = false
  }
}

// Clicking the toolbar icon opens the Ghost-Prime chat side panel (mirrors the app's chat). We open
// it EXPLICITLY from action.onClicked (a real user gesture) instead of relying only on
// openPanelOnActionClick — that auto-behavior silently no-ops after a cold service-worker start or
// on some Chrome builds, which is the "panel won't open" symptom. Keep the panel globally enabled.
function enableSidePanel() {
  try {
    chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {})
    chrome.sidePanel?.setOptions({ path: 'sidepanel.html', enabled: true }).catch(() => {})
  } catch {}
}

// Open synchronously within the click gesture (sidePanel.open requires one). windowId is preferred;
// fall back to tabId for builds that want it.
chrome.action?.onClicked.addListener((tab) => {
  const opts = tab && tab.windowId != null ? { windowId: tab.windowId } : { tabId: tab && tab.id }
  chrome.sidePanel?.open(opts).catch(() => {
    if (tab && tab.id != null) chrome.sidePanel?.open({ tabId: tab.id }).catch(() => {})
  })
})

chrome.runtime.onInstalled.addListener(() => {
  Promise.all([loadCfg(), loadDeviceId()]).then(loop)
  enableSidePanel()
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: 'ask-ghost',
        title: 'Ask Ghost about this',
        contexts: ['selection', 'page', 'link', 'image']
      })
      // A reliable alternate way to open the chat panel (right-click the icon or the page) in case
      // the toolbar-icon click is finicky.
      chrome.contextMenus.create({
        id: 'open-ghost-panel',
        title: 'Open Ghost-Prime chat panel',
        contexts: ['action', 'page']
      })
    })
  } catch {}
})
chrome.runtime.onStartup.addListener(() => {
  Promise.all([loadCfg(), loadDeviceId()]).then(loop)
  enableSidePanel()
})

// Right-click → push a task up to the app (it summons the window and runs it).
chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
  // The panel-open item is handled here (a menu click is a valid user gesture for sidePanel.open).
  if (info.menuItemId === 'open-ghost-panel') {
    const opts = tab && tab.windowId != null ? { windowId: tab.windowId } : { tabId: tab && tab.id }
    chrome.sidePanel?.open(opts).catch(() => {})
    return
  }
  const where = tab && tab.url ? ` (on ${tab.url})` : ''
  let prompt
  if (info.selectionText) prompt = `On the page${where}, the user selected this text:\n\n"${info.selectionText}"\n\nHelp them with it.`
  else if (info.linkUrl) prompt = `The user right-clicked this link${where}: ${info.linkUrl}\n\nHelp them with it.`
  else if (info.srcUrl) prompt = `The user right-clicked this image${where}: ${info.srcUrl}\n\nHelp them with it.`
  else prompt = `The user wants help with the page they're on${where}: "${(tab && tab.title) || ''}".`
  try {
    await fetch(q('/task'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }) })
  } catch {}
})
chrome.alarms.create('keepalive', { periodInMinutes: 1 }) // restart the loop if the SW was idled out
chrome.alarms.onAlarm.addListener(() => Promise.all([loadCfg(), loadDeviceId()]).then(loop))
// Only the synced config matters here; ignore the high-frequency session writes (ghost tab/group
// ids) that saveGhostRefs() makes on every command — reloading cfg for those is wasted work.
chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName === 'sync') loadCfg()
})
enableSidePanel()
setConnected(false) // show "not connected" until the first successful poll proves the bridge is up
Promise.all([loadCfg(), loadDeviceId()]).then(loop)

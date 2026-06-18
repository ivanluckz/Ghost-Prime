// Ghost-Prime browser bridge — service worker.
// Long-polls the app's local bridge (127.0.0.1) for commands, runs them against the active tab,
// and posts results back. The app side lives in src/main/tools/browser-bridge.js.

const DEFAULTS = { host: '127.0.0.1', port: 8731, token: 'ghost-local' }
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
// (needed before a screenshot, which captures the visible tab; and for navigate so you can watch).
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

// Pick the tab a command runs against. target:'active' → your focused tab; otherwise Ghost's tab.
async function resolveTab(cmd, args) {
  if (args && args.target === 'active') {
    const t = await activeTab()
    if (t) return t
  }
  return ghostTab(cmd === 'navigate' || cmd === 'screenshot' || cmd === 'pressKey')
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

// Attach the debugger to a tab, run fn(target), always detach. Surfaces the "started debugging"
// banner briefly — unavoidable with the CDP keyboard, and the only way to type into canvas editors.
async function withDebugger(tabId, fn) {
  const target = { tabId }
  await new Promise((resolve, reject) => {
    chrome.debugger.attach(target, '1.3', () => {
      const e = chrome.runtime.lastError
      e ? reject(new Error(e.message + ' (close DevTools on this tab if it is open, then retry)')) : resolve()
    })
  })
  try {
    return await fn(target)
  } finally {
    try {
      await new Promise((r) => chrome.debugger.detach(target, () => r()))
    } catch {}
  }
}

// ---- Injected page functions (must be fully self-contained) ----

function clickInPage({ selector, text }) {
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return false
    const s = getComputedStyle(el)
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'
  }
  const fire = (el) => {
    el.scrollIntoView({ block: 'center', inline: 'center' })
    el.click()
    return true
  }
  if (text && String(text).trim()) {
    const t = String(text).trim().toLowerCase()
    const sel = 'button, a, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"], input[type="submit"], input[type="button"], summary'
    const controls = [...document.querySelectorAll(sel)].filter(visible)
    const label = (e) => (e.getAttribute('aria-label') || e.innerText || e.value || e.title || '').trim().toLowerCase()
    let el =
      controls.find((e) => label(e) === t) ||
      controls.find((e) => label(e).includes(t)) ||
      [...document.querySelectorAll('*')].find(
        (e) => visible(e) && e.childElementCount === 0 && (e.innerText || '').trim().toLowerCase().includes(t)
      )
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

function fillInPage({ selector, label, value }) {
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
    el = [...document.querySelectorAll('input, textarea, [contenteditable="true"]')].filter(visible).find((e) => {
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
  el.focus()
  if (el.isContentEditable) {
    el.textContent = value ?? ''
  } else {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    setter ? setter.call(el, value ?? '') : (el.value = value ?? '')
  }
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true }
}

function getTextInPage() {
  return { url: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, 20000) }
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
  const tab = await resolveTab(cmd, args)
  // Per-site permission gate: navigate is judged by where it's GOING; every other action by the
  // page it would act ON.
  const gate = siteCheck(args.policy, cmd === 'navigate' ? args.url : tab.url)
  if (!gate.ok) throw new Error(gate.reason)
  switch (cmd) {
    case 'navigate': {
      await chrome.tabs.update(tab.id, { url: args.url })
      await waitComplete(tab.id)
      const t = await chrome.tabs.get(tab.id)
      return { url: t.url, title: t.title }
    }
    case 'getText': {
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: getTextInPage })
      return result
    }
    case 'screenshot': {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
      return { base64: String(dataUrl).split(',')[1] || '', url: tab.url }
    }
    case 'click': {
      const frames = await injectAllFrames(tab.id, clickInPage, args)
      if (frames.some((f) => f?.result?.ok)) return { ok: true, url: tab.url }
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
      const frames = await injectAllFrames(tab.id, fillInPage, args)
      if (frames.some((f) => f?.result?.ok)) return { ok: true }
      throw new Error(`Couldn't find a field for ${args.label ? `label "${args.label}"` : `selector ${JSON.stringify(args.selector)}`}.`)
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
    case 'pressKey': {
      // Real keyboard input to the focused element — the only way to type into Google Docs/Slides,
      // Monaco, and other editors that have no fillable <input>. `text` is inserted verbatim;
      // `keys` is one combo or an array of them ("Enter", "Control+A", "Control+V", "ArrowDown").
      return await withDebugger(tab.id, async (target) => {
        if (args.text != null && String(args.text) !== '') {
          await cdpSend(target, 'Input.insertText', { text: String(args.text) })
        }
        const keys = args.keys == null ? [] : Array.isArray(args.keys) ? args.keys : [args.keys]
        for (const combo of keys) {
          const evs = cdpKeyEvents(combo)
          if (!evs) continue
          for (const ev of evs) await cdpSend(target, 'Input.dispatchKeyEvent', ev)
          await sleep(15) // let the editor process each keystroke
        }
        return { ok: true, url: tab.url }
      })
    }
    default:
      throw new Error(`unknown command "${cmd}"`)
  }
}

// ---- Poll loop ----

async function pollOnce() {
  const r = await fetch(q('/poll'))
  if (!r.ok) throw new Error(`poll ${r.status}`)
  const job = await r.json()
  if (!job || !job.cmd) return
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

async function loop() {
  if (looping) return
  looping = true
  try {
    for (;;) {
      try {
        await pollOnce()
      } catch {
        await sleep(2000) // app not up yet / lost connection — back off, then retry
      }
    }
  } finally {
    looping = false
  }
}

// Clicking the toolbar icon opens the Ghost-Prime chat side panel (mirrors the app's chat).
function enableSidePanel() {
  try {
    chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
  } catch {}
}

chrome.runtime.onInstalled.addListener(() => {
  loadCfg().then(loop)
  enableSidePanel()
  try {
    chrome.contextMenus.create({
      id: 'ask-ghost',
      title: 'Ask Ghost about this',
      contexts: ['selection', 'page', 'link', 'image']
    })
  } catch {}
})
chrome.runtime.onStartup.addListener(() => {
  loadCfg().then(loop)
  enableSidePanel()
})

// Right-click → push a task up to the app (it summons the window and runs it).
chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
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
chrome.alarms.onAlarm.addListener(() => loadCfg().then(loop))
// Only the synced config matters here; ignore the high-frequency session writes (ghost tab/group
// ids) that saveGhostRefs() makes on every command — reloading cfg for those is wasted work.
chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName === 'sync') loadCfg()
})
enableSidePanel()
loadCfg().then(loop)

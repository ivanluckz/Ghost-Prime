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
// hijacks the tab you're looking at (no more loading Gmail over your YouTube tab).
let ghostTabId = null
let ghostGroupId = null

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

async function addToGroup(tabId) {
  try {
    if (await groupExists(ghostGroupId)) {
      await chrome.tabs.group({ tabIds: tabId, groupId: ghostGroupId })
    } else {
      ghostGroupId = await chrome.tabs.group({ tabIds: tabId })
      await chrome.tabGroups.update(ghostGroupId, { title: 'Ghost-Prime', color: 'cyan' })
    }
  } catch {
    // tab groups unsupported / failed — not fatal; the tab still works, just ungrouped
  }
}

// Ghost's working tab — created in its group if missing/closed. active=true brings it forward
// (needed before a screenshot, which captures the visible tab; and for navigate so you can watch).
async function ghostTab(active = false) {
  if (!(await tabExists(ghostTabId))) {
    const tab = await chrome.tabs.create({ url: 'about:blank', active })
    ghostTabId = tab.id
    await addToGroup(tab.id)
  } else if (active) {
    await chrome.tabs.update(ghostTabId, { active: true })
  }
  return chrome.tabs.get(ghostTabId)
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
    return { pages: await Promise.all(urls.map((u) => readOnePage(u, keepOpen))) }
  }
  const tab = await ghostTab(cmd === 'navigate' || cmd === 'screenshot')
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

chrome.runtime.onInstalled.addListener(() => {
  loadCfg().then(loop)
  try {
    chrome.contextMenus.create({
      id: 'ask-ghost',
      title: 'Ask Ghost about this',
      contexts: ['selection', 'page', 'link', 'image']
    })
  } catch {}
})
chrome.runtime.onStartup.addListener(() => loadCfg().then(loop))

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
chrome.storage.onChanged.addListener(() => loadCfg())
loadCfg().then(loop)

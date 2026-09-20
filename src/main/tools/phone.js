import * as bridge from './browser-bridge.js'

// The agent's hands on an Android phone running the connector app (android-connector/). Every
// call goes over the same bridge the Chrome extension uses, addressed to a device of kind
// 'phone': screenshot (MediaProjection), uiDump/tap/swipe/type/key (AccessibilityService), openApp
// (launch intents). The phone connects over LAN; nothing here needs adb or root.
const KIND = bridge.KIND_PHONE
const send = (cmd, args = {}, timeoutMs = 25000) => bridge.sendCommand(cmd, args, timeoutMs, null, KIND)

export const phoneConnected = () => bridge.bridgeConnected(null, KIND)

// Screen size from the last screenshot — lets tap/swipe accept 0..1 fractions the way
// browser_click_at does, so the model can act straight off a screenshot.
let screen = null

function toPx(v, span) {
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error('coordinates must be numbers')
  if (n <= 1) {
    if (!span) throw new Error('fractions (0..1) need a phone_screenshot first so the screen size is known — or pass pixels from phone_ui')
    return Math.round(n * span)
  }
  return Math.round(n)
}

export async function phoneScreenshot() {
  const r = await send('screenshot', {}, 30000)
  const image = String(r?.image || '')
  const base64 = image.replace(/^data:image\/\w+;base64,/, '')
  if (!base64) throw new Error('the phone returned no image')
  if (r.w && r.h) screen = { w: Number(r.w), h: Number(r.h) }
  return { base64, w: r.w, h: r.h }
}

// Numbered list of the on-screen elements (text, role, tap point) from the accessibility tree —
// the phone's equivalent of browser_get_page.
export async function phoneUi({ limit } = {}) {
  const r = await send('uiDump', {}, 20000)
  const nodes = Array.isArray(r?.nodes) ? r.nodes : Array.isArray(r?.tree) ? r.tree : []
  const cap = Math.min(Number(limit) || 60, 120)
  const items = nodes.slice(0, cap).map((n, i) => {
    const b = Array.isArray(n.bounds) ? n.bounds : [0, 0, 0, 0]
    return {
      ref: i + 1,
      text: n.text || '',
      desc: n.desc || '',
      role: n.role || '',
      clickable: !!n.clickable,
      editable: !!n.editable,
      x: Math.round((b[0] + b[2]) / 2),
      y: Math.round((b[1] + b[3]) / 2)
    }
  })
  return { package: r?.package || '', items, formatted: formatUi(r?.package, items, nodes.length) }
}

function formatUi(pkg, items, total) {
  const lines = [`# Phone screen${pkg ? ` — ${pkg}` : ''}`]
  if (!items.length) lines.push('(no readable elements — take phone_screenshot to see the screen)')
  for (const it of items) {
    const label = it.text || it.desc || `(${it.role || 'element'})`
    const flags = [it.role, it.clickable ? 'tap' : null, it.editable ? 'editable' : null].filter(Boolean).join(', ')
    lines.push(`- [${it.ref}] "${label}"${flags ? ` (${flags})` : ''} @ ${it.x},${it.y}`)
  }
  if (total > items.length) lines.push(`…${total - items.length} more (raise limit)`)
  lines.push('', 'Tap with phone_tap { text } (visible label) or { x, y } (the pixel point shown, or 0..1 fractions of a screenshot).')
  return lines.join('\n')
}

export async function phoneTap({ text, x, y } = {}) {
  if (text != null && String(text).trim() !== '') return send('tap', { text: String(text) })
  if (x == null || y == null) throw new Error('phone_tap needs { text } or { x, y }')
  return send('tap', { x: toPx(x, screen?.w), y: toPx(y, screen?.h) })
}

// Swipe by direction (scroll the way a thumb would) or between two points.
export async function phoneSwipe({ direction, from, to, durationMs } = {}) {
  let x1, y1, x2, y2
  if (from && to) {
    x1 = toPx(from.x, screen?.w); y1 = toPx(from.y, screen?.h)
    x2 = toPx(to.x, screen?.w); y2 = toPx(to.y, screen?.h)
  } else {
    if (!screen) await phoneScreenshot() // need the size to place a directional swipe
    const { w, h } = screen
    const cx = Math.round(w / 2)
    const cy = Math.round(h / 2)
    switch (String(direction || 'up').toLowerCase()) {
      case 'up': [x1, y1, x2, y2] = [cx, Math.round(h * 0.7), cx, Math.round(h * 0.3)]; break // scroll down the page
      case 'down': [x1, y1, x2, y2] = [cx, Math.round(h * 0.3), cx, Math.round(h * 0.7)]; break
      case 'left': [x1, y1, x2, y2] = [Math.round(w * 0.8), cy, Math.round(w * 0.2), cy]; break
      case 'right': [x1, y1, x2, y2] = [Math.round(w * 0.2), cy, Math.round(w * 0.8), cy]; break
      default: throw new Error('direction must be up | down | left | right')
    }
  }
  return send('swipe', { x1, y1, x2, y2, durationMs: Number(durationMs) || 300 })
}

export async function phoneType({ text } = {}) {
  if (text == null || String(text) === '') throw new Error('phone_type needs text')
  return send('type', { text: String(text) })
}

export async function phoneKey({ key } = {}) {
  const k = String(key || '').toLowerCase()
  if (!['back', 'home', 'recents'].includes(k)) throw new Error('key must be back | home | recents')
  return send('key', { key: k })
}

export async function phoneOpenApp({ app, url } = {}) {
  if (url) return send('openApp', { url: String(url) })
  if (!app) throw new Error('phone_open_app needs { app } (package name like com.instagram.android) or { url }')
  return send('openApp', { package: String(app) })
}

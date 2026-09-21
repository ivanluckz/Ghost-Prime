import http from 'node:http'
import { writeBridgeConfig } from './ext-config.js'
import { timingSafeEqual } from 'node:crypto'
import { watch, cpSync, mkdirSync } from 'node:fs'

// Local bridge between Ghost-Prime and its executor clients — your real Chrome (via the extension)
// and, later, a phone connector app. Transport is plain HTTP long-poll on a loopback/LAN socket:
// each client repeatedly GETs /poll (identifying itself with id/name/kind), we hand it queued
// commands, and it POSTs results to /result. Everything is gated by a shared token.
//
// LOOPBACK / TOKEN RULE: the token defaults to the public string 'ghost-local' (same as the shipped
// extension). That is fine on 127.0.0.1, but binding off-loopback (GHOST_BRIDGE_HOST=0.0.0.0 for the
// host browser / phone) with that token would let anything reaching the port run agent tasks, so
// startBridge() refuses and falls back to 127.0.0.1 until a private GHOST_BRIDGE_TOKEN is set on
// both sides. Requests carrying a non-extension Origin are rejected regardless of bind address
// (browser-page CSRF), and the state-changing POSTs must be application/json.
//
// MULTIPLE NAMED DEVICES can connect at once (Chrome · Brave · Pixel). Each device gets its own
// command queue + held poll, so they never clobber each other; commands route to the SELECTED
// device (or an explicit one). This is the shared foundation for multi-browser AND the phone bridge.
let server = null
let cmdSeq = 0
const STALE_MS = 30000 // a device counts as "connected" if it polled within this window
const LIST_MS = 60000 // and still appears in the device list for a bit after it goes quiet

// id -> { id, name, kind, brand, lastPollAt, waiter, waiterTimer, queue: [] }
const devices = new Map()
let selectedId = null
const pending = new Map() // command id -> { resolve, reject, timer }
let deviceListeners = []

let taskHandler = null // called when a client pushes a task UP (e.g. right-click "Ask Ghost")

// Chat mirror: the app pushes its transcript here; the extension side panel long-polls /chat to
// render it. seq is bumped on every change so /chat?since=N can hold until there's something new.
let chatState = { seq: 0, messages: [], mirroring: false }
let chatWaiters = [] // { res, timer } held GET /chat responses awaiting the next update

// Register a handler for tasks a client sends UP to the app (reverse direction).
export function onBridgeTask(cb) {
  taskHandler = cb
}

// Subscribe to device list/selection changes (for the app's device picker). Returns an unsubscribe.
export function onDevicesChanged(cb) {
  deviceListeners.push(cb)
  return () => {
    deviceListeners = deviceListeners.filter((f) => f !== cb)
  }
}
function emitDevices() {
  const list = listDevices()
  for (const cb of deviceListeners) {
    try {
      cb(list)
    } catch {}
  }
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}

const deviceConnected = (d) => !!d && Date.now() - d.lastPollAt < STALE_MS

// DEVICE KINDS: 'browser' (the Chrome extension) and 'phone' (the connector app). They speak
// different command sets, so anything that routes a command should say which kind it wants — a
// connected phone must never make the app think "Chrome is here" and ship browser_* commands to it.
// `kind` is optional everywhere below; omitting it means "any device" (the old behaviour).
export const KIND_BROWSER = 'browser'
export const KIND_PHONE = 'phone'
const deviceKind = (d) => d.kind || KIND_BROWSER
const kindMatches = (d, kind) => !kind || deviceKind(d) === kind

// Public: is anything (or a specific device, or any device of a given kind) connected and listening?
export function bridgeConnected(deviceId, kind = null) {
  if (deviceId) {
    const d = devices.get(deviceId)
    return deviceConnected(d) && kindMatches(d, kind)
  }
  for (const d of devices.values()) if (deviceConnected(d) && kindMatches(d, kind)) return true
  return false
}

// Kind-aware conveniences for the callers that care which hands they're using.
export const browserConnected = (deviceId = null) => bridgeConnected(deviceId, KIND_BROWSER)
export const phoneConnected = (deviceId = null) => bridgeConnected(deviceId, KIND_PHONE)

// Deduplicated, display-ready device list (most-recently-seen first). Duplicate names (two Chromes)
// get a numeric suffix so they're tellable apart.
export function listDevices() {
  const recent = [...devices.values()].filter((d) => Date.now() - d.lastPollAt < LIST_MS)
  recent.sort((a, b) => b.lastPollAt - a.lastPollAt)
  const counts = new Map()
  return recent.map((d) => {
    const base = d.name || d.brand || (d.kind === 'phone' ? 'Phone' : 'Browser')
    const n = (counts.get(base) || 0) + 1
    counts.set(base, n)
    return {
      id: d.id,
      name: n > 1 ? `${base} ${n}` : base,
      kind: d.kind || 'browser',
      brand: d.brand || '',
      connected: deviceConnected(d),
      selected: d.id === selectedId
    }
  })
}

export function getSelectedDeviceId() {
  return selectedId
}

// Point future commands at a specific device. Returns false if that device isn't known.
export function selectDevice(id) {
  if (!devices.has(id)) return false
  selectedId = id
  emitDevices()
  return true
}

// Where does a command go? explicit id → the selected device → the most-recently-active connected
// one (which then becomes the selection). Null when nothing's connected. An explicit id is all or
// nothing: if that device is unknown, stale or (with a `kind`) the wrong kind, the command is
// refused rather than silently rerouted to some other device — a phone tap must never land on a
// different phone. With a `kind`, only devices of that kind qualify at every step: a selected phone
// is skipped for a browser command (and vice versa) without disturbing the user's selection, and the
// fallback only claims the selection when nothing live is selected.
function pickTarget(deviceId, kind = null) {
  if (deviceId) {
    const d = devices.get(deviceId)
    return deviceConnected(d) && kindMatches(d, kind) ? d : null
  }
  const sel = devices.get(selectedId)
  if (deviceConnected(sel) && kindMatches(sel, kind)) return sel
  let best = null
  for (const d of devices.values()) {
    if (deviceConnected(d) && kindMatches(d, kind) && (!best || d.lastPollAt > best.lastPollAt)) best = d
  }
  if (best && !deviceConnected(sel)) selectedId = best.id
  return best
}

function deliverNext(d) {
  if (d.waiter && d.queue.length) {
    clearTimeout(d.waiterTimer)
    const res = d.waiter
    d.waiter = null
    d.waiterTimer = null
    // A device can't poll while it runs a command, so count delivery as liveness — otherwise a
    // long command (readPages, waitFor) makes it look disconnected mid-flight.
    d.lastPollAt = Date.now()
    sendJson(res, 200, d.queue.shift())
  }
}

// Push the current chat transcript to any connected side panel. `mirroring=false` tells the panel
// the user has the mirror turned off (so it shows a hint instead of a stale conversation).
export function setChatState(messages, mirroring = true) {
  chatState = { seq: chatState.seq + 1, messages: Array.isArray(messages) ? messages : [], mirroring: !!mirroring }
  const waiters = chatWaiters
  chatWaiters = []
  for (const w of waiters) {
    clearTimeout(w.timer)
    try {
      sendJson(w.res, 200, chatState)
    } catch {}
  }
}

// Queue a command for a device and resolve with its result. Targets the selected device unless a
// deviceId is given; with `kind` only a device of that kind is eligible (see pickTarget). Rejects if
// nothing suitable is connected, or on the device's error/timeout.
export function sendCommand(cmd, args = {}, timeoutMs = 25000, deviceId = null, kind = null) {
  return new Promise((resolve, reject) => {
    const target = pickTarget(deviceId, kind)
    if (!target) {
      const hint =
        kind === KIND_BROWSER
          ? 'no Ghost-Prime browser is connected (load the Chrome extension)'
          : kind === KIND_PHONE
            ? 'no Ghost-Prime phone is connected (open the connector app)'
            : 'no Ghost-Prime device is connected (load the Chrome extension, or connect the phone app)'
      const named = deviceId && devices.get(deviceId)
      const wrongKind = named && kind && deviceConnected(named) && !kindMatches(named, kind)
      // An explicit device is refused even if others of the kind are live (no rerouting); only add
      // the "nothing connected" hint when that's actually the case.
      const tail = bridgeConnected(null, kind) ? '' : ` — ${hint}`
      if (wrongKind) return reject(new Error(`device "${named.name || named.id}" is a ${deviceKind(named)}, not a ${kind}${tail}`))
      if (deviceId) return reject(new Error(`device "${(named && named.name) || deviceId}" is not connected${tail}`))
      return reject(new Error(hint))
    }
    const id = `c${++cmdSeq}`
    const timer = setTimeout(() => {
      pending.delete(id)
      // Never let a timed-out command be handed out on a later poll (device was busy / restarting / suspended).
      target.queue = target.queue.filter((c) => c.id !== id)
      reject(new Error(`device "${target.name || target.id}" did not respond to "${cmd}" in time`))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer, deviceId: target.id })
    target.queue.push({ id, cmd, args, ts: Date.now() })
    deliverNext(target)
  })
}

// Browser-only / phone-only sends, so callers can't accidentally target the other kind of hands.
export const sendBrowserCommand = (cmd, args = {}, timeoutMs = 25000, deviceId = null) =>
  sendCommand(cmd, args, timeoutMs, deviceId, KIND_BROWSER)
export const sendPhoneCommand = (cmd, args = {}, timeoutMs = 25000, deviceId = null) =>
  sendCommand(cmd, args, timeoutMs, deviceId, KIND_PHONE)

// Fire-and-forget to EVERY connected device of a kind (used for 'reload', which restarts the
// extension worker — phones don't know that command, so they're skipped).
function broadcast(cmd, args = {}, kind = null) {
  for (const d of devices.values()) {
    if (!kindMatches(d, kind)) continue
    d.queue.push({ id: 'fire', cmd, args, ts: Date.now() })
    deliverNext(d)
  }
}

// Dev convenience: watch the unpacked extension folder; when a file changes, tell the connected
// extension(s) to chrome.runtime.reload() — they re-read from disk, so edits go live with no manual
// "reload" in chrome://extensions. No-op until something connects.
export function watchExtensionForReload(dir, deployDir = null) {
  // Mirror the project's extension/ into a shared folder so it loads from a restart-safe path.
  const mirror = () => {
    if (!deployDir) return
    try {
      mkdirSync(deployDir, { recursive: true })
      cpSync(dir, deployDir, { recursive: true })
      writeBridgeConfig(deployDir) // keep the deployed copy's connection defaults in step with .env
    } catch (e) {
      console.warn(`[bridge] couldn't mirror extension → ${deployDir}: ${e.message}`)
    }
  }
  mirror() // initial sync on launch
  if (deployDir) console.log(`[ghost] mirroring extension → ${deployDir}`)
  let timer = null
  try {
    watch(dir, () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        mirror() // keep the shared copy in sync FIRST, then reload (Chrome re-reads where it loaded)
        if (bridgeConnected(null, KIND_BROWSER)) {
          console.log('[ghost] extension changed → reloading it in Chrome')
          broadcast('reload', {}, KIND_BROWSER)
        }
      }, 300)
    })
    console.log('[ghost] watching extension/ for live reload')
  } catch (e) {
    console.warn('[bridge] cannot watch extension dir:', e.message)
  }
}

// Constant-time token compare (a plain !== leaks the matching prefix length via timing).
function tokenMatches(given, expected) {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

const isJson = (req) => String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')

let bridgeInfo = null // { port, host, downgraded } — what startBridge() actually bound

// What the bridge is actually listening on (null before startBridge()). Lets browser.js explain a
// "not connected" error when the cause is the loopback downgrade below, not a missing extension.
export function getBridgeInfo() {
  return bridgeInfo
}

// Returns { port, host, downgraded } so index.js / the UI can surface a loopback fallback.
export function startBridge() {
  if (server) return bridgeInfo
  // Read at call time (after dotenv has loaded — module-top would run before .env is applied).
  const port = Number(process.env.GHOST_BRIDGE_PORT || 8731)
  const token = process.env.GHOST_BRIDGE_TOKEN || 'ghost-local'
  let host = (process.env.GHOST_BRIDGE_HOST || '127.0.0.1').trim() // 0.0.0.0 lets a phone / host browser reach it
  // Any loopback spelling (LOCALHOST, 127.0.0.2, ::1) is fine with the default token.
  const h = host.toLowerCase()
  const isLoopback = h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h)
  let downgraded = false
  if (token === 'ghost-local') {
    console.warn('[bridge] using the default token "ghost-local" — set a private GHOST_BRIDGE_TOKEN in .env (and the same in the extension / phone app)')
    if (!isLoopback) {
      console.error(`[bridge] GHOST_BRIDGE_HOST=${host} with the default token "ghost-local" would let anything that can reach this port run tasks in the agent. Binding to 127.0.0.1 instead — set a private GHOST_BRIDGE_TOKEN (and the same token in the extension / phone app) to enable ${host}.`)
      host = '127.0.0.1'
      downgraded = true
    }
  }
  bridgeInfo = { port, host, downgraded }
  server = http.createServer((req, res) => {
    let url
    try {
      url = new URL(req.url, 'http://127.0.0.1')
    } catch {
      return sendJson(res, 400, { error: 'bad url' })
    }
    if (!tokenMatches(url.searchParams.get('token'), token)) return sendJson(res, 403, { error: 'bad token' })
    // Browser-page CSRF guard: the extension's worker/panel/options send Origin chrome-extension://…,
    // the phone app and scripts send none; any other Origin is a web page and gets refused.
    const origin = req.headers.origin
    if (origin && !origin.startsWith('chrome-extension://')) return sendJson(res, 403, { error: 'bad origin' })

    // A client polls for its next command, identifying itself. Id-less pollers (the older extension)
    // collapse to a single default browser device, so nothing breaks before the extension reports id.
    if (req.method === 'GET' && url.pathname === '/poll') {
      const id = url.searchParams.get('id') || 'browser-default'
      let d = devices.get(id)
      if (!d) {
        d = { id, name: '', kind: 'browser', brand: '', lastPollAt: 0, waiter: null, waiterTimer: null, queue: [] }
        devices.set(id, d)
      }
      const wasConnected = deviceConnected(d)
      d.lastPollAt = Date.now()
      // Normalise the kind so an unknown/capitalised value can't produce a device that is neither
      // browser nor phone (invisible to every kind-aware route yet still "connected").
      const k = String(url.searchParams.get('kind') || d.kind || KIND_BROWSER).trim().toLowerCase()
      d.kind = k === KIND_PHONE ? KIND_PHONE : KIND_BROWSER
      d.brand = url.searchParams.get('brand') || d.brand || ''
      d.name = url.searchParams.get('name') || d.name || d.brand || (d.kind === 'phone' ? 'Phone' : 'Chrome')
      if (!deviceConnected(devices.get(selectedId))) selectedId = id // auto-select the first/only live device
      if (!wasConnected) emitDevices() // a (re)connection — refresh the app's picker

      // Drop any stale held poll for this same device before holding a new one.
      if (d.waiter) {
        clearTimeout(d.waiterTimer)
        try {
          sendJson(d.waiter, 200, {})
        } catch {}
        d.waiter = null
        d.waiterTimer = null
      }
      if (d.queue.length) return sendJson(res, 200, d.queue.shift())
      d.waiter = res
      d.waiterTimer = setTimeout(() => {
        if (d.waiter === res) {
          d.waiter = null
          d.waiterTimer = null
          sendJson(res, 200, {})
        }
      }, 25000)
      res.on('close', () => {
        if (d.waiter === res) {
          clearTimeout(d.waiterTimer)
          d.waiter = null
          d.waiterTimer = null
        }
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/result') {
      if (!isJson(req)) return sendJson(res, 415, { error: 'expected application/json' })
      let body = ''
      req.on('data', (d) => (body += d))
      req.on('end', () => {
        try {
          const { id, ok, data, error } = JSON.parse(body || '{}')
          const p = pending.get(id)
          if (p) {
            clearTimeout(p.timer)
            pending.delete(id)
            if (p.deviceId && devices.has(p.deviceId)) devices.get(p.deviceId).lastPollAt = Date.now() // answered → alive
            ok ? p.resolve(data) : p.reject(new Error(error || 'device error'))
          }
          sendJson(res, 200, { ok: true })
        } catch {
          sendJson(res, 400, { error: 'bad result body' })
        }
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/task') {
      if (!isJson(req)) return sendJson(res, 415, { error: 'expected application/json' })
      let body = ''
      req.on('data', (d) => (body += d))
      req.on('end', () => {
        try {
          const { prompt } = JSON.parse(body || '{}')
          if (prompt && taskHandler) taskHandler(String(prompt))
          sendJson(res, 200, { ok: true })
        } catch {
          sendJson(res, 400, { error: 'bad task' })
        }
      })
      return
    }

    // Side panel pulls the mirrored chat. Long-poll: respond now if there's something newer than
    // ?since, otherwise hold the connection until setChatState() fires or it times out.
    if (req.method === 'GET' && url.pathname === '/chat') {
      const since = Number(url.searchParams.get('since') || -1)
      if (chatState.seq > since) return sendJson(res, 200, chatState)
      const timer = setTimeout(() => {
        chatWaiters = chatWaiters.filter((w) => w.res !== res)
        sendJson(res, 200, chatState)
      }, 25000)
      const entry = { res, timer }
      chatWaiters.push(entry)
      res.on('close', () => {
        clearTimeout(timer)
        chatWaiters = chatWaiters.filter((w) => w !== entry)
      })
      return
    }

    if (url.pathname === '/ping') {
      return sendJson(res, 200, {
        ok: true,
        connected: bridgeConnected(),
        browser: bridgeConnected(null, KIND_BROWSER),
        phone: bridgeConnected(null, KIND_PHONE),
        devices: listDevices()
      })
    }
    sendJson(res, 404, { error: 'not found' })
  })
  server.on('error', (e) => console.error('[bridge] error:', e.message))
  server.listen(port, host, () => console.log(`[ghost] browser bridge listening on ${host}:${port}`))
  return bridgeInfo
}

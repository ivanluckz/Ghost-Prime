import http from 'node:http'
import { watch, cpSync, mkdirSync } from 'node:fs'

// Local bridge between Ghost-Prime and its executor clients — your real Chrome (via the extension)
// and, later, a phone connector app. Transport is plain HTTP long-poll on a loopback/LAN socket:
// each client repeatedly GETs /poll (identifying itself with id/name/kind), we hand it queued
// commands, and it POSTs results to /result. Everything is gated by a shared token.
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

// Public: is anything (or a specific device) connected and listening?
export function bridgeConnected(deviceId) {
  if (deviceId) return deviceConnected(devices.get(deviceId))
  for (const d of devices.values()) if (deviceConnected(d)) return true
  return false
}

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
// one (which then becomes the selection). Null when nothing's connected.
function pickTarget(deviceId) {
  if (deviceId && deviceConnected(devices.get(deviceId))) return devices.get(deviceId)
  if (deviceConnected(devices.get(selectedId))) return devices.get(selectedId)
  let best = null
  for (const d of devices.values()) if (deviceConnected(d) && (!best || d.lastPollAt > best.lastPollAt)) best = d
  if (best) selectedId = best.id
  return best
}

function deliverNext(d) {
  if (d.waiter && d.queue.length) {
    clearTimeout(d.waiterTimer)
    const res = d.waiter
    d.waiter = null
    d.waiterTimer = null
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
// deviceId is given. Rejects if nothing is connected, or on the device's error/timeout.
export function sendCommand(cmd, args = {}, timeoutMs = 25000, deviceId = null) {
  return new Promise((resolve, reject) => {
    const target = pickTarget(deviceId)
    if (!target) {
      return reject(new Error('no Ghost-Prime device is connected (load the Chrome extension, or connect the phone app)'))
    }
    const id = `c${++cmdSeq}`
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`device "${target.name || target.id}" did not respond to "${cmd}" in time`))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    target.queue.push({ id, cmd, args })
    deliverNext(target)
  })
}

// Fire-and-forget to EVERY connected device (used for 'reload', which restarts the worker).
function broadcast(cmd, args = {}) {
  for (const d of devices.values()) {
    d.queue.push({ id: 'fire', cmd, args })
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
        if (bridgeConnected()) {
          console.log('[ghost] extension changed → reloading it in Chrome')
          broadcast('reload')
        }
      }, 300)
    })
    console.log('[ghost] watching extension/ for live reload')
  } catch (e) {
    console.warn('[bridge] cannot watch extension dir:', e.message)
  }
}

export function startBridge() {
  if (server) return
  // Read at call time (after dotenv has loaded — module-top would run before .env is applied).
  const port = Number(process.env.GHOST_BRIDGE_PORT || 8731)
  const token = process.env.GHOST_BRIDGE_TOKEN || 'ghost-local'
  const host = process.env.GHOST_BRIDGE_HOST || '127.0.0.1' // 0.0.0.0 lets a phone / host browser reach it
  server = http.createServer((req, res) => {
    let url
    try {
      url = new URL(req.url, 'http://127.0.0.1')
    } catch {
      return sendJson(res, 400, { error: 'bad url' })
    }
    if (url.searchParams.get('token') !== token) return sendJson(res, 403, { error: 'bad token' })

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
      d.kind = url.searchParams.get('kind') || d.kind || 'browser'
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
      let body = ''
      req.on('data', (d) => (body += d))
      req.on('end', () => {
        try {
          const { id, ok, data, error } = JSON.parse(body || '{}')
          const p = pending.get(id)
          if (p) {
            clearTimeout(p.timer)
            pending.delete(id)
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

    if (url.pathname === '/ping') return sendJson(res, 200, { ok: true, connected: bridgeConnected(), devices: listDevices() })
    sendJson(res, 404, { error: 'not found' })
  })
  server.on('error', (e) => console.error('[bridge] error:', e.message))
  server.listen(port, host, () => console.log(`[ghost] browser bridge listening on ${host}:${port}`))
}

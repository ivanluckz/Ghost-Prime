import http from 'node:http'
import { watch, cpSync, mkdirSync } from 'node:fs'

// Local bridge between Ghost-Prime and the browser extension running in your real Chrome.
//
// Transport is plain HTTP long-poll on 127.0.0.1 (no dependency, and big results like
// screenshots ride a normal response body): the extension repeatedly GETs /poll; when a
// browser_* tool runs we hand it a command and resolve the tool's promise once the extension
// POSTs the result back to /result. Everything is gated by a shared token and bound to loopback.
let server = null
let cmdSeq = 0
const queue = [] // commands not yet handed to the extension
const pending = new Map() // command id -> { resolve, reject, timer }
let waiter = null // a held /poll response waiting for the next command
let lastPollAt = 0
let taskHandler = null // called when the extension pushes a task (e.g. right-click "Ask Ghost")

// Chat mirror: the app pushes its transcript here; the extension side panel long-polls /chat to
// render it. seq is bumped on every change so /chat?since=N can hold until there's something new.
let chatState = { seq: 0, messages: [], mirroring: false }
let chatWaiters = [] // { res, timer } held GET /chat responses awaiting the next update

// Register a handler for tasks the extension sends UP to the app (reverse direction).
export function onBridgeTask(cb) {
  taskHandler = cb
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

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}

function deliverNext() {
  if (waiter && queue.length) {
    const res = waiter
    waiter = null
    sendJson(res, 200, queue.shift())
  }
}

// True if the extension has polled recently — i.e. a real Chrome is connected and listening.
export function bridgeConnected() {
  return Date.now() - lastPollAt < 30000
}

// Queue a command for the extension and resolve with its result (or reject on error/timeout).
export function sendCommand(cmd, args = {}, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    if (!bridgeConnected()) {
      return reject(new Error('the Ghost-Prime browser extension is not connected (load it in Chrome and check the port/token)'))
    }
    const id = `c${++cmdSeq}`
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`browser extension did not respond to "${cmd}" in time`))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    queue.push({ id, cmd, args })
    deliverNext()
  })
}

// Fire-and-forget command — no result awaited (for 'reload', which kills the extension worker).
function pushCommand(cmd, args = {}) {
  queue.push({ id: 'fire', cmd, args })
  deliverNext()
}

// Dev convenience: watch the unpacked extension folder; when a file changes, tell the connected
// extension to chrome.runtime.reload() — it re-reads from disk, so edits go live with no manual
// "reload" in chrome://extensions. No-op until the extension connects.
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
          pushCommand('reload')
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
  const host = process.env.GHOST_BRIDGE_HOST || '127.0.0.1' // 0.0.0.0 lets the Chrome OS host browser reach it
  server = http.createServer((req, res) => {
    let url
    try {
      url = new URL(req.url, 'http://127.0.0.1')
    } catch {
      return sendJson(res, 400, { error: 'bad url' })
    }
    if (url.searchParams.get('token') !== token) return sendJson(res, 403, { error: 'bad token' })

    if (req.method === 'GET' && url.pathname === '/poll') {
      lastPollAt = Date.now()
      if (queue.length) return sendJson(res, 200, queue.shift())
      waiter = res // hold the connection open until a command arrives (or it times out)
      const t = setTimeout(() => {
        if (waiter === res) {
          waiter = null
          sendJson(res, 200, {})
        }
      }, 25000)
      res.on('close', () => {
        clearTimeout(t)
        if (waiter === res) waiter = null
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
            ok ? p.resolve(data) : p.reject(new Error(error || 'browser extension error'))
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

    if (url.pathname === '/ping') return sendJson(res, 200, { ok: true, connected: bridgeConnected() })
    sendJson(res, 404, { error: 'not found' })
  })
  server.on('error', (e) => console.error('[bridge] error:', e.message))
  server.listen(port, host, () => console.log(`[ghost] browser bridge listening on ${host}:${port}`))
}

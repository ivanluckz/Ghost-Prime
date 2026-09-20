// Verify the browser bridge transport (app side) without Chrome: start the server, act as the
// extension (poll + post results), and confirm sendCommand round-trips and the token is enforced.
// Run: node scripts/smoke-bridge.mjs
//
// Runs on a PRIVATE port + token (8742 / smoke-bridge-token) rather than the app's 8731 /
// ghost-local: with the real app open, binding 8731 would fail with EADDRINUSE and our fake
// extension would then long-poll the LIVE bridge, registering as a connected browser device and
// answering the agent's real commands with fake results. Override with GHOST_SMOKE_BRIDGE_PORT /
// GHOST_SMOKE_BRIDGE_TOKEN; either way we refuse to start if anything already answers on the port.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBridge, sendCommand, bridgeConnected, onBridgeTask, watchExtensionForReload } from '../src/main/tools/browser-bridge.js'

const PORT = process.env.GHOST_SMOKE_BRIDGE_PORT || 8742
const TOKEN = process.env.GHOST_SMOKE_BRIDGE_TOKEN || 'smoke-bridge-token'
// startBridge() reads these at call time — pin them so a .env / shell GHOST_BRIDGE_* (the live
// app's settings) can never leak in.
process.env.GHOST_BRIDGE_PORT = String(PORT)
process.env.GHOST_BRIDGE_TOKEN = TOKEN
process.env.GHOST_BRIDGE_HOST = '127.0.0.1'
const base = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Pre-flight: anything that already answers here (a running app, another smoke) means our server
// would silently lose the bind and the checks below would talk to someone else's bridge.
const occupied = await fetch(`${base}/ping?token=${TOKEN}`, { signal: AbortSignal.timeout(1500) })
  .then((r) => r.status)
  .catch(() => null)
if (occupied !== null) {
  console.error(`❌ something already answers on ${base} (HTTP ${occupied}) — refusing to run against it.`)
  console.error('   Pick a free port: GHOST_SMOKE_BRIDGE_PORT=8743 node scripts/smoke-bridge.mjs')
  process.exit(2)
}

let pass = 0
let fail = 0
const check = (n, ok) => {
  console.log((ok ? '✅ ' : '❌ ') + n)
  ok ? pass++ : fail++
}

startBridge()
await sleep(200)
// The pre-flight only catches an HTTP responder; a non-HTTP listener (or a race with another smoke)
// makes startBridge() log EADDRINUSE without throwing. Confirm OUR server answers before checking.
const bound = await fetch(`${base}/ping?token=${TOKEN}`, { signal: AbortSignal.timeout(1500) })
  .then((r) => r.ok)
  .catch(() => false)
if (!bound) {
  console.error(`❌ bridge failed to bind ${base} (see [bridge] error above) — refusing to run.`)
  console.error('   Pick a free port: GHOST_SMOKE_BRIDGE_PORT=8743 node scripts/smoke-bridge.mjs')
  process.exit(2)
}

check('not connected before any poll', bridgeConnected() === false)

// Stand in for the extension: poll, run a fake command, post the result.
let stop = false
let lastCmd = null
;(async () => {
  while (!stop) {
    try {
      const job = await (await fetch(`${base}/poll?token=${TOKEN}`)).json()
      if (job && job.cmd) {
        lastCmd = job.cmd
        const data = job.cmd === 'getText' ? { url: 'http://x', title: 'X', text: 'hello' } : { ok: true }
        await fetch(`${base}/result?token=${TOKEN}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: job.id, ok: true, data })
        })
      }
    } catch {
      await sleep(100)
    }
  }
})()

await sleep(300)
check('connected after the extension polls', bridgeConnected() === true)

const res = await sendCommand('getText', {})
check('sendCommand round-trips the result', res && res.text === 'hello')

const status = await fetch(`${base}/poll?token=wrong`).then((r) => r.status)
check('bad token is rejected (403)', status === 403)

// Reverse channel: the extension's right-click push (/task) fires the registered handler.
let pushed = null
onBridgeTask((p) => (pushed = p))
await fetch(`${base}/task?token=${TOKEN}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: 'hello from right-click' })
})
await sleep(100)
check('/task fires the task handler', pushed === 'hello from right-click')

// Live-reload: a change in the watched extension dir pushes a 'reload' command to the extension.
const extDir = mkdtempSync(join(tmpdir(), 'ghost-ext-'))
writeFileSync(join(extDir, 'background.js'), '// v1')
watchExtensionForReload(extDir)
await sleep(200)
lastCmd = null
writeFileSync(join(extDir, 'background.js'), '// v2 ' + Date.now())
await sleep(800) // debounce (300ms) + delivery
check('extension file change → reload pushed', lastCmd === 'reload')

stop = true
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

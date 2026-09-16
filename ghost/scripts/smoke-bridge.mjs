// Verify the browser bridge transport (app side) without Chrome: start the server, act as the
// extension (poll + post results), and confirm sendCommand round-trips and the token is enforced.
// Run: node scripts/smoke-bridge.mjs
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBridge, sendCommand, bridgeConnected, onBridgeTask, watchExtensionForReload } from '../src/main/tools/browser-bridge.js'

const PORT = process.env.GHOST_BRIDGE_PORT || 8731
const TOKEN = process.env.GHOST_BRIDGE_TOKEN || 'ghost-local'
const base = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const check = (n, ok) => {
  console.log((ok ? '✅ ' : '❌ ') + n)
  ok ? pass++ : fail++
}

startBridge()
await sleep(200)

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

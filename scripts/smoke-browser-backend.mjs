// Verify the 'auto' backend picker in src/main/tools/browser.js without a real Chrome:
//   • a connected PHONE (kind=phone) never counts as Chrome — browser_* falls back to Playwright and
//     the phone's queue never sees a browser command
//   • auto-launch runs ONCE: after Chrome came up with no extension, later actions don't spawn
//     Chrome again / stall ~12s each (the outcome is remembered until an extension connects)
//   • no auto-launch while a Playwright context is already open
//   • an extension that connects LATER is picked up on the very next action
//   • fill+pressEnter / hover on the extension backend carry the extension's url + events
// Run: node --import ./scripts/lib/register-electron-stub.mjs scripts/smoke-browser-backend.mjs
import { mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'

const PORT = process.env.GHOST_SMOKE_BRIDGE_PORT || 8744
const TOKEN = process.env.GHOST_SMOKE_BRIDGE_TOKEN || 'smoke-backend-token'
process.env.GHOST_BRIDGE_PORT = String(PORT)
process.env.GHOST_BRIDGE_TOKEN = TOKEN
process.env.GHOST_BRIDGE_HOST = '127.0.0.1'
// Playwright side: headless bundled Chromium on a throwaway profile; 'auto' picks the backend.
const TMP = process.env.GHOST_SMOKE_TMP || `/tmp/claude-${process.getuid?.() ?? 'x'}/ghost-smoke-backend`
mkdirSync(TMP, { recursive: true })
process.env.GHOST_BROWSER_BACKEND = 'auto'
process.env.GHOST_BROWSER_HEADLESS = 'true'
process.env.GHOST_BROWSER_CHANNEL = ''
process.env.GHOST_BROWSER_PROFILE = join(TMP, 'profile')
process.env.GHOST_BROWSER_AUTOLAUNCH = '1'
process.env.GHOST_PAGE_CONTEXT = '1'
// A fake "google-chrome": records every spawn, then exits (no extension ever connects from it).
const spawnLog = join(TMP, 'spawns.log')
writeFileSync(spawnLog, '')
const fakeChrome = join(TMP, 'fake-chrome.sh')
writeFileSync(fakeChrome, `#!/bin/sh\necho spawn >> "${spawnLog}"\nexit 0\n`)
chmodSync(fakeChrome, 0o755)
process.env.GHOST_CHROME_BIN = fakeChrome
const spawns = () => readFileSync(spawnLog, 'utf8').split('\n').filter(Boolean).length

const base = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const occupied = await fetch(`${base}/ping?token=${TOKEN}`, { signal: AbortSignal.timeout(1500) })
  .then((r) => r.status)
  .catch(() => null)
if (occupied !== null) {
  console.error(`❌ something already answers on ${base} (HTTP ${occupied}) — refusing to run against it.`)
  process.exit(2)
}

const bridge = await import('../src/main/tools/browser-bridge.js')
const browser = await import('../src/main/tools/browser.js')
bridge.startBridge()
await sleep(200)

let pass = 0
let fail = 0
const check = (n, ok, extra = '') => {
  console.log((ok ? '✅ ' : '❌ ') + n + (extra ? ` — ${extra}` : ''))
  ok ? pass++ : fail++
}

// Fake devices: each polls the bridge as a given kind and answers whatever it gets.
function fakeDevice(id, kind, answer) {
  const seen = []
  let stop = false
  ;(async () => {
    while (!stop) {
      try {
        const job = await (await fetch(`${base}/poll?token=${TOKEN}&id=${id}&kind=${kind}&name=${id}`)).json()
        if (job && job.cmd) {
          seen.push(job.cmd)
          await fetch(`${base}/result?token=${TOKEN}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: job.id, ok: true, data: answer(job) })
          })
        }
      } catch {
        await sleep(100)
      }
    }
  })()
  return { seen, stop: () => (stop = true) }
}

const timed = async (fn) => {
  const t0 = Date.now()
  const r = await fn()
  return { r, ms: Date.now() - t0 }
}

try {
  // 1. Phone only: not "a browser" — browser tools must go to Playwright, never to the phone.
  const phone = fakeDevice('phone1', 'phone', () => ({ ok: true }))
  await sleep(300)
  check('bridge sees the phone as connected (any kind)', bridge.bridgeConnected() === true)
  check('…but not as a browser', bridge.browserConnected() === false)
  check('getActiveTabContext is null with only a phone', (await browser.getActiveTabContext()) === null)

  const first = await timed(() => browser.browserListTabs())
  check('phone-only → Playwright backend (tabs listed from the Playwright context)', Array.isArray(first.r?.tabs) && first.r.tabs.every((t) => t.windowId === 0), `${first.ms}ms`)
  check('phone never received a browser command', phone.seen.length === 0, phone.seen.join(','))
  check('auto-launch tried Chrome exactly once', spawns() === 1, `spawns=${spawns()}`)
  check('first action waited for the extension (~12s)', first.ms >= 10000 && first.ms < 20000, `${first.ms}ms`)

  // 2. The launch outcome is remembered: no respawn, no 12s stall on the next actions.
  const second = await timed(() => browser.browserListTabs())
  const third = await timed(() => browser.browserListTabs())
  check('second action is fast (no relaunch wait)', second.ms < 3000, `${second.ms}ms`)
  check('third action is fast (no relaunch wait)', third.ms < 3000, `${third.ms}ms`)
  check('Chrome was not spawned again', spawns() === 1, `spawns=${spawns()}`)

  // 3. An extension that connects later is picked up immediately, and browser commands go to it
  //    (not the phone) even though the phone is still connected.
  const ext = fakeDevice('chrome1', 'browser', (job) => {
    if (job.cmd === 'listTabs') return { tabs: [{ tabId: 7, windowId: 42, url: 'http://ext', title: 'Ext', active: true }] }
    if (job.cmd === 'getText') return { url: 'http://ext', title: 'Ext', text: 'hello from ext' }
    if (job.cmd === 'fill') return { ok: true, url: 'http://ext/form', events: [{ kind: 'dialog', type: 'confirm', message: 'fill?', action: 'accepted' }] }
    if (job.cmd === 'pressKey') return { ok: true, url: 'http://ext/submitted', events: [{ kind: 'dialog', type: 'alert', message: 'sent', action: 'accepted' }] }
    if (job.cmd === 'hover') return { ok: true, url: 'http://ext/hover', events: [{ kind: 'dialog', type: 'alert', message: 'hovered', action: 'accepted' }] }
    return { ok: true }
  })
  await sleep(300)
  check('browserConnected() flips true when a browser-kind device polls', bridge.browserConnected() === true)
  const viaExt = await timed(() => browser.browserListTabs())
  check('next action switches to the extension backend at once', viaExt.r?.tabs?.[0]?.windowId === 42 && viaExt.ms < 3000, `${viaExt.ms}ms`)
  check('the command went to the browser device, not the phone', ext.seen.includes('listTabs') && phone.seen.length === 0)
  const ctx = await browser.getActiveTabContext()
  check('getActiveTabContext reads via the browser device', ctx?.text === 'hello from ext')

  const filled = await browser.browserFill({ selector: '#q', value: 'x', pressEnter: true })
  check('fill+pressEnter reports the post-Enter url', filled?.url === 'http://ext/submitted', filled?.url)
  check('fill+pressEnter merges events from both steps', (filled?.events || []).length === 2 && filled.events[0].message === 'fill?' && filled.events[1].message === 'sent')
  const hovered = await browser.browserHover({ selector: '#menu' })
  check('hover returns the extension url and events', hovered?.url === 'http://ext/hover' && hovered?.events?.[0]?.message === 'hovered')
  check('still only one Chrome spawn overall', spawns() === 1, `spawns=${spawns()}`)

  ext.stop()
  phone.stop()
} catch (e) {
  check('smoke crashed: ' + (e?.stack || e), false)
} finally {
  await browser.browserClose().catch(() => {})
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

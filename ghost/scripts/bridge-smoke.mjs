#!/usr/bin/env node
// Proves the multi-device bridge end-to-end with no Electron and no hardware: start the bridge,
// connect the fake-phone connector, watch it register as a named device, route commands to it, and
// confirm results round-trip. Pure Node, zero cost.  Run:  node scripts/bridge-smoke.mjs
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const PORT = process.env.GHOST_BRIDGE_PORT || '8741' // off the default 8731 so it won't clash with a running app
const TOKEN = 'smoke-token'
process.env.GHOST_BRIDGE_PORT = PORT
process.env.GHOST_BRIDGE_TOKEN = TOKEN
process.env.GHOST_BRIDGE_HOST = '127.0.0.1'

const bridge = await import('../src/main/tools/browser-bridge.js')
bridge.startBridge()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let child = null
const fail = (m) => {
  console.error('✗ ' + m)
  child?.kill('SIGTERM')
  process.exit(1)
}

child = spawn(process.execPath, [join(__dir, 'fake-phone.mjs')], {
  env: { ...process.env, PHONE_PORT: PORT, PHONE_TOKEN: TOKEN, PHONE_NAME: 'Pixel 8 (sim)' },
  stdio: ['ignore', 'inherit', 'inherit']
})

try {
  // 1) the phone should register as a connected device
  let dev = null
  for (let i = 0; i < 40 && !dev; i++) {
    await sleep(250)
    dev = bridge.listDevices().find((d) => d.kind === 'phone' && d.connected)
  }
  if (!dev) fail('phone never registered as a device')
  console.log(`✓ device registered: "${dev.name}" (kind=${dev.kind}, selected=${dev.selected})`)

  // 2) as the only live device it should auto-select
  if (bridge.getSelectedDeviceId() !== dev.id) fail('phone was not auto-selected')
  console.log('✓ auto-selected as the active device')

  // 3) route a screenshot and check it round-trips
  const shot = await bridge.sendCommand('screenshot', {}, 8000)
  if (!shot || !shot.image) fail('screenshot did not round-trip')
  console.log(`✓ screenshot round-tripped (${shot.w}x${shot.h}, image "${String(shot.image).slice(0, 22)}…")`)

  // 4) route a tap with args
  const tap = await bridge.sendCommand('tap', { x: 540, y: 1850 }, 8000)
  if (!tap || tap.ok !== true || tap.x !== 540) fail('tap did not round-trip')
  console.log(`✓ tap round-tripped (${tap.x},${tap.y})`)

  // 5) a UI-tree dump (the Accessibility-tree analog)
  const ui = await bridge.sendCommand('uiDump', {}, 8000)
  if (!ui || !Array.isArray(ui.tree)) fail('uiDump did not round-trip')
  console.log(`✓ uiDump round-tripped (${ui.tree.length} node: "${ui.tree[0].text}")`)

  // 6) connection state reflects reality
  if (!bridge.bridgeConnected()) fail('bridgeConnected() should be true')
  if (!bridge.bridgeConnected(dev.id)) fail('bridgeConnected(phoneId) should be true')
  console.log('✓ bridgeConnected() = true (global and per-device)')

  console.log('\nALL GOOD — the multi-device bridge routes to a named phone client end-to-end.')
  child.kill('SIGTERM')
  await sleep(150)
  process.exit(0)
} catch (e) {
  fail(String(e?.message || e))
}

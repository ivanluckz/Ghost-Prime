#!/usr/bin/env node
// Simulates the future Android connector app: connects to the Ghost-Prime bridge as a NAMED phone
// device, long-polls /poll for commands, executes them (mocked), and POSTs results back to /result.
// It proves the bridge's multi-device contract end-to-end with zero hardware. The real APK will
// speak this exact protocol, backed by Android's Accessibility + MediaProjection APIs instead of
// these stubs.
//
// Run standalone against a live app:  PHONE_PORT=8731 PHONE_TOKEN=ghost-local node scripts/fake-phone.mjs
const HOST = process.env.PHONE_HOST || '127.0.0.1'
const PORT = process.env.PHONE_PORT || process.env.GHOST_BRIDGE_PORT || 8731
const TOKEN = process.env.PHONE_TOKEN || process.env.GHOST_BRIDGE_TOKEN || 'ghost-local'
const ID = process.env.PHONE_ID || 'phone-sim-1'
const NAME = process.env.PHONE_NAME || 'Pixel 8 (sim)'
const BRAND = process.env.PHONE_BRAND || 'Pixel'

const base = `http://${HOST}:${PORT}`
const q = (extra = '') => `token=${encodeURIComponent(TOKEN)}${extra}`
// 1x1 transparent PNG — stand-in for a real MediaProjection screenshot.
const PNG_1x1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

// Mock executor — the real app maps each of these onto an Android capability:
//   screenshot → MediaProjection · uiDump → AccessibilityService tree · tap/swipe/type → gestures
//   openApp → launch intent · key → global action (BACK/HOME/RECENTS)
function execute(cmd, args) {
  switch (cmd) {
    case 'screenshot':
      return { image: PNG_1x1, w: 1080, h: 2400 }
    case 'uiDump':
      return { tree: [{ role: 'button', text: 'Compose', bounds: [40, 1800, 200, 1900], clickable: true }] }
    case 'tap':
      return { ok: true, x: args.x, y: args.y }
    case 'swipe':
      return { ok: true }
    case 'type':
      return { ok: true, typed: args.text || '' }
    case 'openApp':
      return { ok: true, app: args.app || args.package || '' }
    case 'key':
      return { ok: true, key: args.key }
    default:
      return { ok: true, note: `mock: ${cmd}` }
  }
}

async function post(path, body) {
  return fetch(`${base}${path}?${q()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

let stop = false
process.on('SIGTERM', () => (stop = true))
process.on('SIGINT', () => (stop = true))

async function loop() {
  const pollUrl = `${base}/poll?${q(
    `&id=${encodeURIComponent(ID)}&name=${encodeURIComponent(NAME)}&kind=phone&brand=${encodeURIComponent(BRAND)}`
  )}`
  console.error(`[fake-phone] ${NAME} connecting to ${base} …`)
  while (!stop) {
    try {
      const r = await fetch(pollUrl)
      const cmd = await r.json()
      if (cmd && cmd.cmd) {
        console.error(`[fake-phone] ← ${cmd.cmd} ${JSON.stringify(cmd.args || {})}`)
        let result
        try {
          result = { id: cmd.id, ok: true, data: execute(cmd.cmd, cmd.args || {}) }
        } catch (e) {
          result = { id: cmd.id, ok: false, error: String(e?.message || e) }
        }
        if (cmd.id && cmd.id !== 'fire') await post('/result', result)
      }
    } catch (e) {
      console.error(`[fake-phone] poll error: ${String(e?.message || e)} — retrying`)
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  console.error('[fake-phone] stopped')
}

loop()

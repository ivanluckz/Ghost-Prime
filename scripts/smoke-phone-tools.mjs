// The agent-side phone_* tools against the simulated connector (scripts/fake-phone.mjs): connect,
// then screenshot / ui / tap (text + fraction + pixel) / swipe by direction / type / key / openApp
// round-trip through the bridge with the shapes the real Android app returns.
// Run: node --import ./scripts/lib/register-electron-stub.mjs scripts/smoke-phone-tools.mjs
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as bridge from '../src/main/tools/browser-bridge.js'
import * as phone from '../src/main/tools/phone.js'
import { executeTool } from '../src/main/tools/index.js'

const PORT = String(18000 + Math.floor(Math.random() * 1000))
const TOKEN = 'smoke-phone-' + PORT
process.env.GHOST_BRIDGE_PORT = PORT
process.env.GHOST_BRIDGE_TOKEN = TOKEN
process.env.GHOST_BRIDGE_HOST = '127.0.0.1'
const __dir = dirname(fileURLToPath(import.meta.url))

let pass = 0, fail = 0
const check = (name, ok, extra = '') => { console.log((ok ? '✅ ' : '❌ ') + name + (extra ? ` — ${extra}` : '')); ok ? pass++ : fail++ }

bridge.startBridge()
const child = spawn(process.execPath, [join(__dir, 'fake-phone.mjs')], { env: { ...process.env, PHONE_PORT: PORT, PHONE_TOKEN: TOKEN, PHONE_NAME: 'Galaxy A05 (sim)' }, stdio: ['ignore', 'ignore', 'inherit'] })
try {
  for (let i = 0; i < 40 && !phone.phoneConnected(); i++) await new Promise((r) => setTimeout(r, 100))
  check('phone connects', phone.phoneConnected())
  const shot = await phone.phoneScreenshot()
  check('screenshot → base64 + size', shot.base64.length > 20 && shot.w === 1080 && shot.h === 2400)
  const ui = await phone.phoneUi()
  check('ui lists elements with tap points', ui.items.length === 1 && ui.items[0].x === 120 && /\[1\] "Compose"/.test(ui.formatted))
  check('tap by text', (await phone.phoneTap({ text: 'Compose' })).ok === true)
  const t2 = await phone.phoneTap({ x: 0.5, y: 0.25 })
  check('tap by fraction uses screen size', t2.x === 540 && t2.y === 600, JSON.stringify(t2))
  const t3 = await phone.phoneTap({ x: 120, y: 1850 })
  check('tap by pixels passes through', t3.x === 120 && t3.y === 1850)
  check('swipe by direction', (await phone.phoneSwipe({ direction: 'up' })).ok === true)
  check('type', (await phone.phoneType({ text: 'hello' })).typed === 'hello')
  check('key', (await phone.phoneKey({ key: 'home' })).key === 'home')
  check('open app', (await phone.phoneOpenApp({ app: 'com.whatsapp' })).app === 'com.whatsapp')
  let msg = ''
  try { await phone.phoneKey({ key: 'volume' }) } catch (e) { msg = e.message }
  check('bad key rejected', /back \| home \| recents/.test(msg))
  // Through the Gemini dispatcher (text + image shapes the UI/tool feed expect).
  const r = await executeTool('phone_screenshot', {})
  check('executeTool phone_screenshot returns image', /^data:image\/png;base64,/.test(r.image) && /1080×2400/.test(r.output))
  const u = await executeTool('phone_ui', {})
  check('executeTool phone_ui formatted', /Phone screen/.test(u.output))
} catch (e) {
  check('unexpected failure', false, e.stack || e.message)
} finally {
  child.kill()
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

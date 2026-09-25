// When the browser fails to START, the message must name the real cause. Every launch crash used to
// be reported as "Chrome is already running, close all Chrome windows, or set
// GHOST_BROWSER_PROFILE=isolated", even with no display and even when the isolated profile was
// already in use (the showcase default), so the booth troubleshooting went the wrong way.
// Headed launch with no display (DISPLAY unset), bundled Chromium, temp profile. No internet.
// Run: node --import ./scripts/lib/register-electron-stub.mjs scripts/smoke-browser-launch-error.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

delete process.env.DISPLAY
delete process.env.WAYLAND_DISPLAY
process.env.GHOST_BROWSER_BACKEND = 'playwright'
process.env.GHOST_BROWSER_HEADLESS = '0'
process.env.GHOST_BROWSER_CHANNEL = ''
const profile = mkdtempSync(join(tmpdir(), 'ghost-launch-profile-'))
process.env.GHOST_BROWSER_PROFILE = profile

let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && extra ? `  → ${String(extra).slice(0, 400)}` : ''}`)
}
const b = await import('../src/main/tools/browser.js')
let msg = ''
try {
  await b.browserNavigate({ url: 'http://127.0.0.1:9/' })
} catch (e) {
  msg = e.message
}
check(!!msg, 'a headed launch with no display fails', msg)
check(!/already running/i.test(msg), 'it is not blamed on "Chrome is already running"', msg)
check(/display|X server/i.test(msg), 'the message names the missing display', msg)
check(!/\x1b\[|Call log:/.test(msg) && msg.length < 500, 'the message is short and clean', JSON.stringify(msg))
await b.browserClose?.().catch(() => {})
rmSync(profile, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

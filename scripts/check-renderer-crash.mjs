// The app window must come back by itself if its renderer crashes (out of memory on a 4 GB
// Chromebook). It used to stay blank until Ghost-Prime was restarted.
// Launches the BUILT app (npx electron-vite build first) under Xvfb with a throwaway HOME, crashes
// the renderer over the DevTools protocol, and waits for the chat box to be back.
// Run: node scripts/check-renderer-crash.mjs      (needs xvfb-run when there is no display)
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const port = 9300 + Math.floor(Math.random() * 500)
const home = mkdtempSync(join(tmpdir(), 'ghost-crash-home-'))
const env = { ...process.env, HOME: home, GHOST_PROACTIVE: '0', GHOST_AUTO_SUMMARIZE: '0', GHOST_CANVA: '0', DISCORD_BOT_TOKEN: '', GHOST_BRIDGE_PORT: String(port + 1000) }
const cmd = process.env.DISPLAY ? ['node_modules/electron/dist/electron'] : ['xvfb-run', '-a', 'node_modules/electron/dist/electron']
const app = spawn(cmd[0], [...cmd.slice(1), '.', '--no-sandbox', `--remote-debugging-port=${port}`], { env, cwd: new URL('..', import.meta.url).pathname })
let log = ''
app.stdout.on('data', (d) => (log += d))
app.stderr.on('data', (d) => (log += d))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && extra ? `  → ${String(extra).slice(0, 400)}` : ''}`)
}
async function mainPage(browser) {
  for (let i = 0; i < 80; i++) {
    const page = browser.contexts().flatMap((c) => c.pages()).find((p) => /index\.html/.test(p.url()))
    if (page) return page
    await sleep(250)
  }
  return null
}
async function chatBox(page, tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (await page.locator('.chat-input textarea').count().catch(() => 0)) return true
    await page.mouse.click(400, 300).catch(() => {}) // skip the intro if it shows
    await sleep(500)
  }
  return false
}
let browser
// A window that never comes back must fail the check, not hang it.
const watchdog = setTimeout(() => {
  console.log('✗ the window did not come back within 150 s')
  app.kill('SIGTERM')
  spawn('pkill', ['-f', `remote-debugging-port=${port}`])
  process.exit(1)
}, 150_000)
try {
  for (let i = 0; i < 60 && !browser; i++) {
    await sleep(500)
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null)
  }
  if (!browser) throw new Error('could not connect to the app over CDP')
  let page = await mainPage(browser)
  check(page && (await chatBox(page)), 'the app starts and shows the chat box')
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Page.crash').catch(() => {}) // the renderer dies; the call itself never returns cleanly
  await sleep(1500)
  check(/renderer process gone/.test(log), 'the app noticed the renderer crash', log.slice(-400))
  // A crashed Page stays crashed in Playwright even after the target reloads: reconnect.
  await sleep(2000)
  await browser.close().catch(() => {})
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  page = await mainPage(browser)
  const back = page && (await chatBox(page, 80))
  check((log.match(/renderer loaded/g) || []).length >= 2, 'the page loaded a second time', log.slice(-300))
  check(back, 'the window reloads and the chat box is back', log.slice(-600))
  check(/reloading the window after a renderer crash/.test(log), 'the app says it reloaded the window')
} catch (e) {
  check(false, 'no unexpected error', `${e.message}\n${log.slice(-800)}`)
} finally {
  await browser?.close().catch(() => {})
  app.kill('SIGTERM')
  await sleep(800)
  spawn('pkill', ['-f', `remote-debugging-port=${port}`])
  rmSync(home, { recursive: true, force: true })
}
clearTimeout(watchdog)
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

// Re-shoot the app screenshots used by the slides and the poster, from the REAL renderer driven by
// the offline replay (scripted answers that mirror the real tools; see showcase/demo/DEMO.md Plan C).
// Every picture shows the showcase setup: AUTO mode (never FULL AUTO), the rehearsed hero demo, and
// presenter mode where the audience reads it. Captions on the slides/poster say "scripted sample".
//
//   npm run design                                  (in another terminal: the preview server)
//   node showcase/app-shots/capture.mjs             → showcase/app-shots/*.png
//
// The replay's "Offline replay" badge is hidden for these stills only; the slides caption them as
// scripted samples of the real interface instead.
import { chromium } from '../../node_modules/playwright/index.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const BASE = process.argv[2] || 'http://127.0.0.1:5199/'
const HERO = 'Go to the Wikipedia website, search for photosynthesis, and explain it to me in three simple sentences.'
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
let errors = 0

async function open({ presenter = true, width = 1600, height = 1000 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1.5 })
  const p = await ctx.newPage()
  p.on('pageerror', (e) => {
    errors++
    console.log('PAGEERROR:', e.message)
  })
  await p.goto(`${BASE}?skipIntro=1&replay=1&speak=0${presenter ? '&showcase=1' : ''}`)
  await p.waitForSelector('.chat-input textarea', { timeout: 20000 })
  await p.addStyleTag({ content: '.replay-badge,.brand-version{display:none!important}' })
  await p.waitForTimeout(900)
  return p
}
const settle = (p) =>
  p.evaluate(() =>
    Promise.race([
      Promise.all(document.getAnimations().filter((a) => Number.isFinite(a.effect?.getComputedTiming?.().endTime)).map((a) => a.finished.catch(() => {}))),
      new Promise((r) => setTimeout(r, 2500))
    ])
  )
async function shot(p, name) {
  await p.waitForTimeout(300)
  await settle(p)
  await p.screenshot({ path: join(here, `${name}.png`) })
  console.log('saved', name)
}
async function say(p, text) {
  await p.locator('.chat-input textarea').fill(text)
  await p.keyboard.press('Enter')
}
const idle = (p, ms = 40000) => p.waitForFunction(() => !document.querySelector('.status-busy') && !document.querySelector('.toolcard.running'), null, { timeout: ms })
const scrollEnd = (p) => p.evaluate(() => document.querySelector('.messages')?.scrollTo(0, 1e6))

try {
  // 1. The hero demo, mid-run: tool cards streaming in, Activity panel acting.
  let p = await open()
  await p.locator('[aria-label="Toggle activity panel"]').click()
  await say(p, HERO)
  await p.waitForFunction(() => document.querySelectorAll('.toolcard').length >= 3, null, { timeout: 30000 })
  await p.waitForTimeout(600)
  await shot(p, 'hero-working')
  // 2. …and its answer, read aloud in the app.
  await idle(p)
  await p.locator('[aria-label="Toggle activity panel"]').click()
  await p.waitForTimeout(400)
  await scrollEnd(p)
  await shot(p, 'hero-answer')
  await p.context().close()

  // 3. Demo 1: the terminal opens and types the command itself.
  p = await open()
  await say(p, 'How much free space is left on this Chromebook?')
  await idle(p)
  await scrollEnd(p)
  await shot(p, 'terminal')
  await p.context().close()

  // 4. Demo 7: PLAN mode refuses to change anything.
  p = await open()
  await say(p, 'Make me a three-day chemistry revision plan and save it in a new folder called Showcase, so I can undo it if I change my mind.')
  await idle(p)
  await say(p, '/mode plan')
  await say(p, 'Delete the Showcase folder.')
  await idle(p)
  await scrollEnd(p)
  await shot(p, 'plan-mode')
  await p.context().close()

  // 5. The whole app at normal size (history, chat, Activity), switched to AUTO with Shift+Tab.
  p = await open({ presenter: false, width: 1600, height: 1000 })
  await say(p, 'Remember that I like short, simple answers.')
  await idle(p)
  await say(p, HERO)
  await idle(p)
  await p.keyboard.press('Shift+Tab') // FULL AUTO → PLAN
  await p.keyboard.press('Shift+Tab') // PLAN → AUTO
  await scrollEnd(p)
  await shot(p, 'app-full')
  await p.context().close()
} finally {
  await browser.close()
}
console.log(errors ? `${errors} page error(s)` : 'no page errors')
process.exit(errors ? 1 : 0)

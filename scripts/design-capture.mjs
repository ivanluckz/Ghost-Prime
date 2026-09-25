// Screenshot every UI state of the design preview (`npm run design` must be running).
// Usage: node scripts/design-capture.mjs <outdir> [prefix] [baseUrl]
// States: empty, history, markdown, running, tools, tool-open, error, settings, settings-lower,
// terminal, compact, voice-listening, voice-failed, presenter, presenter-answer, narrow.
// Each run is a fresh page (fresh mock data). Prints PAGEERROR lines.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const [outdir = 'design-shots', prefix = 'ui', base = 'http://127.0.0.1:5199/?skipIntro=1'] = process.argv.slice(2)
mkdirSync(outdir, { recursive: true })
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
let errors = 0

async function page(width = 1280, height = 840, query = '') {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })
  const p = await ctx.newPage()
  p.on('pageerror', (e) => {
    errors++
    console.log('PAGEERROR:', e.message)
  })
  await p.goto(base + query)
  await p.waitForSelector('.chat-input textarea', { timeout: 60000 }) // the dev server is slow on a busy machine
  await p.waitForTimeout(900)
  return p
}
// Let entry animations (popover, terminal, cards) finish first: under swiftshader the first frames
// can take ~0.5s, and a shot taken mid-fade shows a half-transparent panel that isn't a real state.
const settle = (p) =>
  p.evaluate(() =>
    Promise.race([
      Promise.all(
        document
          .getAnimations()
          .filter((a) => Number.isFinite(a.effect?.getComputedTiming?.().endTime))
          .map((a) => a.finished.catch(() => {}))
      ),
      new Promise((r) => setTimeout(r, 2500))
    ])
  )
const shot = async (p, name) => {
  await p.waitForTimeout(350)
  await settle(p)
  await p.screenshot({ path: `${outdir}/${prefix}-${name}.png` })
  console.log('saved', name)
}
const send = async (p, text) => {
  await p.locator('.chat-input textarea').fill(text)
  await p.keyboard.press('Enter')
}

try {
  let p = await page()
  await shot(p, 'empty')
  await p.locator('.session-title').first().click()
  await p.waitForTimeout(600)
  await shot(p, 'history')
  await p.evaluate(() => {
    const m = document.querySelector('.messages')
    if (m) m.scrollTop = 0
  })
  await shot(p, 'markdown')
  await p.locator('button[aria-label="Settings"]').click()
  await shot(p, 'settings')
  await p.evaluate(() => {
    const s = document.querySelector('.settings-pop')
    if (s) s.scrollTop = s.scrollHeight
  })
  await shot(p, 'settings-lower')
  await p.locator('button[aria-label="Settings"]').click()
  await p.locator('[aria-label="Toggle terminal"]').click()
  await shot(p, 'terminal')
  await p.context().close()

  p = await page()
  await send(p, 'look up photosynthesis — slow please')
  await p.waitForTimeout(2600)
  await shot(p, 'running')
  await p.context().close()

  p = await page()
  await send(p, 'look up photosynthesis')
  await p.waitForTimeout(6500)
  await shot(p, 'tools')
  const cards = p.locator('.toolcard')
  if (await cards.count()) {
    await cards.nth(3).click().catch(() => {})
    await p.waitForTimeout(400)
    await cards.nth(3).scrollIntoViewIfNeeded().catch(() => {})
  }
  await shot(p, 'tool-open')
  await p.context().close()

  p = await page()
  await send(p, 'look up photosynthesis — error case')
  await p.waitForTimeout(5500)
  await shot(p, 'error')
  await p.context().close()

  p = await page()
  await p.locator('.session-title').first().click()
  await p.locator('[aria-label="Toggle activity panel"]').click()
  await p.locator('.sidebar-collapse').click()
  await shot(p, 'compact')
  await p.context().close()

  // Voice input: listening (red pill + composer edge) and a failed recording's note.
  p = await page()
  await p.locator('[aria-label="Voice input"]').click()
  await shot(p, 'voice-listening')
  await p.context().close()
  p = await page(1280, 840, '&voice=fail')
  await p.locator('[aria-label="Voice input"]').click()
  await p.waitForTimeout(300)
  await p.locator('[aria-label="Voice input"]').click()
  await p.waitForTimeout(1700)
  await shot(p, 'voice-failed')
  await p.context().close()

  // Presenter mode as bin/ghost-showcase launches it (GHOST_SHOWCASE=1), on a 1366x768 projector.
  p = await page(1366, 768, '&showcase=1')
  await shot(p, 'presenter')
  await send(p, 'look up photosynthesis')
  await p.waitForTimeout(6500)
  await shot(p, 'presenter-answer')
  await p.context().close()

  p = await page(900, 700)
  await p.locator('.session-title').first().click()
  await shot(p, 'narrow')
  await p.context().close()
} finally {
  await browser.close()
}
console.log(errors ? `${errors} page error(s)` : 'no page errors')

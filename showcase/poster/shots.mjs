// Shoot the poster's two app screens from the REAL renderer playing the offline replay of the hero demo
// (scripted answers that mirror the real tools; see showcase/demo/DEMO.md Plan C). Same setup as
// showcase/app-shots/capture.mjs: presenter mode, AUTO, never FULL AUTO.
//
// Why the poster has its own shots: the slides' shots are 1600 px wide, so on paper their text came out
// about 10 px tall (2.7 mm on A2), too small to read at a booth. These are shot in a 1040 px window and
// cut to the chat column, which prints the app's text about 40 % larger.
//
//   npm run design                          (in another terminal: the preview server)
//   node showcase/poster/shots.mjs          → showcase/poster/img/app-steps.png, app-answer.png
//
// It prints the numbers poster.html needs (each picture's size, and where the mic button is). If they
// change, update the `.frame` rules in poster.html.
import { chromium } from '../../node_modules/playwright/index.mjs'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, 'img')
mkdirSync(out, { recursive: true })
const BASE = process.argv[2] || 'http://127.0.0.1:5199/'
const HERO = 'Go to the Wikipedia website, search for photosynthesis, and explain it to me in three simple sentences.'
const W = 1040
const SCALE = 2.25 // 656 px on the poster is 174 mm on A2: about 300 dpi
const PAD = 8

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
let errors = 0
const settle = (p) =>
  p.evaluate(() =>
    Promise.race([
      Promise.all(document.getAnimations().filter((a) => Number.isFinite(a.effect?.getComputedTiming?.().endTime)).map((a) => a.finished.catch(() => {}))),
      new Promise((r) => setTimeout(r, 2500))
    ])
  )
const box = (p, sel, which = 'first') =>
  p.evaluate(([s, w]) => {
    const all = [...document.querySelectorAll(s)]
    const el = w === 'last' ? all.at(-1) : all[0]
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left, y: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom }
  }, [sel, which])

try {
  const ctx = await browser.newContext({ viewport: { width: W, height: 1100 }, deviceScaleFactor: SCALE })
  const p = await ctx.newPage()
  p.on('pageerror', (e) => {
    errors++
    console.log('PAGEERROR:', e.message)
  })
  await p.goto(`${BASE}?skipIntro=1&replay=1&speak=0&showcase=1`)
  await p.waitForSelector('.chat-input textarea', { timeout: 30000 })
  // As in app-shots: the replay badge is hidden for stills; the poster captions them instead.
  await p.addStyleTag({ content: '.replay-badge,.brand-version{display:none!important}' })
  await p.waitForTimeout(900)

  // 1. Mid-run: the request and the first tool cards, the third still running.
  await p.locator('.chat-input textarea').fill(HERO)
  await p.keyboard.press('Enter')
  await p.waitForFunction(() => document.querySelectorAll('.toolcard').length >= 3, null, { timeout: 30000 })
  // Fold the finished cards to one line each, so the three steps read as a list.
  await p.evaluate(() => document.querySelectorAll('.toolcard.is-open .toolcard-head').forEach((h) => h.click()))
  await p.waitForTimeout(350)
  const bar = await box(p, '.topbar')
  const lastCard = await box(p, '.toolcard', 'last')
  const cards = await p.evaluate(() => [...document.querySelectorAll('.toolcard')].map((c) => `${c.querySelector('.tool-name')?.textContent} (${c.classList.contains('running') ? 'running' : 'done'})`))
  const steps = { x: bar.x - PAD, y: bar.y - PAD - 2, width: bar.w + 2 * PAD, height: lastCard.b + 14 - (bar.y - PAD - 2) }
  await p.screenshot({ path: join(out, 'app-steps.png'), clip: steps })
  console.log('saved app-steps.png', `${Math.round(steps.width)} x ${Math.round(steps.height)} css px`, '| cards:', cards.join(', '))

  // 2. The answer, with the message box and its mic button. The window is made just tall enough for
  //    the answer, so it sits right above the message box.
  await p.waitForFunction(() => !document.querySelector('.status-busy') && !document.querySelector('.toolcard.running'), null, { timeout: 60000 })
  await p.waitForTimeout(600)
  const measure = () => p.evaluate(() => {
    const ans = [...document.querySelectorAll('.msg')].filter((m) => !m.classList.contains('msg-user')).at(-1)
    const r = ans.getBoundingClientRect()
    return { cls: ans.className, h: r.height, role: ans.querySelector('.msg-role')?.textContent?.trim() || '' }
  })
  const ans = await measure()
  const input = await box(p, '.chat-input')
  const inputH = input.h + (1100 - input.b)
  // 64: room for the GHOST / CLAUDE tag above the answer. TIGHT: the chat leaves about 58 px of empty
  // space under the last message; stopping the scroll 34 px short of the end closes most of it.
  const TIGHT = 34
  const winH = Math.ceil(bar.b + 64 + ans.h + 26 + inputH) - TIGHT
  await p.setViewportSize({ width: W, height: winH })
  await p.waitForTimeout(400)
  await p.evaluate((t) => {
    const m = document.querySelector('.messages')
    m.scrollTo(0, m.scrollHeight - m.clientHeight - t)
  }, TIGHT)
  await p.waitForTimeout(500)
  await settle(p)
  const ansBox = await p.evaluate(() => {
    const msg = [...document.querySelectorAll('.msg')].filter((m) => !m.classList.contains('msg-user')).at(-1)
    const a = msg.getBoundingClientRect()
    const tag = msg.querySelector('.msg-role')?.getBoundingClientRect()
    return { y: Math.min(a.top, tag ? tag.top : a.top), b: a.bottom }
  })
  const mic = await box(p, '.chat-input button')
  const answer = { x: bar.x - PAD, y: Math.max(bar.b + 4, ansBox.y - 14), width: bar.w + 2 * PAD, height: 0 }
  answer.height = winH - 4 - answer.y
  await p.screenshot({ path: join(out, 'app-answer.png'), clip: answer })
  console.log('saved app-answer.png', `${Math.round(answer.width)} x ${Math.round(answer.height)} css px`, '| answer tag:', JSON.stringify(ans.role))

  const pct = (v) => `${(v * 100).toFixed(2)}%`
  console.log('\nFor poster.html:')
  console.log(`  .frame.steps  { aspect-ratio: ${Math.round(steps.width)} / ${Math.round(steps.height)}; }`)
  console.log(`  .frame.answer { aspect-ratio: ${Math.round(answer.width)} / ${Math.round(answer.height)}; }`)
  console.log(`  mic centre: left ${pct((mic.x + mic.w / 2 - answer.x) / answer.width)}, top ${pct((mic.y + mic.h / 2 - answer.y) / answer.height)}; diameter ${pct(mic.w / answer.width)} of the frame width`)
  const send = await box(p, '.chat-input button', 'last')
  console.log(`  Send button starts at ${pct((send.x - answer.x) / answer.width)} of the frame width`)
  // The Linux user name must not be in a picture that gets printed.
  const leaks = await p.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => !e.children.length && /\/home\/|\blol\b/.test(e.textContent || '')).map((e) => e.textContent.trim().slice(0, 80)))
  if (leaks.length) {
    errors++
    console.log('USER NAME VISIBLE:', leaks)
  }
  await ctx.close()
} finally {
  await browser.close()
}
console.log(errors ? `${errors} problem(s)` : 'no page errors')
process.exit(errors ? 1 : 0)

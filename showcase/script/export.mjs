// Export the presenter pitch card: pitch-card.pdf (2 A4 pages) plus PNG previews.
// Run from the repo root, ALWAYS through the shared memory lock:
//   flock /tmp/claude-1000/design-capture.lock node showcase/script/export.mjs
// Output (next to pitch-card.html):
//   pitch-card.pdf
//   preview/pitch-card-p1.png  preview/pitch-card-p2.png   (each A4 sheet at 110 dpi, print styles)
//   preview/pitch-card-phone.png                          (the page on a 390 px wide phone screen)
// It also checks the layout: nothing may spill past a sheet's bottom margin, and the stacked blocks
// on a sheet must not overlap. Any problem is printed and the exit code is 1.
import { chromium } from '../../node_modules/playwright/index.mjs'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const url = pathToFileURL(join(here, 'pitch-card.html')).href
const MM = 96 / 25.4 // CSS px per mm
mkdirSync(join(here, 'preview'), { recursive: true })

async function ready(page) {
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r }))))
  })
}

let failures = 0
const browser = await chromium.launch({ args: ['--disable-gpu', '--disable-dev-shm-usage'] })
try {
  // 1. Print layout: PDF + one PNG per sheet.
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 1400 }, deviceScaleFactor: 110 / 96 })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => { failures++; console.log('PAGEERROR:', e.message) })
  page.on('requestfailed', (r) => { failures++; console.log('REQUESTFAILED:', r.url()) })
  await page.goto(url)
  await page.emulateMedia({ media: 'print' })
  await ready(page)

  const report = await page.evaluate((mm) => {
    const out = []
    const fonts = [...document.fonts].map((f) => `${f.family}:${f.status}`)
    document.querySelectorAll('.sheet').forEach((sheet, i) => {
      const sr = sheet.getBoundingClientRect()
      const limit = sr.bottom - 6 * mm // footer text must stay at least 6 mm above the paper edge
      let lowest = 0
      for (const el of sheet.querySelectorAll('*')) {
        const r = el.getBoundingClientRect()
        if (!r.width || !r.height) continue
        lowest = Math.max(lowest, r.bottom)
        if (r.bottom > limit + 0.5) out.push(`sheet ${i + 1}: <${el.tagName.toLowerCase()} class="${el.className}"> ends ${Math.round(r.bottom - limit)}px past the bottom margin`)
        if (r.right > sr.right - 10 * mm + 0.5) out.push(`sheet ${i + 1}: <${el.tagName.toLowerCase()} class="${el.className}"> runs into the right margin`)
      }
      const kids = [...sheet.children].filter((k) => k.getBoundingClientRect().height > 0)
      for (let k = 1; k < kids.length; k++) {
        const prev = kids[k - 1].getBoundingClientRect().bottom
        const top = kids[k].getBoundingClientRect().top
        if (prev > top + 0.5) out.push(`sheet ${i + 1}: OVERLAP .${kids[k - 1].className} over .${kids[k].className} by ${Math.round(prev - top)}px`)
      }
      out.push(`(info) sheet ${i + 1}: ${Math.round((limit - lowest) / mm)} mm spare above the bottom margin`)
    })
    return { out, fonts }
  }, MM)
  console.log('fonts:', report.fonts.join(' '))
  for (const line of report.out) {
    console.log(line)
    if (!line.startsWith('(info)')) failures++
  }

  const sheets = await page.locator('.sheet').all()
  for (let i = 0; i < sheets.length; i++) {
    const file = join(here, 'preview', `pitch-card-p${i + 1}.png`)
    await sheets[i].screenshot({ path: file })
    console.log('saved', file)
  }
  await page.pdf({ path: join(here, 'pitch-card.pdf'), preferCSSPageSize: true, printBackground: true })
  console.log('saved', join(here, 'pitch-card.pdf'), `(${sheets.length} sheets)`)
  await ctx.close()

  // 2. Phone screen preview (the card is also readable on a phone at the booth).
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 })
  const pp = await phone.newPage()
  await pp.goto(url)
  await ready(pp)
  const wide = await pp.evaluate(() => document.documentElement.scrollWidth)
  if (wide > 390) { failures++; console.log(`phone: page is ${wide}px wide (horizontal scroll)`) }
  await pp.screenshot({ path: join(here, 'preview', 'pitch-card-phone.png') })
  console.log('saved', join(here, 'preview', 'pitch-card-phone.png'))
  await phone.close()
} finally {
  await browser.close()
}
if (failures) { console.log(`FAILURES: ${failures}`); process.exitCode = 1 } else console.log('layout: clean')

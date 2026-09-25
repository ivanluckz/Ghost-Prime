// Export the booth poster: A2 + A3 PDFs and PNG previews, for the light and dark themes.
// Run from the repo root, ALWAYS through the shared memory lock:
//   flock /tmp/claude-1000/design-capture.lock node showcase/poster/export.mjs [light|dark|all] [--png-only] [--detail]
// Output (next to poster.html):
//   poster-light.pdf  poster-light-a3.pdf  poster-dark.pdf  poster-dark-a3.pdf
//   preview/poster-light.png  preview/poster-dark.png   (+ preview/*-detail-*.png with --detail)
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const which = args.find((a) => !a.startsWith('--')) || 'all'
const pngOnly = args.includes('--png-only')
const detail = args.includes('--detail')
const themes = which === 'all' ? ['light', 'dark'] : [which]
const MM = 96 / 25.4 // CSS px per mm
const W = Math.ceil(420 * MM)
const H = Math.ceil(594 * MM)
mkdirSync(join(here, 'preview'), { recursive: true })

const browser = await chromium.launch({ args: ['--disable-gpu', '--disable-dev-shm-usage'] })
let failures = 0
try {
  for (const theme of themes) {
    const url = pathToFileURL(join(here, 'poster.html')).href + `?theme=${theme}&export=1`
    const scale = detail ? 1 : 0.6
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: scale })
    const page = await ctx.newPage()
    page.on('pageerror', (e) => { failures++; console.log('PAGEERROR:', e.message) })
    page.on('requestfailed', (r) => { failures++; console.log('REQUESTFAILED:', r.url()) })
    await page.goto(url)
    await page.evaluate(async () => {
      await document.fonts.ready
      await Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r }))))
    })
    await page.emulateMedia({ media: 'print' })
    // Layout sanity: nothing may spill outside the sheet (the poster clips overflow, so check children).
    const overflow = await page.evaluate(() => {
      const sheet = document.querySelector('.poster').getBoundingClientRect()
      const bad = []
      for (const el of document.querySelectorAll('.poster *')) {
        const r = el.getBoundingClientRect()
        if (!r.width || !r.height) continue
        if (el.closest('svg') && el.tagName !== 'svg') continue
        if (r.bottom > sheet.bottom - 10 || r.right > sheet.right - 10 || r.left < sheet.left + 10) {
          bad.push(`${el.tagName.toLowerCase()}.${el.className?.baseVal ?? el.className} b=${Math.round(r.bottom)} r=${Math.round(r.right)}`)
        }
      }
      // Stacked blocks must not overlap: each direct child of the sheet, and each column's content.
      const kids = [...document.querySelector('.poster').children]
      for (let i = 1; i < kids.length; i++) {
        const prev = kids[i - 1].getBoundingClientRect().bottom, top = kids[i].getBoundingClientRect().top
        if (prev > top + 0.5) bad.push(`OVERLAP ${kids[i - 1].className} over ${kids[i].className} by ${Math.round(prev - top)}px`)
      }
      for (const col of document.querySelectorAll('.col')) {
        const last = col.lastElementChild.getBoundingClientRect().bottom, end = col.getBoundingClientRect().bottom
        if (last > end + 0.5) bad.push(`COLUMN overflows by ${Math.round(last - end)}px`)
        else bad.push(`(ok) column spare ${Math.round(end - last)}px`)
      }
      const fonts = [...document.fonts].map((f) => `${f.family}:${f.status}`)
      return { bad: bad.slice(0, 12), sheetH: sheet.height, fonts }
    })
    console.log(theme, 'fonts', overflow.fonts.join(' '))
    const real = overflow.bad.filter((x) => !x.startsWith('(ok)'))
    console.log(theme, 'layout:', overflow.bad.join(' | ') || 'clean')
    if (real.length) failures++

    const png = join(here, 'preview', detail ? `poster-${theme}-detail.png` : `poster-${theme}.png`)
    // Screenshots occasionally fail under memory pressure ("Unable to capture screenshot"): retry.
    for (let attempt = 1; ; attempt++) {
      try { await page.screenshot({ path: png, clip: { x: 0, y: 0, width: 420 * MM, height: 594 * MM } }); break }
      catch (e) { if (attempt >= 3) throw e; console.log('screenshot retry', attempt, e.message.split('\n')[0]); await page.waitForTimeout(1500) }
    }
    console.log('saved', png)

    if (!pngOnly) {
      await page.pdf({ path: join(here, `poster-${theme}.pdf`), preferCSSPageSize: true, printBackground: true })
      console.log('saved', `poster-${theme}.pdf (A2)`)
      // A3 = the same design shrunk by 297/420. Zoom the sheet and switch the CSS page size
      // (Chromium's own pdf `scale` stacks with its shrink-to-fit and gives a half-size poster).
      await page.addStyleTag({ content: '@page { size: 297mm 420mm; margin: 0; } .poster { zoom: 0.7071429; }' })
      await page.pdf({ path: join(here, `poster-${theme}-a3.pdf`), preferCSSPageSize: true, printBackground: true })
      console.log('saved', `poster-${theme}-a3.pdf (A3)`)
    }
    await ctx.close()
  }
} finally {
  await browser.close()
}
if (failures) { console.log(`FAILURES: ${failures}`); process.exitCode = 1 }

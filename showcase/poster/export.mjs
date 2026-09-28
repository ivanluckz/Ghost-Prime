// Export the booth poster: A2 + A3 PDFs and PNG previews, for the light and dark themes.
// Run from the repo root:
//   node showcase/poster/export.mjs [light|dark|all] [--png-only] [--detail] [--print-png] [--out=DIR]
// Output (next to poster.html):
//   poster-light.pdf  poster-light-a3.pdf  poster-dark.pdf  poster-dark-a3.pdf
//   preview/poster-light.png  preview/poster-dark.png   (the whole sheet at 0.6x)
// --detail     1:1 crops for checking small text: preview/poster-{theme}-detail-{part}.png, one per
//              band (top, hero, shot, try, how, works, who, foot). Implies --png-only, so a detail
//              pass never rewrites the print PDFs.
// --print-png  A2 at 300 dpi (4961 x 7016 px): print/poster-{theme}-a2-300dpi.png. A fallback for a
//              print shop whose preflight rejects the PDF: Chromium embeds the variable fonts as Type 3
//              fonts, which some shops flag. Big files: hand them over, don't commit them.
// --out=DIR    write the PNGs from --detail / --print-png to DIR instead (relative to the current folder).
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const which = args.find((a) => !a.startsWith('--')) || 'all'
const detail = args.includes('--detail')
const printPng = args.includes('--print-png')
const pngOnly = args.includes('--png-only') || detail || printPng
const outArg = args.find((a) => a.startsWith('--out='))
const themes = which === 'all' ? ['light', 'dark'] : [which]
const MM = 96 / 25.4 // CSS px per mm
const W = Math.ceil(420 * MM)
const H = Math.ceil(594 * MM)
const previewDir = join(here, 'preview')
const detailDir = outArg ? resolve(outArg.slice(6)) : previewDir
const printDir = outArg ? resolve(outArg.slice(6)) : join(here, 'print')
mkdirSync(previewDir, { recursive: true })
if (detail) mkdirSync(detailDir, { recursive: true })
if (printPng) mkdirSync(printDir, { recursive: true })

// Screenshots occasionally fail under memory pressure ("Unable to capture screenshot"): retry.
async function shoot(page, opts) {
  for (let attempt = 1; ; attempt++) {
    try { await page.screenshot(opts); return }
    catch (e) { if (attempt >= 3) throw e; console.log('screenshot retry', attempt, e.message.split('\n')[0]); await page.waitForTimeout(1500) }
  }
}

// GHOST_CHROMIUM=/path/to/chrome uses that browser (e.g. /opt/pw-browsers/chromium when Playwright can't download its own).
const browser = await chromium.launch({ executablePath: process.env.GHOST_CHROMIUM || undefined, args: ['--disable-gpu', '--disable-dev-shm-usage'] })
let failures = 0
try {
  for (const theme of themes) {
    const url = pathToFileURL(join(here, 'poster.html')).href + `?theme=${theme}&export=1`
    const scale = printPng ? 300 / 96 : detail ? 1 : 0.6
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
        if (el.closest('.frame') && el.tagName === 'IMG') continue // the screenshot is cropped by its frame on purpose
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
      // The band gaps: justify-content spreads the spare height between the five bands.
      const gaps = kids.slice(1).map((k, i) => Math.round(k.getBoundingClientRect().top - kids[i].getBoundingClientRect().bottom))
      bad.push(`(ok) band gaps ${gaps.join('/')}px`)
      const fonts = [...document.fonts].map((f) => `${f.family}:${f.status}`)
      return { bad: bad.slice(0, 14), sheetH: sheet.height, fonts }
    })
    console.log(theme, 'fonts', overflow.fonts.join(' '))
    const real = overflow.bad.filter((x) => !x.startsWith('(ok)'))
    console.log(theme, 'layout:', overflow.bad.join(' | ') || 'clean')
    if (real.length) failures++

    if (printPng) {
      const png = join(printDir, `poster-${theme}-a2-300dpi.png`)
      await shoot(page, { path: png, clip: { x: 0, y: 0, width: 420 * MM, height: 594 * MM } })
      console.log('saved', png)
    } else if (detail) {
      const parts = { top: '.top', hero: '.hero', shot: '.shot', try: '.try', how: '.how', works: '.works', who: '.who', foot: '.foot' }
      for (const [name, sel] of Object.entries(parts)) {
        const box = await page.locator(sel).first().boundingBox()
        if (!box) { failures++; console.log('DETAIL: no element for', sel); continue }
        const pad = 16
        const clip = { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + 2 * pad, height: box.height + 2 * pad }
        const png = join(detailDir, `poster-${theme}-detail-${name}.png`)
        await shoot(page, { path: png, clip })
        console.log('saved', png)
      }
    } else {
      const png = join(previewDir, `poster-${theme}.png`)
      await shoot(page, { path: png, clip: { x: 0, y: 0, width: 420 * MM, height: 594 * MM } })
      console.log('saved', png)
    }

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

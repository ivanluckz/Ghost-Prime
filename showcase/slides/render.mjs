// Render the pitch deck: one PNG per slide (preview/slide-NN.png) and slides.pdf (1920x1080 pages).
// Also prints layout warnings: text that overflows its box or the slide, and text smaller than 22px.
//
// Memory is tight on the Chromebook, so always run it through the shared lock:
//   flock /tmp/claude-1000/design-capture.lock node showcase/slides/render.mjs [--png] [--pdf]
// With no flag it does both.
import { chromium } from '../../node_modules/playwright/index.mjs'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const doPng = args.length === 0 || args.includes('--png')
const doPdf = args.length === 0 || args.includes('--pdf')
const only = args.find((a) => /^\d+$/.test(a)) // optional: render a single slide number

const browser = await chromium.launch({ args: ['--disable-gpu', '--disable-dev-shm-usage'] })
try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
  page.on('requestfailed', (r) => console.log('REQUESTFAILED:', r.url()))
  await page.goto(pathToFileURL(join(here, 'slides.html')).href)
  await page.emulateMedia({ media: 'print' })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(300)

  const fonts = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family))
  console.log('fonts loaded:', [...new Set(fonts)].join(', ') || 'NONE')

  // Swap gradient words to SVG text (what the browser does on print), so PNGs match the PDF.
  const swapped = await page.evaluate(() => window.__gradToSvg())
  console.log('gradient words drawn as SVG:', swapped)

  // Layout checks
  const warnings = await page.evaluate(() => {
    const out = []
    document.querySelectorAll('.slide').forEach((slide, i) => {
      const sr = slide.getBoundingClientRect()
      const hasFooter = !!slide.querySelector('.footer')
      slide.querySelectorAll('*').forEach((el) => {
        if (el.closest('svg') && el.tagName !== 'svg') return
        if (el.closest('.footer') || el.closest('.credits') || el.classList.contains('wrap')) return
        const r = el.getBoundingClientRect()
        // Content must end >= 20px above the footer line (footer text starts ~1012px down)
        if (hasFooter && r.bottom - sr.top > 990 && r.width > 0)
          out.push(`slide ${i + 1}: <${el.tagName.toLowerCase()} class="${el.className.baseVal ?? el.className}"> runs into the footer (bottom ${Math.round(r.bottom - sr.top)}px)`)
        if (r.width === 0 || r.height === 0) return
        const cs = getComputedStyle(el)
        const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
        if (r.right > sr.right - 40 || r.bottom > sr.bottom - 30 || r.left < sr.left + 40)
          out.push(`slide ${i + 1}: <${el.tagName.toLowerCase()} class="${el.className.baseVal ?? el.className}"> outside safe area (${Math.round(r.left - sr.left)},${Math.round(r.top - sr.top)} ${Math.round(r.width)}x${Math.round(r.height)})`)
        if (hasText && el.scrollWidth > el.clientWidth + 2 && cs.overflow !== 'visible')
          out.push(`slide ${i + 1}: text clipped in <${el.tagName.toLowerCase()}>`)
        if (hasText && parseFloat(cs.fontSize) < 22)
          out.push(`slide ${i + 1}: small text ${cs.fontSize} in <${el.tagName.toLowerCase()}>: ${el.textContent.trim().slice(0, 40)}`)
      })
      // SVG text: measure against the slide at its rendered size
      slide.querySelectorAll('svg text').forEach((t) => {
        const r = t.getBoundingClientRect()
        if (r.right > sr.right - 40 || r.bottom > sr.bottom - 30) out.push(`slide ${i + 1}: svg text outside safe area: ${t.textContent}`)
        const px = r.height
        if (px < 26) out.push(`slide ${i + 1}: svg text renders ~${px.toFixed(0)}px tall: ${t.textContent}`)
      })
    })
    return out
  })
  console.log(warnings.length ? warnings.join('\n') : 'layout: no warnings')

  if (doPng) {
    mkdirSync(join(here, 'preview'), { recursive: true })
    const slides = await page.locator('.slide').all()
    for (let i = 0; i < slides.length; i++) {
      if (only && Number(only) !== i + 1) continue
      const file = join(here, 'preview', `slide-${String(i + 1).padStart(2, '0')}.png`)
      await slides[i].screenshot({ path: file })
      console.log('saved', file)
    }
  }
  if (doPdf) {
    const file = join(here, 'slides.pdf')
    await page.pdf({ path: file, width: '1920px', height: '1080px', printBackground: true, preferCSSPageSize: true })
    console.log('saved', file)
  }
} finally {
  await browser.close()
}

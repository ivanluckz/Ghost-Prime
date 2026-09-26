// Render the pitch deck: one PNG per slide (preview/slide-NN.png) and slides.pdf (1920x1080 pages).
// Also prints layout warnings: text that overflows its box or the slide, text smaller than 24px
// (DESIGN.md: nothing on a slide below 24px), and Inter body text smaller than 30px (HTML and SVG
// alike; mono labels and captions may be 24px). It also prints each slide's on-slide word count as
// information (DESIGN.md: about 30 words; screenshots and the footer are not counted).
//
// Run it from the repo folder:
//   node showcase/slides/render.mjs [--png] [--pdf] [N]
// With no flag it does both. N renders only slide N's PNG.
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

  // The PNGs are taken in print media, so they match the PDF. (The wordmark is outlined SVG, so
  // there is no live gradient text to swap before printing.)
  const liveGrad = await page.evaluate(() =>
    [...document.querySelectorAll('.slide *')].filter((el) => /text/.test(getComputedStyle(el).backgroundClip)).length)
  if (liveGrad) console.log(`WARNING: ${liveGrad} element(s) use background-clip:text, which prints badly`)

  // Layout checks
  const warnings = await page.evaluate(() => {
    const out = []
    document.querySelectorAll('.slide').forEach((slide, i) => {
      const sr = slide.getBoundingClientRect()
      const hasFooter = !!slide.querySelector('.footer')
      slide.querySelectorAll('*').forEach((el) => {
        if (el.closest('svg') && el.tagName !== 'svg') return
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
        // Text floor applies everywhere, footer and credits included
        if (hasText && r.width > 0 && parseFloat(cs.fontSize) < 24)
          out.push(`slide ${i + 1}: small text ${cs.fontSize} in <${el.tagName.toLowerCase()}>: ${el.textContent.trim().slice(0, 40)}`)
        else if (hasText && r.width > 0 && /Inter Kit/.test(cs.fontFamily.split(',')[0]) && parseFloat(cs.fontSize) < 30)
          out.push(`slide ${i + 1}: body text ${cs.fontSize} (< 30px) in <${el.tagName.toLowerCase()}>: ${el.textContent.trim().slice(0, 40)}`)
        if (el.closest('.footer')) return
        if (el.tagName === 'IMG' && el.closest('.shot')) return // a crop: the frame clips it on purpose
        // Content must end above the footer (footer text starts ~995px down)
        if (hasFooter && r.bottom - sr.top > 975 && r.width > 0)
          out.push(`slide ${i + 1}: <${el.tagName.toLowerCase()} class="${el.className.baseVal ?? el.className}"> runs into the footer (bottom ${Math.round(r.bottom - sr.top)}px)`)
        if (r.width === 0 || r.height === 0) return
        if (r.right > sr.right - 40 || r.bottom > sr.bottom - 30 || r.left < sr.left + 40)
          out.push(`slide ${i + 1}: <${el.tagName.toLowerCase()} class="${el.className.baseVal ?? el.className}"> outside safe area (${Math.round(r.left - sr.left)},${Math.round(r.top - sr.top)} ${Math.round(r.width)}x${Math.round(r.height)})`)
        if (hasText && el.scrollWidth > el.clientWidth + 2 && cs.overflow !== 'visible')
          out.push(`slide ${i + 1}: text clipped in <${el.tagName.toLowerCase()}>`)
      })
      // SVG text: measure against the slide at its rendered size
      slide.querySelectorAll('svg text').forEach((t) => {
        const r = t.getBoundingClientRect()
        if (r.right > sr.right - 40 || r.bottom > sr.bottom - 30) out.push(`slide ${i + 1}: svg text outside safe area: ${t.textContent}`)
        const tcs = getComputedStyle(t)
        const px = parseFloat(tcs.fontSize) * (r.height / (t.getBBox().height || r.height))
        if (px < 23.5) out.push(`slide ${i + 1}: svg text renders ~${px.toFixed(0)}px: ${t.textContent}`)
        else if (/Inter Kit/.test(tcs.fontFamily.split(',')[0]) && px < 29.5)
          out.push(`slide ${i + 1}: svg body text renders ~${px.toFixed(0)}px (< 30px): ${t.textContent}`)
      })
    })
    return out
  })
  console.log(warnings.length ? warnings.join('\n') : 'layout: no warnings')

  // Word budget (information only): visible words per slide, without the footer and screenshots
  const words = await page.evaluate(() =>
    [...document.querySelectorAll('.slide')].map((slide) => {
      const clone = slide.cloneNode(true)
      clone.querySelectorAll('.footer, img, svg:not(.diagram), title').forEach((n) => n.remove())
      return (clone.textContent.match(/[A-Za-z0-9][^\s·→]*/g) || []).length
    })
  )
  console.log('on-slide words (DESIGN.md: about 30; info only):', words.map((n, i) => `${i + 1}:${n}`).join('  '))

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

// Screenshot the running app's UI states over CDP — the way to verify a renderer change with your
// own eyes (and to catch renderer crashes: a blank frame or a PAGEERROR line means React unmounted).
//
//   1. start the app with a debugging port (Discord/proactive off so nothing external fires):
//      DISCORD_BOT_TOKEN= GHOST_PROACTIVE=0 GHOST_CANVA=0 GHOST_AUTO_SUMMARIZE=0 GHOST_SINGLE_INSTANCE=0 \
//        ELECTRON_OZONE_PLATFORM_HINT=x11 npx electron . --remote-debugging-port=9333
//   2. node scripts/ui-capture.mjs <outdir> [prefix]
//
// Captures: main (empty state), terminal dock, grown composer, settings, activity-hidden. It never
// sends a message (no brain calls) and never deletes anything.
import { chromium } from 'playwright'
const [outdir = '.', prefix = 'ui'] = process.argv.slice(2)
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
const page = browser.contexts()[0].pages().find((p) => /renderer\/index\.html|localhost/.test(p.url()))
if (!page) throw new Error('renderer page not found — is the app running with --remote-debugging-port=9333?')
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
const shot = async (n) => { await page.waitForTimeout(450); await page.screenshot({ path: `${outdir}/${prefix}-${n}.png` }); console.log('saved', n) }
await page.waitForTimeout(1500)
const toggle = (label) => page.locator(`[aria-label="${label}"]`).click()
if (await page.locator('.settings-pop').count()) await toggle('Settings')
if (!(await page.locator('.activity').count())) await toggle('Toggle activity panel')
await page.locator('.btn-new').click()
await shot('main')
await toggle('Toggle terminal'); await shot('terminal'); await toggle('Toggle terminal')
await page.locator('textarea').fill('line one\nline two\nline three'); await shot('composer-grown'); await page.locator('textarea').fill('')
await toggle('Settings'); await shot('settings'); await toggle('Settings')
await toggle('Toggle activity panel'); await shot('wide'); await toggle('Toggle activity panel')
await browser.close()

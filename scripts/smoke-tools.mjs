// Headless verification of the Phase 2 tools: terminal (child_process) + browser (Playwright).
// Run: node scripts/smoke-tools.mjs
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

function run(cmd) {
  return new Promise((resolve) => {
    const c = spawn('bash', ['-lc', cmd])
    let out = ''
    c.stdout.on('data', (d) => (out += d))
    c.on('close', (code) => resolve({ code, out: out.trim() }))
  })
}

let ok = true

// 1. Terminal
const t = await run('echo ghost && uname -s')
console.log(`terminal: code=${t.code} out=${JSON.stringify(t.out)}`)
if (t.code !== 0 || !t.out.includes('ghost')) ok = false

// 2. Browser
try {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  })
  const page = await browser.newPage()
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 30000 })
  const title = await page.title()
  const shot = await page.screenshot({ type: 'png' })
  console.log(`browser: title=${JSON.stringify(title)} screenshot=${shot.length} bytes`)
  if (!/example/i.test(title) || shot.length < 1000) ok = false
  await browser.close()
} catch (e) {
  console.error('browser FAILED:', e?.message || e)
  ok = false
}

console.log(ok ? '--- ALL TOOLS OK' : '--- SOME TOOLS FAILED')
process.exit(ok ? 0 : 1)

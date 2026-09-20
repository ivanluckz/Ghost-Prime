// Prove the Gemini brain can SEE browser screenshots: the OpenAI-compatible endpoint only takes
// text in tool messages, so provider.js hands screenshots back as a user turn. This drives the same
// shape against a local page whose content exists ONLY as pixels (a canvas) — if Gemini reads the
// word, the image made it through. Also checks the tool specs are accepted (browser_click_at etc.).
// Run: GHOST_BROWSER_HEADLESS=1 GHOST_BROWSER_CHANNEL= GHOST_BROWSER_PROFILE=/tmp/ghost-pw GHOST_BROWSER_BACKEND=playwright \
//      node --import ./scripts/lib/register-electron-stub.mjs scripts/smoke-gemini-browser-vision.mjs
import 'dotenv/config'
import OpenAI from 'openai'
import { toolSpecs, executeTool } from '../src/main/tools/index.js'
import * as browser from '../src/main/tools/browser.js'

const apiKey = process.env.GEMINI_API_KEY
if (!apiKey) {
  console.error('FAIL: GEMINI_API_KEY not set in .env')
  process.exit(1)
}
const client = new OpenAI({ baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', apiKey })
const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash'

const SECRET = 'PELICAN'
const PAGE =
  'data:text/html,' +
  encodeURIComponent(
    `<!doctype html><title>Canvas</title><body style="margin:0;background:#fff"><canvas id="c" width="600" height="200"></canvas>
     <script>const x=document.getElementById('c').getContext('2d');x.fillStyle='#000';x.font='bold 64px sans-serif';x.fillText('${SECRET}',40,120)</script></body>`
  )

const messages = [
  { role: 'system', content: 'You are Ghost-Prime. The browser is already open. Use tools; never guess.' },
  {
    role: 'user',
    content: 'Take a browser_screenshot of the current page and tell me the single word drawn on it, in capitals. The word is only visible as pixels (a canvas), so you must look at the screenshot — browser_get_text will not show it.'
  }
]

let sawImageTurn = false
let answer = ''
try {
  await browser.browserNavigate({ url: PAGE })
  for (let turn = 0; turn < 6; turn++) {
    const res = await client.chat.completions.create({ model, messages, tools: toolSpecs, tool_choice: 'auto' })
    const msg = res.choices[0].message
    if (msg.content) answer += msg.content
    if (!msg.tool_calls?.length) break
    messages.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls })
    const images = []
    for (const call of msg.tool_calls) {
      const args = JSON.parse(call.function.arguments || '{}')
      console.log(`→ ${call.function.name}(${JSON.stringify(args)})`)
      const r = await executeTool(call.function.name, args)
      messages.push({ role: 'tool', tool_call_id: call.id, content: r.output || 'Success' })
      if (r.image) images.push({ name: call.function.name, image: r.image })
    }
    for (const { name, image } of images) {
      sawImageTurn = true
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: `[Image result of ${name} — this is the screenshot you just took, not a new message from the user.]` },
          { type: 'image_url', image_url: { url: image } }
        ]
      })
    }
  }
} catch (e) {
  console.error('FAIL:', e?.message || e)
  await browser.browserClose()
  process.exit(1)
}
await browser.browserClose()

console.log('\nGemini said:', answer.trim().slice(0, 200))
const ok = sawImageTurn && answer.toUpperCase().includes(SECRET)
console.log(ok ? `\n--- GEMINI SAW THE SCREENSHOT (${SECRET}) OK` : '\n--- FAILED: Gemini did not read the word from the screenshot')
process.exit(ok ? 0 : 1)

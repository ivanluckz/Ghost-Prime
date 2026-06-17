// List + test free Gemini models on OpenRouter (uses existing OPENROUTER_API_KEY).
// Run: node scripts/probe-gemini.mjs
import 'dotenv/config'
import OpenAI from 'openai'

const apiKey = process.env.OPENROUTER_API_KEY
if (!apiKey) {
  console.error('FAIL: OPENROUTER_API_KEY not set')
  process.exit(1)
}

// Discover free gemini slugs from the live catalog.
const res = await fetch('https://openrouter.ai/api/v1/models')
const data = await res.json()
const freeGemini = data.data
  .filter((m) => m.id.includes('gemini'))
  .filter((m) => {
    const p = m.pricing || {}
    return p.prompt === '0' || p.prompt === '0.0'
  })
  .map((m) => m.id)

console.log('Free Gemini slugs on OpenRouter:', freeGemini.length ? freeGemini.join(', ') : '(none)')

const client = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey,
  defaultHeaders: { 'HTTP-Referer': 'https://ghost-prime.local', 'X-Title': 'Ghost-Prime' }
})

for (const model of freeGemini) {
  try {
    const r = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'Reply with one word: ONLINE' }],
      max_tokens: 16
    })
    console.log(`OK   ${model} -> ${JSON.stringify(r.choices?.[0]?.message?.content || '').slice(0, 50)}`)
  } catch (e) {
    console.log(`SKIP ${model} (${e?.status || ''} ${String(e?.message || e).slice(0, 50)})`)
  }
}

// Probe several free OpenRouter models; print the first that responds.
// Run: node scripts/find-free-model.mjs
import 'dotenv/config'
import OpenAI from 'openai'

const apiKey = process.env.OPENROUTER_API_KEY
if (!apiKey) {
  console.error('FAIL: OPENROUTER_API_KEY not set')
  process.exit(1)
}

const client = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey,
  defaultHeaders: { 'HTTP-Referer': 'https://ghost-prime.local', 'X-Title': 'Ghost-Prime' }
})

const candidates = [
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'openai/gpt-oss-120b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'meta-llama/llama-3.2-3b-instruct:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'openrouter/free'
]

for (const model of candidates) {
  try {
    const r = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'Reply with one word: ONLINE' }],
      max_tokens: 16
    })
    const txt = r.choices?.[0]?.message?.content || ''
    console.log(`OK   ${model} -> ${JSON.stringify(txt).slice(0, 60)}`)
    console.log(`WINNER=${model}`)
    process.exit(0)
  } catch (e) {
    console.log(`SKIP ${model} (${e?.status || ''} ${String(e?.message || e).slice(0, 60)})`)
  }
}

console.error('No free model responded (all rate-limited or unavailable).')
process.exit(2)

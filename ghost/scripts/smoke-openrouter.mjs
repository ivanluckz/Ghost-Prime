// Headless end-to-end check of the Ghost-Prime brain for the SELECTED provider.
// Mirrors src/main/agent/provider.js resolution. Run: node scripts/smoke-openrouter.mjs
import 'dotenv/config'
import OpenAI from 'openai'

const PROVIDERS = {
  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    modelEnv: 'OPENROUTER_MODEL',
    defaultModel: 'openai/gpt-oss-120b:free'
  },
  gemini: {
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    apiKeyEnv: 'GEMINI_API_KEY',
    modelEnv: 'GEMINI_MODEL',
    defaultModel: 'gemini-2.5-flash'
  }
}

const provider = process.env.GHOST_PROVIDER || 'openrouter'
const cfg = PROVIDERS[provider]
if (!cfg) {
  console.error(`FAIL: unknown GHOST_PROVIDER "${provider}"`)
  process.exit(1)
}

const apiKey = process.env[cfg.apiKeyEnv]
if (!apiKey) {
  console.error(`FAIL: ${cfg.apiKeyEnv} not set for provider "${provider}"`)
  process.exit(1)
}

const model = process.env[cfg.modelEnv] || process.env.GHOST_MODEL || cfg.defaultModel
const client = new OpenAI({
  baseURL: cfg.baseURL,
  apiKey,
  defaultHeaders: { 'HTTP-Referer': 'https://ghost-prime.local', 'X-Title': 'Ghost-Prime' }
})

try {
  const stream = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: 'Reply with exactly: GHOST-PRIME ONLINE' }],
    max_tokens: 20,
    stream: true
  })
  let out = ''
  for await (const chunk of stream) {
    const d = chunk.choices?.[0]?.delta?.content
    if (d) {
      out += d
      process.stdout.write(d)
    }
  }
  console.log(`\n--- OK · provider=${provider} · model=${model} · streamed ${out.length} chars`)
  process.exit(0)
} catch (err) {
  console.error(`\nFAIL: ${err?.status || ''} ${err?.message || err}`)
  process.exit(1)
}

// Test-only stand-in for the `openai` package: chat.completions.create() returns the next item of
// globalThis.__openaiScript (an Error item is thrown) and records each request in __openaiCalls.
globalThis.__openaiScript = globalThis.__openaiScript || []
globalThis.__openaiCalls = globalThis.__openaiCalls || []
export default class OpenAI {
  constructor(opts) {
    globalThis.__openaiOpts = opts
    this.chat = {
      completions: {
        create: async (body) => {
          globalThis.__openaiCalls.push(body)
          const next = globalThis.__openaiScript.shift()
          if (!next) throw new Error('openai-stub: no scripted response left')
          if (next instanceof Error) throw next
          return next
        }
      }
    }
  }
}

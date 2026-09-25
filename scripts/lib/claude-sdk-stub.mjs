// Stand-in for @anthropic-ai/claude-agent-sdk in offline tests: records every query()'s options in
// globalThis.__sdkCalls. By default it answers with one short text reply. A test can instead set
// globalThis.__sdkScript to the SDK messages to yield, in order; the string 'hang' waits until the
// query is aborted (like the real CLI sitting in its retry backoff). No network, no Claude login.
globalThis.__sdkCalls = globalThis.__sdkCalls || []
export function tool(name, description, schema, handler) {
  return { name, description, schema, handler }
}
export function createSdkMcpServer({ name, tools = [] } = {}) {
  return { type: 'sdk', name, instance: { tools } }
}
export function query({ prompt, options }) {
  globalThis.__sdkCalls.push({ prompt, options })
  const reply = globalThis.__sdkReply ?? 'ok'
  const script = globalThis.__sdkScript || [
    { type: 'assistant', message: { content: [{ type: 'text', text: reply }] } },
    { type: 'result', subtype: 'success', is_error: false, result: reply }
  ]
  const signal = options?.abortController?.signal
  return (async function* () {
    for (const m of script) {
      if (m === 'hang') {
        await new Promise((_, reject) => {
          if (signal?.aborted) return reject(new Error('aborted'))
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      } else yield m
    }
  })()
}

// Stand-in for @anthropic-ai/claude-agent-sdk in offline tests: records every query()'s options in
// globalThis.__sdkCalls. By default it answers with one short text reply. A test can instead set
// globalThis.__sdkScript to the SDK messages to yield, in order; the string 'hang' waits until the
// query is aborted (like the real CLI sitting in its retry backoff); { sleep: ms } pauses; { callTool:
// [server, tool, args] } runs one of our in-process MCP tool handlers. No network, no Claude login.
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
  const gen = (async function* () {
    for (const m of script) {
      if (m && typeof m === 'object' && m.sleep) {
        await new Promise((r) => setTimeout(r, m.sleep)) // the CLI keeps going for a moment after an abort
      } else if (m && typeof m === 'object' && m.callTool) {
        // Like the CLI calling one of our in-process MCP tools: run its handler, record the result.
        const [server, name, args] = m.callTool
        const t = options?.mcpServers?.[server]?.instance?.tools?.find((x) => x.name === name)
        globalThis.__sdkToolResults = globalThis.__sdkToolResults || []
        globalThis.__sdkToolResults.push({ name, result: t ? await t.handler(args, {}) : { error: 'no such tool' } })
      } else if (m === 'hang') {
        await new Promise((_, reject) => {
          if (signal?.aborted) return reject(new Error('aborted'))
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      } else yield m
    }
  })()
  gen.interrupt = async () => {
    globalThis.__sdkInterrupted = (globalThis.__sdkInterrupted || 0) + 1
  }
  return gen
}

// Stand-in for @anthropic-ai/claude-agent-sdk in offline tests: records every query()'s options in
// globalThis.__sdkCalls and answers with one short text reply. No network, no Claude login.
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
  return (async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'text', text: reply }] } }
    yield { type: 'result', subtype: 'success', is_error: false, result: reply }
  })()
}

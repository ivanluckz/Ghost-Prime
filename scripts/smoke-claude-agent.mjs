// Verify the claude-agent brain via the Claude Agent SDK on your Claude Code login.
// Mirrors src/main/agent/provider.js. Run: node scripts/smoke-claude-agent.mjs
import { homedir } from 'node:os'
import { query } from '@anthropic-ai/claude-agent-sdk'

const model = process.env.CLAUDE_AGENT_MODEL || 'haiku'

const response = query({
  prompt: 'Reply with exactly: GHOST ONLINE',
  options: {
    model,
    systemPrompt: 'You are Ghost-Prime.',
    includePartialMessages: true,
    allowedTools: [],
    disallowedTools: ['Bash', 'Write', 'Edit'],
    settingSources: [],
    strictMcpConfig: true,
    cwd: homedir()
  }
})

let streamed = ''
let ok = false
for await (const msg of response) {
  if (msg.type === 'stream_event') {
    const ev = msg.event
    if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
      streamed += ev.delta.text
      process.stdout.write(ev.delta.text)
    }
  } else if (msg.type === 'assistant' && msg.error) {
    console.error('\nassistant error:', msg.error)
  } else if (msg.type === 'result') {
    const text = streamed || (typeof msg.result === 'string' ? msg.result : '')
    ok = msg.subtype === 'success' && !msg.is_error && /GHOST ONLINE/.test(text)
    console.log(
      `\n--- result subtype=${msg.subtype} is_error=${msg.is_error} ` +
        `cost=$${msg.total_cost_usd?.toFixed?.(5) ?? '?'} model=${model} ` +
        `streamed=${streamed.length}ch`
    )
    if (!streamed && msg.result) console.log('final(non-stream):', JSON.stringify(msg.result))
  }
}
console.log(ok ? '--- claude-agent OK' : '--- claude-agent CHECK FAILED')
process.exit(ok ? 0 : 1)

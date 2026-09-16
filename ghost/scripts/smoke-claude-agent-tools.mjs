// Phase 3 verification: claude-agent runs a real tool (Bash) autonomously.
// Run: node scripts/smoke-claude-agent-tools.mjs
import { homedir } from 'node:os'
import { query } from '@anthropic-ai/claude-agent-sdk'

const model = process.env.CLAUDE_AGENT_MODEL || 'haiku'
const MARKER = 'hello-from-ghost-prime'

const response = query({
  prompt: `Use your Bash tool to run exactly: echo ${MARKER}\nThen tell me the exact output.`,
  options: {
    model,
    systemPrompt: 'You are Ghost-Prime. Use your Bash tool to run the command, then report the output.',
    includePartialMessages: true,
    allowedTools: ['Bash'],
    permissionMode: process.env.GHOST_TEST_PERMISSION || 'bypassPermissions',
    allowDangerouslySkipPermissions:
      (process.env.GHOST_TEST_PERMISSION || 'bypassPermissions') === 'bypassPermissions',
    settingSources: [],
    strictMcpConfig: true,
    cwd: homedir()
  }
})

let text = ''
let ranBash = false
let toolOutputSawMarker = false

for await (const msg of response) {
  if (msg.type === 'stream_event') {
    const ev = msg.event
    if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
      text += ev.delta.text
    }
  } else if (msg.type === 'assistant') {
    for (const block of msg.message?.content || []) {
      if (block?.type === 'tool_use') {
        ranBash = ranBash || block.name === 'Bash'
        console.log(`  [tool_use] ${block.name}(${JSON.stringify(block.input).slice(0, 80)})`)
      }
    }
  } else if (msg.type === 'user') {
    const content = msg.message?.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'tool_result') {
          const out =
            typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map((c) => (c?.type === 'text' ? c.text : '')).join('')
                : ''
          if (out.includes(MARKER)) toolOutputSawMarker = true
          console.log(`  [tool_result] ${JSON.stringify(out).slice(0, 80)}`)
        }
      }
    }
  } else if (msg.type === 'result') {
    console.log(`\nfinal text: ${JSON.stringify((text || msg.result || '').slice(0, 120))}`)
    console.log(
      `result: subtype=${msg.subtype} cost=$${msg.total_cost_usd?.toFixed?.(5) ?? '?'} turns=${msg.num_turns}`
    )
  }
}

const ok = ranBash && toolOutputSawMarker
console.log(ok ? '--- AGENT TOOL LOOP OK (ran bash, saw output)' : '--- FAILED')
process.exit(ok ? 0 : 1)

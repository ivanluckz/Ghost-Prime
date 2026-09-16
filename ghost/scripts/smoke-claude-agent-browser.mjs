// Phase 3 verification: the claude-agent drives the Playwright browser via SDK MCP tools.
// Run: GHOST_BROWSER_HEADLESS=true node scripts/smoke-claude-agent-browser.mjs
import { homedir } from 'node:os'
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import * as browser from '../src/main/tools/browser.js'

const server = createSdkMcpServer({
  name: 'ghost-browser',
  version: '1.0.0',
  tools: [
    tool('browser_navigate', 'Open a URL. Returns final URL + title.', { url: z.string() }, async ({ url }) => {
      const r = await browser.browserNavigate({ url })
      return { content: [{ type: 'text', text: `Navigated to ${r.url} — "${r.title}"` }] }
    }),
    tool('browser_get_text', 'Get the visible text of the current page.', {}, async () => {
      const r = await browser.browserGetText()
      return { content: [{ type: 'text', text: `# ${r.title}\n${r.url}\n\n${r.text.slice(0, 2000)}` }] }
    })
  ]
})

const model = process.env.CLAUDE_AGENT_MODEL || 'haiku'
const response = query({
  prompt:
    'Use your browser_navigate tool to open https://example.com, then tell me the exact page title.',
  options: {
    model,
    systemPrompt: 'You are Ghost-Prime. Use the browser_* tools to complete the task.',
    includePartialMessages: true,
    allowedTools: ['mcp__ghost-browser__browser_navigate', 'mcp__ghost-browser__browser_get_text'],
    mcpServers: { 'ghost-browser': server },
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: [],
    strictMcpConfig: true,
    cwd: homedir()
  }
})

let text = ''
let usedBrowser = false
for await (const msg of response) {
  if (msg.type === 'stream_event') {
    const ev = msg.event
    if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) text += ev.delta.text
  } else if (msg.type === 'assistant') {
    for (const b of msg.message?.content || []) {
      if (b?.type === 'tool_use') {
        usedBrowser = usedBrowser || String(b.name).includes('browser')
        console.log(`  [tool_use] ${b.name}(${JSON.stringify(b.input).slice(0, 60)})`)
      }
    }
  } else if (msg.type === 'result') {
    console.log(`\nfinal: ${JSON.stringify((text || msg.result || '').slice(0, 160))}`)
    console.log(`subtype=${msg.subtype} cost=$${msg.total_cost_usd?.toFixed?.(5) ?? '?'} turns=${msg.num_turns}`)
  }
}
await browser.browserClose()

const ok = usedBrowser && /example/i.test(text)
console.log(ok ? '--- BROWSER AGENT OK' : '--- FAILED')
process.exit(ok ? 0 : 1)

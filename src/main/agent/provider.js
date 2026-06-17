import { homedir } from 'node:os'
import OpenAI from 'openai'
import * as browser from '../tools/browser.js'
import * as screen from '../tools/screen.js'
import { saveMemory, recallMemories, memoryDigest } from '../memory/db.js'

// Pluggable brain providers. Select with GHOST_PROVIDER in .env:
//   claude-agent — real Claude via the Claude Agent SDK on your Claude Code login (no API key)
//   gemini       — Google AI Studio free tier (OpenAI-compatible)
//   openrouter   — OpenRouter (OpenAI-compatible); free models or paid Claude
const OPENAI_PROVIDERS = {
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

// Default brain: real Claude on your Claude Code Pro login (no API billing). When Claude is
// unavailable for a turn — Pro/Agent-SDK credit spent, usage/rate limit, or auth — we fall
// back to GHOST_FALLBACK_PROVIDER (OpenRouter free model) for that one reply, then try Claude
// again on the next message. Pin a brain explicitly any time with GHOST_PROVIDER=openrouter|gemini.
const PROVIDER = process.env.GHOST_PROVIDER || 'claude-agent'
const FALLBACK_PROVIDER = process.env.GHOST_FALLBACK_PROVIDER || 'openrouter'

// Built-in SDK tools the claude-agent brain may use.
const AGENT_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch']

// Our Playwright browser, exposed to the agent as an in-process SDK MCP server.
// MCP tool names are namespaced: mcp__<serverName>__<toolName>.
const BROWSER_SERVER = 'ghost-browser'
const BROWSER_TOOL_NAMES = [
  'browser_navigate',
  'browser_get_text',
  'browser_click',
  'browser_fill',
  'browser_screenshot',
  'browser_read_pages',
  'browser_click_at',
  'browser_scroll'
].map((n) => `mcp__${BROWSER_SERVER}__${n}`)

// Our cross-session memory, exposed to the agent as an in-process SDK MCP server.
const MEMORY_SERVER = 'ghost-memory'
const MEMORY_TOOL_NAMES = ['memory_save', 'memory_recall'].map((n) => `mcp__${MEMORY_SERVER}__${n}`)

// Experimental desktop control (screenshot + keyboard/mouse for native Linux apps, beyond the
// browser). Off unless GHOST_SCREEN_TOOLS=1 — limited on Crostini (see src/main/tools/screen.js).
const SCREEN_ENABLED = process.env.GHOST_SCREEN_TOOLS === '1'
const SCREEN_SERVER = 'ghost-screen'
const SCREEN_TOOL_NAMES = ['screen_screenshot', 'screen_type', 'screen_key', 'screen_click', 'launch_app'].map(
  (n) => `mcp__${SCREEN_SERVER}__${n}`
)

// UI autonomy mode (cycled with Shift+Tab) → SDK permission mode.
const MODE_TO_PERMISSION = { plan: 'plan', auto: 'auto', full: 'bypassPermissions' }

const SYSTEM_PROMPT = `You are Ghost-Prime, an autonomous AI agent running on the user's own Chrome OS / Crostini Linux machine. You act on their behalf with real tools — you do the work, you don't just advise on how to do it.

YOUR TOOLS — all already loaded and directly callable this turn. There is NO step to "load", "search for", "enable", or "initialize" a tool first; when a task needs one, just call it.
- Bash — run shell commands on the local machine.
- Read / Write / Edit / Glob / Grep — read and change local files.
- WebFetch / WebSearch — fetch a URL or search the web for current information.
- browser_navigate / browser_get_text / browser_click / browser_fill / browser_screenshot — drive the user's REAL Google Chrome, already signed in to their sites. To open a page, call browser_navigate immediately.
- memory_save / memory_recall — your long-term memory across sessions.

DRIVING THE BROWSER:
- To click, prefer browser_click with a "text" argument — the element's visible label, e.g. {text:"Log In"}. If you must use a selector it has to be STANDARD CSS (#id, .class, [aria-label=...], [data-...]) or xpath — never jQuery selectors like :contains(), :visible, or :eq().
- Confirm your action landed: after a click or fill, call browser_get_text or browser_screenshot to check the page actually changed before reporting success. Use browser_screenshot whenever you need to SEE the page (layout, an image, a captcha, anything visual).
- If a click fails, the error lists the page's visible clickable elements — retry with the exact text of the right one instead of guessing again.
- To research or compare across multiple pages, call browser_read_pages with ALL the URLs at once (one call opens and reads them in parallel) — far faster than visiting pages one by one.
- When clicking by text or selector keeps failing, call browser_screenshot to SEE the page, then browser_click_at with the element's center as x,y fractions (0..1) of the image — you can see it, so aim for it.
- If what you need is off-screen (long page, chat history, infinite scroll), browser_scroll (down/up/top/bottom), then look again with browser_screenshot or browser_get_text.

MEMORY:
- Recall what you already know (memory_recall) when prior context would help, especially at the start of a task.
- Save durable facts and preferences the user shares (memory_save) — their name, how they like things done, ongoing projects — not transient chatter.

HOW TO WORK:
- Act directly and autonomously. The user often isn't watching in real time and can't answer mid-task, so for reversible actions that follow from the request, proceed without asking. Ask first only before destructive or irreversible actions — deleting data, overwriting files, sending messages, force-pushing, anything hard to undo.
- Ground every progress and success claim in an actual tool result. If you haven't verified something, say so plainly; never report a step as done that you didn't confirm.
- Be concise but clear, and lead with the outcome — what happened or what you found — then any supporting detail. Skip routine narration ("Now I'll...", "Let me..."). Your replies may be read aloud, so write in plain, speakable sentences.
- Respect your current autonomy mode: in plan mode, investigate and lay out a concrete plan, but do not run anything that changes state.`

// ---------------------------------------------------------------------------
// OpenAI-compatible providers (openrouter, gemini)
// ---------------------------------------------------------------------------
const openAIClients = new Map() // provider name -> OpenAI client (lazy, cached per provider)

function getOpenAIConfig(providerName) {
  const cfg = OPENAI_PROVIDERS[providerName]
  if (!cfg) {
    throw new Error(
      `Unknown provider "${providerName}". Use one of: ${[...Object.keys(OPENAI_PROVIDERS), 'claude-agent'].join(', ')}.`
    )
  }
  return cfg
}

function getClient(providerName) {
  const cfg = getOpenAIConfig(providerName)
  const apiKey = process.env[cfg.apiKeyEnv]
  if (!apiKey) {
    throw new Error(`${cfg.apiKeyEnv} is not set for provider "${providerName}". Add it to .env.`)
  }
  if (!openAIClients.has(providerName)) {
    openAIClients.set(
      providerName,
      new OpenAI({
        baseURL: cfg.baseURL,
        apiKey,
        defaultHeaders: { 'HTTP-Referer': 'https://ghost-prime.local', 'X-Title': 'Ghost-Prime' }
      })
    )
  }
  return openAIClients.get(providerName)
}

async function streamChatOpenAI({ messages, signal, onDelta, model, provider = PROVIDER }) {
  const cfg = getOpenAIConfig(provider)
  const openai = getClient(provider)
  const useModel = model || process.env[cfg.modelEnv] || process.env.GHOST_MODEL || cfg.defaultModel

  const stream = await openai.chat.completions.create(
    {
      model: useModel,
      messages: [
        { role: 'system', content: 'You are Ghost-Prime, a concise, helpful local AI agent.' },
        ...messages
      ],
      stream: true
    },
    { signal }
  )

  let full = ''
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content
    if (delta) {
      full += delta
      onDelta(delta)
    }
  }
  return full
}

// ---------------------------------------------------------------------------
// Browser MCP server — wraps src/main/tools/browser.js as SDK tools.
// Built lazily once (loading zod + the SDK helpers on demand).
// ---------------------------------------------------------------------------
let browserMcpServer = null

async function getBrowserMcpServer() {
  if (browserMcpServer) return browserMcpServer
  const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk')
  const { z } = await import('zod')

  browserMcpServer = createSdkMcpServer({
    name: BROWSER_SERVER,
    version: '1.0.0',
    tools: [
      tool(
        'browser_navigate',
        'Open a URL in the controlled browser. Returns the final URL and page title.',
        { url: z.string() },
        async ({ url }) => {
          const r = await browser.browserNavigate({ url })
          return { content: [{ type: 'text', text: `Navigated to ${r.url} — "${r.title}"` }] }
        }
      ),
      tool(
        'browser_get_text',
        'Get the visible text of the current page. Use to read page content before acting.',
        {},
        async () => {
          const r = await browser.browserGetText()
          return { content: [{ type: 'text', text: `# ${r.title}\n${r.url}\n\n${r.text}` }] }
        }
      ),
      tool(
        'browser_click',
        'Click an element on the current page. BEST: pass { text: "Log In" } to click by the ' +
          "element's visible button/link text — most reliable. Otherwise pass { selector } as a " +
          'STANDARD CSS selector: an id (#submit), class (.login-btn), or attribute ' +
          '([aria-label="Log In"], [data-action="login"]); :nth-of-type() for position; or an ' +
          'xpath ("xpath=//button[normalize-space()=\'Log In\']"). NEVER use jQuery selectors ' +
          'like :contains(), :visible, :eq() — they are invalid CSS and will fail.',
        { selector: z.string().optional(), text: z.string().optional() },
        async ({ selector, text }) => {
          const r = await browser.browserClick({ selector, text })
          const what = text ? `text "${text}"` : selector
          return { content: [{ type: 'text', text: `Clicked ${what} — now at ${r.url}` }] }
        }
      ),
      tool(
        'browser_fill',
        'Type a value into an input/textarea. Pass { label, value } to target the field by its ' +
          'visible label/placeholder, or { selector, value } with a STANDARD CSS selector ' +
          '(#id, .class, [name="email"]). Never use jQuery selectors like :contains().',
        { selector: z.string().optional(), label: z.string().optional(), value: z.string() },
        async ({ selector, label, value }) => {
          await browser.browserFill({ selector, label, value })
          return { content: [{ type: 'text', text: `Filled ${label ? `field "${label}"` : selector}` }] }
        }
      ),
      tool(
        'browser_screenshot',
        'Capture a screenshot of the current browser page so you can see it.',
        {},
        async () => {
          const r = await browser.browserScreenshot()
          return { content: [{ type: 'image', data: r.base64, mimeType: 'image/png' }] }
        }
      ),
      tool(
        'browser_read_pages',
        'Open SEVERAL web pages at once and get each one\'s readable text back in a single call — ' +
          'the fast way to research or compare across multiple sites/products. Pass ' +
          '{ urls: ["https://…", "https://…"] } (up to 8). Strongly prefer this over visiting pages ' +
          'one at a time whenever a task spans multiple pages; the pages open and load in parallel ' +
          'in the real browser. Add keepOpen:false to close the tabs after reading.',
        { urls: z.array(z.string()), keepOpen: z.boolean().optional() },
        async ({ urls, keepOpen }) => {
          const r = await browser.browserReadPages({ urls, keepOpen })
          const text = (r.pages || [])
            .map(
              (p, i) =>
                `## [${i + 1}] ${p.title || p.url}\n${p.url}\n` +
                (p.error ? `(could not read: ${p.error})` : (p.text || '').slice(0, 6000))
            )
            .join('\n\n---\n\n')
          return { content: [{ type: 'text', text: text || 'No pages could be read.' }] }
        }
      ),
      tool(
        'browser_click_at',
        'Click a specific point you located from a screenshot — x and y are fractions of the image/' +
          'viewport (0..1, top-left origin). Use this when browser_click by text or selector fails: ' +
          'call browser_screenshot, find the element visually, then click its center here.',
        { x: z.number(), y: z.number() },
        async ({ x, y }) => {
          const r = await browser.browserClickAt({ x, y })
          return { content: [{ type: 'text', text: `Clicked at (${x}, ${y}) — now at ${r.url}` }] }
        }
      ),
      tool(
        'browser_scroll',
        'Scroll the page to reveal content below/above the fold, or to load more (infinite scroll, ' +
          'chat history). Pass { direction: "down" | "up" | "top" | "bottom" }; optionally { amount } in ' +
          'pixels, or { selector } to scroll a specific scrollable area. Defaults to ~one screen down. ' +
          'After scrolling, call browser_screenshot or browser_get_text again to see the new content.',
        { direction: z.enum(['down', 'up', 'top', 'bottom']).optional(), amount: z.number().optional(), selector: z.string().optional() },
        async ({ direction, amount, selector }) => {
          await browser.browserScroll({ direction, amount, selector })
          return { content: [{ type: 'text', text: `Scrolled ${direction || 'down'}${selector ? ` in ${selector}` : ''}.` }] }
        }
      )
    ]
  })
  return browserMcpServer
}

// ---------------------------------------------------------------------------
// Memory MCP server — wraps the SQLite memory store as save/recall tools.
// ---------------------------------------------------------------------------
let memoryMcpServer = null

async function getMemoryMcpServer() {
  if (memoryMcpServer) return memoryMcpServer
  const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk')
  const { z } = await import('zod')

  memoryMcpServer = createSdkMcpServer({
    name: MEMORY_SERVER,
    version: '1.0.0',
    tools: [
      tool(
        'memory_save',
        'Save a durable fact, preference, or note to remember across sessions.',
        {
          content: z.string(),
          type: z.enum(['fact', 'preference', 'task', 'event']).optional(),
          importance: z.number().min(1).max(10).optional()
        },
        async ({ content, type, importance }) => {
          const id = saveMemory(content, type || 'fact', importance || 5)
          return { content: [{ type: 'text', text: id ? 'Saved to memory.' : 'Could not save memory.' }] }
        }
      ),
      tool(
        'memory_recall',
        'Search long-term memory for facts/preferences relevant to a query (omit query for the most important).',
        { query: z.string().optional() },
        async ({ query }) => {
          const rows = recallMemories(query || '', 8)
          const text = rows.length
            ? rows.map((r) => `- [${r.type}] ${r.content}`).join('\n')
            : 'No memories stored yet.'
          return { content: [{ type: 'text', text }] }
        }
      )
    ]
  })
  return memoryMcpServer
}

let screenMcpServer = null
async function getScreenMcpServer() {
  if (screenMcpServer) return screenMcpServer
  const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk')
  const { z } = await import('zod')
  screenMcpServer = createSdkMcpServer({
    name: SCREEN_SERVER,
    version: '1.0.0',
    tools: [
      tool(
        'launch_app',
        'Open an installed Linux app (Discord, a terminal, etc.). Pass { command } like "discord" or "gtk-launch discord".',
        { command: z.string() },
        async ({ command }) => {
          const r = await screen.launchApp({ command })
          return { content: [{ type: 'text', text: `Launched: ${r.launched}` }] }
        }
      ),
      tool(
        'screen_screenshot',
        'Screenshot the Linux desktop / focused app window so you can see a native app (beyond the browser).',
        {},
        async () => {
          const r = await screen.screenScreenshot()
          return { content: [{ type: 'image', data: r.base64, mimeType: 'image/png' }] }
        }
      ),
      tool('screen_type', 'Type text into the focused Linux app window.', { text: z.string() }, async ({ text }) => {
        await screen.screenType({ text })
        return { content: [{ type: 'text', text: 'typed' }] }
      }),
      tool(
        'screen_key',
        'Press a key or combo in the focused window (xdotool names: Return, ctrl+c, alt+Tab).',
        { keys: z.string() },
        async ({ keys }) => {
          await screen.screenKey({ keys })
          return { content: [{ type: 'text', text: `pressed ${keys}` }] }
        }
      ),
      tool(
        'screen_click',
        'Click on the Linux desktop. Pass { x, y } pixels to move+click there, or omit to click where the pointer is.',
        { x: z.number().optional(), y: z.number().optional() },
        async ({ x, y }) => {
          await screen.screenClick({ x, y })
          return { content: [{ type: 'text', text: 'clicked' }] }
        }
      )
    ]
  })
  return screenMcpServer
}

// ---------------------------------------------------------------------------
// Claude Agent provider — Claude Agent SDK on the user's Claude Code login.
// Autonomy mode (Shift+Tab) → permissionMode. onEvent surfaces tool activity.
// SDK is ESM-only → dynamic import().
// ---------------------------------------------------------------------------
async function streamChatClaudeAgent({ messages, signal, onDelta, onEvent, model, mode, effort, thinking }) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  // Default to 'sonnet' (Claude Sonnet 4.6) — the balanced choice for agentic, multi-step work
  // like driving the browser. 'haiku' is fast but unreliable at tool use: it tends to *describe*
  // using a tool (or claim it must "load" one) instead of actually calling it. Override per
  // environment with CLAUDE_AGENT_MODEL ('opus' for the hardest tasks, 'haiku' for cheap simple
  // chat). Runs on your Claude Pro login, so model choice changes how fast the Pro allotment is
  // spent, never your bill.
  const useModel = model || process.env.CLAUDE_AGENT_MODEL || 'sonnet'
  const permissionMode = MODE_TO_PERMISSION[mode] || 'auto'
  // Speed: Sonnet 4.6 defaults to HIGH effort (deliberate → slower). Drop to 'low' for snappy
  // replies: fewer/consolidated tool calls, less preamble, faster first token. Bump
  // CLAUDE_AGENT_EFFORT to medium/high/xhigh/max for harder multi-step work. Effort is only valid
  // on Sonnet 4.6 / Opus / Fable (Haiku 4.5 would 400), so we skip it for haiku. Set
  // CLAUDE_AGENT_THINKING=off to disable thinking entirely for the fastest possible first token.
  const effortVal = effort || process.env.CLAUDE_AGENT_EFFORT || 'low'
  const supportsEffort = !/haiku/i.test(useModel)
  const thinkingOff = (thinking || process.env.CLAUDE_AGENT_THINKING || '').toLowerCase() === 'off'
  const transcript = messages
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n')

  const abortController = new AbortController()
  if (signal) {
    if (signal.aborted) abortController.abort()
    else signal.addEventListener('abort', () => abortController.abort(), { once: true })
  }

  const browserServer = await getBrowserMcpServer()
  const memoryServer = await getMemoryMcpServer()
  const screenServer = SCREEN_ENABLED ? await getScreenMcpServer() : null

  // Auto-inject the highest-signal memories so Claude "remembers" without being asked.
  const digest = memoryDigest(8)
  const memoryContext = digest.length
    ? '\n\nWhat you remember from earlier sessions:\n' +
      digest.map((m) => `- [${m.type}] ${m.content}`).join('\n')
    : ''

  const response = query({
    prompt: transcript,
    options: {
      model: useModel,
      ...(supportsEffort && !thinkingOff ? { effort: effortVal } : {}), // 'low' = snappy (effort guides thinking)
      ...(thinkingOff ? { thinking: { type: 'disabled' } } : {}),
      systemPrompt: SYSTEM_PROMPT + memoryContext,
      includePartialMessages: true,
      allowedTools: [...AGENT_TOOLS, ...BROWSER_TOOL_NAMES, ...MEMORY_TOOL_NAMES, ...(screenServer ? SCREEN_TOOL_NAMES : [])],
      mcpServers: screenServer
        ? { [BROWSER_SERVER]: browserServer, [MEMORY_SERVER]: memoryServer, [SCREEN_SERVER]: screenServer }
        : { [BROWSER_SERVER]: browserServer, [MEMORY_SERVER]: memoryServer },
      permissionMode, // plan | auto | bypassPermissions — from the UI mode (Shift+Tab)
      allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions',
      settingSources: [], // isolation: no user/project MCP (higgsfield), CLAUDE.md, skills
      strictMcpConfig: true, // only our in-process mcpServers — ignore on-disk config
      cwd: homedir(),
      abortController
    }
  })

  let streamed = ''
  for await (const msg of response) {
    if (msg.type === 'stream_event') {
      const ev = msg.event
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
        streamed += ev.delta.text
        onDelta(ev.delta.text)
      }
    } else if (msg.type === 'assistant') {
      if (msg.error) throw new Error(`claude-agent error: ${msg.error}`)
      for (const block of msg.message?.content || []) {
        if (block?.type === 'tool_use') {
          onEvent?.({ kind: 'tool_use', id: block.id, name: block.name, input: block.input })
        }
      }
    } else if (msg.type === 'user') {
      const content = msg.message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_result') {
            // A tool result is text and/or images (e.g. browser_screenshot). Pull both:
            // text for the <pre>, the first image as a data URL the renderer can show.
            let text = ''
            let image = null
            if (typeof block.content === 'string') {
              text = block.content
            } else if (Array.isArray(block.content)) {
              for (const c of block.content) {
                if (c?.type === 'text') text += c.text
                else if (c?.type === 'image' && !image) {
                  const data = c.data || c.source?.data
                  const mime = c.mimeType || c.source?.media_type || 'image/png'
                  if (data) image = `data:${mime};base64,${data}`
                }
              }
            }
            const output = text.length > 4000 ? text.slice(0, 4000) + '\n…[truncated]' : text
            onEvent?.({
              kind: 'tool_result',
              id: block.tool_use_id,
              output,
              image,
              isError: !!block.is_error
            })
          }
        }
      }
    } else if (msg.type === 'result') {
      if (msg.subtype !== 'success' || msg.is_error) {
        throw new Error((typeof msg.result === 'string' && msg.result) || `claude-agent failed (${msg.subtype})`)
      }
      if (!streamed && typeof msg.result === 'string' && msg.result) {
        onDelta(msg.result)
        streamed = msg.result
      }
    }
  }
  return streamed
}

// Errors that mean "Claude itself is unavailable right now" — credit/usage/rate/auth — rather
// than a bug in a tool or our own code. Only these trigger the automatic OpenRouter fallback.
function isClaudeUnavailable(err) {
  const msg = (err?.message || String(err)).toLowerCase()
  return /usage limit|rate.?limit|too many requests|\b429\b|\b529\b|\b503\b|quota|credit|insufficient|balance|billing|payment|overloaded|temporarily unavailable|service unavailable|\b401\b|\b403\b|unauthorized|forbidden|authentication|not authenticated|not logged in|invalid api key|please log ?in|token (?:expired|invalid)|subscription/.test(
    msg
  )
}

function fallbackReady() {
  const cfg = OPENAI_PROVIDERS[FALLBACK_PROVIDER]
  return !!(cfg && process.env[cfg.apiKeyEnv])
}

export async function streamChat(opts) {
  // Explicitly pinned to an OpenAI-compatible brain (GHOST_PROVIDER=openrouter|gemini).
  if (PROVIDER !== 'claude-agent') return streamChatOpenAI({ ...opts, provider: PROVIDER })

  // Default path: real Claude. Auto-fall back to OpenRouter for THIS turn only if Claude is
  // out of credits / rate-limited / unauthenticated — the next message tries Claude again.
  let streamedAny = false
  const onDelta = (t) => {
    streamedAny = true
    opts.onDelta?.(t)
  }
  try {
    return await streamChatClaudeAgent({ ...opts, onDelta })
  } catch (err) {
    // User aborted, or Claude already produced text → surface as-is (never double-answer).
    if (opts.signal?.aborted || streamedAny) throw err
    if (!isClaudeUnavailable(err) || !fallbackReady()) throw err
    const reason = (err?.message || String(err)).split('\n')[0].slice(0, 160)
    console.warn(`[ghost] Claude unavailable → falling back to ${FALLBACK_PROVIDER}: ${reason}`)
    opts.onDelta?.(
      `_⚡ Claude is unavailable right now (${reason}). Using the ${FALLBACK_PROVIDER} backup brain for this reply — I'll switch back to Claude on your next message._\n\n`
    )
    return await streamChatOpenAI({ ...opts, model: undefined, provider: FALLBACK_PROVIDER })
  }
}

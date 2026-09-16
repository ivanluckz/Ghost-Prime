import { homedir } from 'node:os'
import { clipboard, Notification, BrowserWindow } from 'electron'
import OpenAI from 'openai'
import * as browser from '../tools/browser.js'
import * as screen from '../tools/screen.js'
import * as shell from '../tools/shell-sessions.js'
import { saveMemory, recallMemories, memoryDigest } from '../memory/db.js'
import { toolSpecs, executeTool } from '../tools/index.js'

// Pluggable brain providers. Select with GHOST_PROVIDER in .env:
//   gemini       — Google AI Studio free tier (Gemini 2.5 Flash / Pro) with FULL autonomous tool calling
//   claude-agent — Claude Agent SDK on your Claude Code login
//   openrouter   — OpenRouter (OpenAI-compatible)
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

// Default brain: gemini (free Google AI Studio key from Jarvis, with full tool-calling support)
const PROVIDER = process.env.GHOST_PROVIDER || 'gemini'
const FALLBACK_PROVIDER = process.env.GHOST_FALLBACK_PROVIDER || 'gemini'


// Built-in SDK tools the claude-agent brain may use. (Bash is intentionally omitted — shell work
// goes through our ghost-shell server below so it runs in the LIVE, persistent terminals the user
// can see and the agent can keep several of.)
const AGENT_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch']

// Our live multi-session terminals (node-pty), exposed to the agent as an in-process SDK MCP server.
const SHELL_SERVER = 'ghost-shell'
const SHELL_TOOL_NAMES = ['shell_run', 'shell_open', 'shell_read', 'shell_list', 'shell_kill'].map(
  (n) => `mcp__${SHELL_SERVER}__${n}`
)

// Our Playwright browser, exposed to the agent as an in-process SDK MCP server.
// MCP tool names are namespaced: mcp__<serverName>__<toolName>.
const BROWSER_SERVER = 'ghost-browser'
const BROWSER_TOOL_NAMES = [
  'browser_navigate',
  'browser_go_back',
  'browser_go_forward',
  'browser_reload',
  'browser_get_text',
  'browser_click',
  'browser_fill',
  'browser_screenshot',
  'browser_read_pages',
  'browser_click_at',
  'browser_scroll',
  'browser_wait_for',
  'browser_press_key',
  'browser_list_tabs',
  'browser_use_tab',
  'browser_list_browsers',
  'browser_use_browser'
].map((n) => `mcp__${BROWSER_SERVER}__${n}`)

// Our cross-session memory, exposed to the agent as an in-process SDK MCP server.
const MEMORY_SERVER = 'ghost-memory'
const MEMORY_TOOL_NAMES = ['memory_save', 'memory_recall'].map((n) => `mcp__${MEMORY_SERVER}__${n}`)

// Local-machine conveniences: read/write the system clipboard, push a desktop notification.
const SYSTEM_SERVER = 'ghost-system'
const SYSTEM_TOOL_NAMES = ['clipboard_read', 'clipboard_write', 'notify_user'].map((n) => `mcp__${SYSTEM_SERVER}__${n}`)

// External Canva MCP (the @canva/cli dev server) — gives the agent Canva's tools. Spawned per session
// via npx; needs Node >= 22. On by default; set GHOST_CANVA=0 to drop it (saves tokens for this
// cost-sensitive user). `mcp__canva` in allowedTools permits all of its tools.
const CANVA_ENABLED = process.env.GHOST_CANVA !== '0'
const CANVA_SERVER = 'canva'

// Experimental desktop control (screenshot + keyboard/mouse for native Linux apps, beyond the
// browser). Off unless GHOST_SCREEN_TOOLS=1 — limited on Crostini (see src/main/tools/screen.js).
const SCREEN_ENABLED = process.env.GHOST_SCREEN_TOOLS === '1'
const SCREEN_SERVER = 'ghost-screen'
const SCREEN_TOOL_NAMES = ['screen_screenshot', 'screen_type', 'screen_key', 'screen_click', 'launch_app'].map(
  (n) => `mcp__${SCREEN_SERVER}__${n}`
)

// UI autonomy mode (cycled with Shift+Tab) → SDK permission mode.
const MODE_TO_PERMISSION = { plan: 'plan', auto: 'auto', full: 'bypassPermissions' }

// Does the message refer to the page the user is looking at? Gates auto page-context so we only pay
// the extra tokens when it's plausibly relevant — and it's harmless to miss, since browser_get_text
// can still fetch the page on demand. Active-tab mode is opt-in ("act on the tab I'm on"), so when
// it's on we lean toward attaching: reading, editing the on-page editor, and clicking/scrolling all
// count as "about this page".
function refersToCurrentPage(text) {
  const t = String(text || '')
  // 1. Explicit mention of the current page / tab / on-screen thing.
  if (
    /\b(this|current) (page|site|tab|window|article|video|form|doc|document|post|thread|email|message|conversation|screen|image|photo|picture|chart|table|selection|paragraph|sentence|slide|cell|code|story|essay|draft)\b/i.test(t)
  )
    return true
  if (/\b(on|in|from) (this|the) (page|site|tab|screen|doc|document|form|article|video)\b/i.test(t)) return true
  if (/\b(on[- ]?screen|up here|down here|right here|over here|above|below)\b/i.test(t)) return true
  // 2. Standalone asks that almost always mean "the thing in front of me".
  if (/\b(summari[sz]e|tl;?dr|recap|proofread)\b/i.test(t)) return true
  if (/\b(what|who|where|when|why|how)('?s| is| are| does| do| did| about)?\s+(this|that|it|these|those|they)\b/i.test(t))
    return true
  // 3. An action verb aimed at "this / it / that / here / the page" — covers reading, editing the
  //    on-page editor (Docs/Slides/Notion), and acting on the live page (click/scroll/fill).
  if (
    /\b(read|re-?read|translate|explain|describe|rewrite|reword|rephrase|paraphrase|shorten|lengthen|expand|simplify|make|turn|improve|polish|edit|fix|correct|continue|finish|complete|fill|copy|cut|paste|highlight|select|answer|reply|respond|comment|sign|submit|send|post|share|bold|italic|underline|format|delete|remove|clear|check|uncheck|toggle|download|bookmark|rate|like|upvote)\b[^.?!\n]{0,24}\b(this|that|it|these|those|here|the (page|form|field|button|link|doc|document|text|selection|video|image|email|post|comment))\b/i.test(t)
  )
    return true
  // 4. Clicking/tapping/scrolling is inherently about the page in front of you.
  if (/\b(click|tap|double-?click|right-?click|scroll|hover over|press the)\b/i.test(t)) return true
  // 5. Fixed page-action phrases.
  if (/\b(select all|scroll (up|down|to (the )?(top|bottom))|fill (this|it|the form)( out| in)?|(log|sign) ?in here)\b/i.test(t))
    return true
  return false
}

const SYSTEM_PROMPT = `You are Ghost-Prime (enhanced with Jarvis Mark-LIII), an autonomous AI desktop assistant running locally on the user's Chrome OS / Crostini Linux machine. You act on their behalf with real tools — you do the work, you don't just advise on how to do it.

YOUR TOOLS — all loaded and directly callable this turn:
- terminal_run — run bash commands in Crostini. Use for build commands, scripts, git, and system utilities.
- browser_navigate / browser_get_text / browser_click / browser_fill / browser_screenshot / browser_read_pages — drive the user's REAL Chrome browser (via the Chrome extension bridge or Playwright).
- browser_list_tabs / browser_use_tab / browser_scroll / browser_press_key / browser_go_back / browser_go_forward / browser_reload — browser tab and navigation controls.
- file_read / file_write / file_edit / file_search / file_grep — inspect, create, edit, search, and grep local files.
- web_search / web_fetch — perform live web searches and fetch readable page text.
- memory_save / memory_recall — your long-term memory across sessions (backed by SQLite).
- system_volume — get or set volume percentage (0-100), mute, unmute, volume up/down via PulseAudio/pactl.
- system_brightness — inspect or adjust display screen brightness.
- system_power — battery status/health/percentage, screen lock, or suspend.
- system_telemetry — real-time hardware telemetry: CPU usage %, RAM usage, load averages, disk space, and battery.
- weather_get — live weather report and 3-day forecast for any city or current location.
- reminder_set / reminder_list / reminder_cancel — schedule desktop notifications with voice alerts.
- youtube_play — search and play YouTube videos directly in the browser.
- jarvis_action_run — execute any Python action or plugin from the Jarvis Mark-LIII collection.
- clipboard_read / clipboard_write / notify_user / screen_screenshot — clipboard, system notifications, and desktop screen captures.

DRIVING THE BROWSER:
- To click, prefer browser_click with { text: "Button Label" } for visible button/link text.
- After a click or fill, confirm your action with browser_get_text or browser_screenshot.
- To research across multiple pages, call browser_read_pages with URLs in parallel.

HOW TO WORK:
- Act directly and autonomously. Reversible actions proceed without asking.
- Ground every progress and success claim in an actual tool result.
- Be concise and clear: state the outcome first, then any details. Plain, natural language suitable for voice.`


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

async function streamChatGeminiAgent({ messages, signal, onDelta, onEvent, model, mode = 'auto', provider = 'gemini' }) {
  const cfg = getOpenAIConfig(provider)
  const openai = getClient(provider)
  const useModel = model || process.env[cfg.modelEnv] || process.env.GHOST_MODEL || cfg.defaultModel || 'gemini-2.5-flash'

  // Auto-inject the highest-signal memories so Gemini remembers across sessions
  const digest = memoryDigest(8)
  const memoryContext = digest.length
    ? '\n\nWhat you remember from earlier sessions:\n' +
      digest.map((m) => `- [${m.type}] ${m.content}`).join('\n')
    : ''

  // Auto page-context: when active-tab mode is on and user refers to the page
  let pageContext = ''
  if (browser.getActiveTabMode()) {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content || ''
    if (refersToCurrentPage(lastUser)) {
      try {
        const pc = await browser.getActiveTabContext()
        if (pc) {
          pageContext =
            `\n\n[Current browser tab the user is viewing]\nURL: ${pc.url}\nTitle: ${pc.title}\n\n${pc.text}\n[End of current tab]\n\n`
        }
      } catch {}
    }
  }

  const systemMessage = {
    role: 'system',
    content: `${SYSTEM_PROMPT}${memoryContext}${pageContext}\n\nCurrent Autonomy Mode: ${mode.toUpperCase()}. In PLAN mode, do not execute state-modifying actions — lay out an investigation plan first.`
  }

  const conversation = [
    systemMessage,
    ...messages.map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: String(m.content || '')
    }))
  ]

  let fullOutput = ''
  let turns = 0
  const MAX_TURNS = 15

  while (turns < MAX_TURNS) {
    turns++
    if (signal?.aborted) throw new Error('Request aborted')

    let res
    try {
      res = await openai.chat.completions.create(
        {
          model: useModel,
          messages: conversation,
          tools: toolSpecs,
          tool_choice: 'auto'
        },
        { signal }
      )
    } catch (apiErr) {
      if (apiErr?.message && /tools|function/i.test(apiErr.message) && turns === 1) {
        console.warn('[ghost-agent] Tools not supported by model, falling back to chat:', apiErr.message)
        return streamChatOpenAI({ messages, signal, onDelta, model, provider })
      }
      throw apiErr
    }

    const choice = res.choices?.[0]
    const assistantMsg = choice?.message
    if (!assistantMsg) break

    // Stream any assistant text content
    if (assistantMsg.content) {
      onDelta(assistantMsg.content)
      fullOutput += assistantMsg.content
    }

    const toolCalls = assistantMsg.tool_calls
    if (!toolCalls || toolCalls.length === 0) {
      break
    }

    conversation.push({
      role: 'assistant',
      content: assistantMsg.content || null,
      tool_calls: toolCalls
    })

    for (const call of toolCalls) {
      if (signal?.aborted) throw new Error('Request aborted')

      const callId = call.id || `call_${Date.now()}`
      const name = call.function.name
      let args = {}
      try {
        args = JSON.parse(call.function.arguments || '{}')
      } catch {
        args = {}
      }

      const readOnlyTools = [
        'file_read',
        'file_search',
        'file_grep',
        'browser_get_text',
        'browser_screenshot',
        'browser_list_tabs',
        'browser_read_pages',
        'memory_recall',
        'system_telemetry',
        'weather_get',
        'reminder_list',
        'clipboard_read',
        'web_search',
        'web_fetch'
      ]

      if (mode === 'plan' && !readOnlyTools.includes(name)) {
        const planMsg = `[PLAN MODE: Skipping execution of state-changing tool "${name}". Switch to AUTO or FULL mode with Shift+Tab to execute.]`
        onEvent?.({ kind: 'tool_use', id: callId, name, input: args })
        onEvent?.({ kind: 'tool_result', id: callId, output: planMsg, isError: true, durationMs: 1 })
        conversation.push({
          role: 'tool',
          tool_call_id: call.id,
          content: planMsg
        })
        continue
      }

      onEvent?.({ kind: 'tool_use', id: callId, name, input: args })

      const t0 = Date.now()
      let toolRes
      try {
        toolRes = await executeTool(name, args)
      } catch (err) {
        toolRes = { output: `Tool execution failed: ${err.message}`, isError: true }
      }
      const durationMs = Date.now() - t0

      onEvent?.({
        kind: 'tool_result',
        id: callId,
        output: toolRes.output?.slice(0, 8000) || '',
        image: toolRes.image,
        isError: !!toolRes.isError,
        durationMs
      })

      conversation.push({
        role: 'tool',
        tool_call_id: call.id,
        content: toolRes.output || 'Success'
      })
    }
  }

  return fullOutput
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
        'browser_go_back',
        "Go back to the previous page in the current tab's history (the browser Back button).",
        {},
        async () => {
          const r = await browser.browserGoBack()
          return { content: [{ type: 'text', text: `Went back — now at ${r.url} — "${r.title}"` }] }
        }
      ),
      tool(
        'browser_go_forward',
        "Go forward to the next page in the current tab's history (the browser Forward button).",
        {},
        async () => {
          const r = await browser.browserGoForward()
          return { content: [{ type: 'text', text: `Went forward — now at ${r.url} — "${r.title}"` }] }
        }
      ),
      tool(
        'browser_reload',
        'Reload / refresh the current page.',
        {},
        async () => {
          const r = await browser.browserReload()
          return { content: [{ type: 'text', text: `Reloaded — ${r.url} — "${r.title}"` }] }
        }
      ),
      tool(
        'browser_get_text',
        'Get the visible text of the current page (main document plus substantial iframes). Returns up ' +
          'to ~20k characters; if the page is longer, the result ends with a nextOffset — call again ' +
          'with { offset: <nextOffset> } to read the next chunk. Use to read page content before acting.',
        { offset: z.number().optional() },
        async ({ offset }) => {
          const r = await browser.browserGetText({ offset })
          const more =
            r.nextOffset != null
              ? `\n\n…(${r.totalChars - r.nextOffset} more characters — call browser_get_text with offset:${r.nextOffset} to continue)`
              : ''
          return { content: [{ type: 'text', text: `# ${r.title}\n${r.url}\n\n${r.text}${more}` }] }
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
        'Type a value into an input/textarea, OR choose an option in a native <select> dropdown ' +
          '(matched by the option\'s value or visible text). Pass { label, value } to target the ' +
          'field by its visible label/placeholder, or { selector, value } with a STANDARD CSS ' +
          'selector (#id, .class, [name="email"]). Never use jQuery selectors like :contains().',
        { selector: z.string().optional(), label: z.string().optional(), value: z.string() },
        async ({ selector, label, value }) => {
          await browser.browserFill({ selector, label, value })
          return { content: [{ type: 'text', text: `Filled ${label ? `field "${label}"` : selector}` }] }
        }
      ),
      tool(
        'browser_screenshot',
        'Capture a screenshot of the current browser page so you can see it. Defaults to the visible ' +
          'viewport; pass { fullPage: true } to capture the entire scrollable page in one image.',
        { fullPage: z.boolean().optional() },
        async ({ fullPage }) => {
          const r = await browser.browserScreenshot({ fullPage })
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
      ),
      tool(
        'browser_wait_for',
        'Wait until something appears on the current page before you act — use this whenever a page ' +
          'loads or changes content AFTER navigation: single-page apps, lazy/infinite lists, loading ' +
          'spinners, search results, post-login redirects. Pass { selector } (standard CSS) or ' +
          '{ text } (visible text to wait for); optional { timeoutMs } (default 10000, max 30000). ' +
          'Resolves as soon as it shows up, or errors on timeout. Far more reliable than clicking ' +
          'blind or taking repeated screenshots when you already know what you are waiting for.',
        { selector: z.string().optional(), text: z.string().optional(), timeoutMs: z.number().optional() },
        async ({ selector, text, timeoutMs }) => {
          await browser.browserWaitFor({ selector, text, timeoutMs })
          return { content: [{ type: 'text', text: `Found ${selector ? `selector ${selector}` : `"${text}"`}.` }] }
        }
      ),
      tool(
        'browser_press_key',
        'Send real keystrokes to whatever element has focus — the ONLY way to type into editors ' +
          'that have no fillable form field: Google Docs/Slides, Monaco/code editors, Notion, etc. ' +
          '(browser_fill only works on <input>/<textarea>.) First focus the editor (browser_click ' +
          'or browser_click_at on it), then call this. Pass { text: "…" } to type literal text, ' +
          'and/or { keys } to press special keys/shortcuts — one combo ("Enter") or an array ' +
          '(["Control+A", "Delete"]). Combos use +: Control/Alt/Shift/Meta plus a key, e.g. ' +
          '"Control+A" (select all), "Control+V" (paste), "Enter", "Tab", "ArrowDown", ' +
          '"Shift+ArrowRight". Note: browser-internal pages (chrome://) cannot be driven.',
        { text: z.string().optional(), keys: z.union([z.string(), z.array(z.string())]).optional() },
        async ({ text, keys }) => {
          await browser.browserPressKey({ text, keys })
          const did = [text != null && text !== '' ? 'typed text' : null, keys ? `pressed ${Array.isArray(keys) ? keys.join(', ') : keys}` : null]
            .filter(Boolean)
            .join('; ')
          return { content: [{ type: 'text', text: did || 'sent keystrokes' }] }
        }
      ),
      tool(
        'browser_list_tabs',
        'List every open browser tab — its tabId, window, URL, title, whether it is the active/focused ' +
          'tab, and whether it is playing audio (audible). Use this to SEE what the user has open and ' +
          'what is playing, to find the right tab when several windows are open, and to get a tabId to ' +
          'pin with browser_use_tab.',
        {},
        async () => {
          const r = await browser.browserListTabs()
          const tabs = r.tabs || []
          if (!tabs.length) return { content: [{ type: 'text', text: 'No open tabs found.' }] }
          const text = tabs
            .map(
              (t) =>
                `- tabId ${t.tabId} [win ${t.windowId}${t.focusedWindow ? '*' : ''}]${t.active ? ' (active)' : ''}` +
                `${t.audible ? ' 🔊' : ''}${t.muted ? ' (muted)' : ''} — ${t.title || '(no title)'} · ${t.url}`
            )
            .join('\n')
          return { content: [{ type: 'text', text: `${text}\n\n(* = focused window, 🔊 = playing audio)` }] }
        }
      ),
      tool(
        'browser_use_tab',
        'Pin which tab/window your browser actions act on, by tabId (from browser_list_tabs). This is ' +
          'how you choose between several open Chrome windows ("do this in window A"). Pass ' +
          '{ tabId: null } to unpin and go back to the default tab.',
        { tabId: z.number().nullable() },
        async ({ tabId }) => {
          const set = browser.setTargetTab(tabId)
          return { content: [{ type: 'text', text: set == null ? 'Unpinned — using the default tab.' : `Acting on tab ${set} now.` }] }
        }
      ),
      tool(
        'browser_list_browsers',
        'List the connected browsers/devices (separate Chrome/Brave windows or profiles, or a phone) ' +
          'that Ghost can drive, and which one is currently selected. Use when more than one browser ' +
          'is connected and you need to pick.',
        {},
        async () => {
          const list = browser.listBrowsers() || []
          if (!list.length) return { content: [{ type: 'text', text: 'No browsers connected.' }] }
          const text = list
            .map((d) => `- ${d.id} "${d.name}" (${d.kind})${d.selected ? ' — SELECTED' : ''}${d.connected ? '' : ' [offline]'}`)
            .join('\n')
          return { content: [{ type: 'text', text }] }
        }
      ),
      tool(
        'browser_use_browser',
        'Choose which connected browser/device to drive, by id (from browser_list_browsers). Use this ' +
          'to switch between two separate browsers/profiles.',
        { id: z.string() },
        async ({ id }) => {
          const ok = browser.useBrowser(id)
          return { content: [{ type: 'text', text: ok ? `Now driving ${id}.` : `No connected browser with id ${id}.` }] }
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
        'Save a durable fact, preference, or note to remember across sessions. Add { tags } to ' +
          'categorize it for later filtered recall (e.g. ["billing","acme"]). Add { ttl_days } for ' +
          'something only temporarily true (e.g. "is travelling this week" → ttl_days: 7) so it ' +
          'auto-forgets instead of lingering as stale fact.',
        {
          content: z.string(),
          type: z.enum(['fact', 'preference', 'task', 'event']).optional(),
          importance: z.number().min(1).max(10).optional(),
          tags: z.array(z.string()).optional(),
          ttl_days: z.number().positive().optional()
        },
        async ({ content, type, importance, tags, ttl_days }) => {
          const expiresAt = ttl_days ? Date.now() + ttl_days * 86_400_000 : null
          const id = saveMemory(content, type || 'fact', importance || 5, { tags, expiresAt })
          return { content: [{ type: 'text', text: id ? 'Saved to memory.' : 'Could not save memory.' }] }
        }
      ),
      tool(
        'memory_recall',
        'Search long-term memory for facts/preferences relevant to a query (omit query for the most ' +
          'important). Pass { tag } to restrict to memories carrying that tag. Expired memories are ' +
          'never returned.',
        { query: z.string().optional(), tag: z.string().optional() },
        async ({ query, tag }) => {
          const rows = recallMemories(query || '', 8, { tag })
          const text = rows.length
            ? rows
                .map((r) => `- [${r.type}${r.tags?.length ? ' · ' + r.tags.join(',') : ''}] ${r.content}`)
                .join('\n')
            : 'No memories stored yet.'
          return { content: [{ type: 'text', text }] }
        }
      )
    ]
  })
  return memoryMcpServer
}

// ---------------------------------------------------------------------------
// System MCP server — local-machine conveniences: clipboard + desktop notifications.
// ---------------------------------------------------------------------------
let systemMcpServer = null
async function getSystemMcpServer() {
  if (systemMcpServer) return systemMcpServer
  const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk')
  const { z } = await import('zod')

  systemMcpServer = createSdkMcpServer({
    name: SYSTEM_SERVER,
    version: '1.0.0',
    tools: [
      tool(
        'clipboard_read',
        "Read the user's current system clipboard (text). Use it instead of asking them to paste, " +
          'or to pick up something they just copied.',
        {},
        async () => {
          const text = clipboard.readText() || ''
          return { content: [{ type: 'text', text: text ? text : '(clipboard is empty)' }] }
        }
      ),
      tool(
        'clipboard_write',
        "Put text on the user's system clipboard so they can paste it anywhere.",
        { text: z.string() },
        async ({ text }) => {
          clipboard.writeText(String(text ?? ''))
          return { content: [{ type: 'text', text: 'Copied to clipboard.' }] }
        }
      ),
      tool(
        'notify_user',
        'Send the user a desktop notification — use it to get their attention when a long or ' +
          'background task finishes, or when you need them while they are away from the window. Pass ' +
          '{ title, body }.',
        { title: z.string().optional(), body: z.string() },
        async ({ title, body }) => {
          try {
            if (Notification.isSupported()) new Notification({ title: title || 'Ghost-Prime', body: String(body || '') }).show()
          } catch {}
          for (const w of BrowserWindow.getAllWindows()) {
            try {
              w.flashFrame(true) // bounce the taskbar entry for attention
            } catch {}
          }
          return { content: [{ type: 'text', text: 'Notified the user.' }] }
        }
      )
    ]
  })
  return systemMcpServer
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
// Shell MCP server — live, persistent, multi-session terminals (node-pty) the
// user can watch and type into. Replaces the built-in Bash tool.
// ---------------------------------------------------------------------------
let shellMcpServer = null
async function getShellMcpServer() {
  if (shellMcpServer) return shellMcpServer
  const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk')
  const { z } = await import('zod')

  shellMcpServer = createSdkMcpServer({
    name: SHELL_SERVER,
    version: '1.0.0',
    tools: [
      tool(
        'shell_run',
        'Run a command in a LIVE terminal the user can see (and type into). The terminal is ' +
          'PERSISTENT: working directory, environment variables, and background jobs survive between ' +
          'calls. By default it runs in your main terminal and waits for the command to finish, ' +
          'returning its output and exit code. Pass { terminal } (an id from shell_list) to target a ' +
          'specific terminal, or { background: true } for long-running/never-exiting processes (dev ' +
          'servers, watchers, tail -f) so it starts and returns immediately instead of blocking — then ' +
          'check its output later with shell_read. Prefer one focused command per call over giant ' +
          'chained one-liners so the live output stays readable.',
        { command: z.string(), terminal: z.string().optional(), background: z.boolean().optional() },
        async ({ command, terminal, background }) => {
          const r = await shell.runForAgent({ id: terminal, command, background: !!background })
          const head = r.background
            ? `[${r.name} · ${r.sessionId}] background — started`
            : `[${r.name} · ${r.sessionId}] exit ${r.exitCode ?? '?'}${r.timedOut ? ' (timed out)' : ''}`
          return { content: [{ type: 'text', text: `${head}\n${r.output || '(no output)'}` }] }
        }
      ),
      tool(
        'shell_open',
        'Open a NEW terminal and return its id. Use when you want a separate shell — e.g. one ' +
          'terminal dedicated to a running server and another for everyday commands. Optional ' +
          '{ name } to label it and { cwd } to start in a directory.',
        { name: z.string().optional(), cwd: z.string().optional() },
        async ({ name, cwd }) => {
          const r = await shell.createSession({ name, cwd, agent: true })
          return { content: [{ type: 'text', text: `Opened ${r.name} (${r.id}) in ${r.cwd}` }] }
        }
      ),
      tool(
        'shell_read',
        "Read a terminal's most recent output — use this to check on a background process (a dev " +
          "server's logs, a long build) WITHOUT running a new command. Pass { terminal } (its id).",
        { terminal: z.string(), maxBytes: z.number().optional() },
        async ({ terminal, maxBytes }) => {
          const r = shell.readSession({ id: terminal, maxBytes })
          if (r.error) return { content: [{ type: 'text', text: r.error }] }
          const tag = r.alive ? '' : ` (exited${r.lastExit != null ? ` code ${r.lastExit}` : ''})`
          return {
            content: [{ type: 'text', text: `[${r.name} · ${terminal}]${tag}\n${r.output || '(no output yet)'}` }]
          }
        }
      ),
      tool(
        'shell_list',
        'List all open terminals with their ids, names, and whether each is idle, running a command, ' +
          'or exited. Use it to see what you have running and pick one to target or close.',
        {},
        async () => {
          const rows = shell.listSessions()
          const stateOf = (s) =>
            s.alive ? (s.busy ? 'running a command' : 'idle') : `exited${s.lastExit != null ? ` (code ${s.lastExit})` : ''}`
          const text = rows.length
            ? rows.map((s) => `- ${s.id} "${s.name}" — ${stateOf(s)} · ${s.cwd}`).join('\n')
            : 'No terminals open yet — shell_run will open one automatically.'
          return { content: [{ type: 'text', text }] }
        }
      ),
      tool(
        'shell_kill',
        'Close a terminal and stop whatever is running in it. Pass { terminal } (its id). Clean up ' +
          'terminals you no longer need once a task is done — but leave ones the user still wants ' +
          'running (e.g. a server they asked you to start).',
        { terminal: z.string() },
        async ({ terminal }) => {
          const ok = shell.killSession(terminal)
          return { content: [{ type: 'text', text: ok ? `Closed terminal ${terminal}.` : `No terminal ${terminal}.` }] }
        }
      )
    ]
  })
  return shellMcpServer
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
  const shellServer = await getShellMcpServer()
  const systemServer = await getSystemMcpServer()
  const screenServer = SCREEN_ENABLED ? await getScreenMcpServer() : null

  // Auto-inject the highest-signal memories so Claude "remembers" without being asked.
  const digest = memoryDigest(8)
  const memoryContext = digest.length
    ? '\n\nWhat you remember from earlier sessions:\n' +
      digest.map((m) => `- [${m.type}] ${m.content}`).join('\n')
    : ''

  // Auto page-context: when "act on the tab I'm on" is enabled and the latest message refers to the
  // page, attach the current tab so "summarize this / what's here" works without a fetch first.
  let pageContext = ''
  if (browser.getActiveTabMode()) {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content || ''
    if (refersToCurrentPage(lastUser)) {
      try {
        const pc = await browser.getActiveTabContext()
        if (pc) {
          pageContext =
            `[Current browser tab the user is viewing — auto-attached because "act on the tab I'm on" is on. ` +
            `This is what they mean by "this page / here / this".]\n` +
            `URL: ${pc.url}\nTitle: ${pc.title}\n\n${pc.text}\n[End of current tab]\n\n---\n\n`
        }
      } catch {}
    }
  }

  const response = query({
    prompt: pageContext + transcript,
    options: {
      model: useModel,
      ...(supportsEffort && !thinkingOff ? { effort: effortVal } : {}), // 'low' = snappy (effort guides thinking)
      ...(thinkingOff ? { thinking: { type: 'disabled' } } : {}),
      systemPrompt:
        SYSTEM_PROMPT +
        memoryContext +
        (CANVA_ENABLED
          ? '\n\nCANVA: Canva tools (mcp__canva__*) are available — use them for Canva design/app tasks. The first call may require the user to authorize Canva.'
          : ''),
      includePartialMessages: true,
      allowedTools: [
        ...AGENT_TOOLS,
        ...SHELL_TOOL_NAMES,
        ...BROWSER_TOOL_NAMES,
        ...MEMORY_TOOL_NAMES,
        ...SYSTEM_TOOL_NAMES,
        ...(CANVA_ENABLED ? [`mcp__${CANVA_SERVER}`] : []), // allow all Canva tools
        ...(screenServer ? SCREEN_TOOL_NAMES : [])
      ],
      mcpServers: {
        [BROWSER_SERVER]: browserServer,
        [MEMORY_SERVER]: memoryServer,
        [SHELL_SERVER]: shellServer,
        [SYSTEM_SERVER]: systemServer,
        // External stdio server (the @canva/cli MCP). Tools are deferred behind tool-search by
        // default, so this adds little per-turn cost until the agent actually reaches for Canva.
        ...(CANVA_ENABLED
          ? { [CANVA_SERVER]: { type: 'stdio', command: 'npx', args: ['-y', '@canva/cli@latest', 'mcp'] } }
          : {}),
        ...(screenServer ? { [SCREEN_SERVER]: screenServer } : {})
      },
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
  // If provider is Gemini or OpenRouter, run our autonomous tool-capable agent!
  if (PROVIDER === 'gemini' || PROVIDER === 'openrouter') {
    return streamChatGeminiAgent({ ...opts, provider: PROVIDER })
  }

  // Default path: real Claude. Auto-fall back to Gemini Agent for this turn if Claude is
  // out of credits / rate-limited / unauthenticated.
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
    const reason = (err?.message || String(err)).split('\n')[0].slice(0, 160)
    console.warn(`[ghost] Claude unavailable → falling back to ${FALLBACK_PROVIDER} Agent: ${reason}`)
    opts.onDelta?.(
      `_⚡ Claude is unavailable right now (${reason}). Using the Gemini Agent brain with full tool capabilities._\n\n`
    )
    return await streamChatGeminiAgent({ ...opts, model: undefined, provider: FALLBACK_PROVIDER })
  }
}

// ---------------------------------------------------------------------------
// Session auto-summary: distill a finished chat into a few DURABLE, cross-session facts.
// Deliberately cheap — Haiku, no tools, no thinking, tiny output — and never throws (returns []
// on any failure) so it can't disrupt session switching or app quit. See memory/auto-summary.js.
// ---------------------------------------------------------------------------
const SUMMARY_SYSTEM = `You distill a chat between a user and the Ghost-Prime agent into DURABLE facts worth remembering in FUTURE, unrelated chats.

Keep ONLY things that stay true beyond this conversation:
- the user's stable preferences, identity, goals, constraints, or environment
- ongoing projects and their state/decisions
- settings or commitments the agent should honor later

DROP anything one-off: greetings, the specific task just done, transient context, and anything already listed under ALREADY KNOWN.

Output ONLY a JSON array of short, self-contained strings (max 6, each under 160 chars). If nothing is durable, output exactly [].`

function parseFacts(text) {
  if (!text) return []
  const m = String(text).match(/\[[\s\S]*\]/) // first JSON array in the reply
  if (!m) return []
  try {
    const arr = JSON.parse(m[0])
    return Array.isArray(arr) ? arr.map((x) => String(x).trim()).filter((s) => s && s.length <= 200).slice(0, 6) : []
  } catch {
    return []
  }
}

async function summarizeViaClaude(systemPrompt, prompt, signal) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  const abortController = new AbortController()
  if (signal) signal.aborted ? abortController.abort() : signal.addEventListener('abort', () => abortController.abort(), { once: true })
  const response = query({
    prompt,
    options: {
      model: 'haiku', // cheapest brain — summarizing is easy, keep the Pro allotment for real work
      systemPrompt,
      thinking: { type: 'disabled' },
      allowedTools: [],
      mcpServers: {},
      settingSources: [],
      strictMcpConfig: true,
      cwd: homedir(),
      abortController
    }
  })
  let out = ''
  for await (const msg of response) {
    if (msg.type === 'assistant') {
      for (const b of msg.message?.content || []) if (b?.type === 'text' && b.text) out += b.text
    } else if (msg.type === 'result' && msg.subtype === 'success' && !out && typeof msg.result === 'string') {
      out = msg.result
    }
  }
  return out
}

async function summarizeViaOpenAI(systemPrompt, prompt, signal, provider) {
  const cfg = getOpenAIConfig(provider)
  const openai = getClient(provider)
  const model = process.env[cfg.modelEnv] || process.env.GHOST_MODEL || cfg.defaultModel
  const res = await openai.chat.completions.create(
    { model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }], temperature: 0 },
    { signal }
  )
  return res.choices?.[0]?.message?.content || ''
}

// messages: [{role, content}]. known: facts already saved (won't be repeated). Returns string[].
export async function summarizeConversation(messages, { signal, known = [] } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return []
  const transcript = messages
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n')
    .slice(-12000) // the most recent ~12k chars is plenty to distill, and caps token cost
  const knownBlock = known.length ? `\n\nALREADY KNOWN (do not repeat):\n${known.map((k) => `- ${k}`).join('\n')}` : ''
  const prompt = `CHAT TRANSCRIPT:\n${transcript}${knownBlock}\n\nReturn the JSON array of durable facts.`
  try {
    let text = ''
    if (PROVIDER === 'claude-agent') {
      try {
        text = await summarizeViaClaude(SUMMARY_SYSTEM, prompt, signal)
      } catch (e) {
        if (isClaudeUnavailable(e) && fallbackReady()) text = await summarizeViaOpenAI(SUMMARY_SYSTEM, prompt, signal, FALLBACK_PROVIDER)
        else throw e
      }
    } else {
      text = await summarizeViaOpenAI(SUMMARY_SYSTEM, prompt, signal, PROVIDER)
    }
    return parseFacts(text)
  } catch (e) {
    if (process.env.GHOST_DEBUG) console.warn('[auto-summary] summarize failed:', e?.message || e)
    return []
  }
}

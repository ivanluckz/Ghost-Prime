import { homedir } from 'node:os'
import { clipboard, Notification, BrowserWindow } from 'electron'
import OpenAI from 'openai'
import * as browser from '../tools/browser.js'
import * as screen from '../tools/screen.js'
import * as shell from '../tools/shell-sessions.js'
import * as reminders from '../tools/reminders.js'
import * as fileUndo from '../tools/file-undo.js'
import { saveMemory, recallMemories, memoryDigest } from '../memory/db.js'
import { getToolSpecs, executeTool } from '../tools/index.js'

// Two chat brains, picked PER TURN by pickBrain() below:
//   gemini — Google AI Studio free tier (Gemini 2.5 Flash) with full tool calling (src/main/tools)
//   claude — Claude Agent SDK on the user's Claude Code login, with the in-process MCP servers below
// Chat selectors: GHOST_BRAIN_MODE=auto|gemini|claude, GHOST_CONTROL_BRAIN=claude|gemini, and the
// per-turn /brain override. GHOST_PROVIDER / GHOST_FALLBACK_PROVIDER (claude-agent | gemini |
// openrouter) only choose the model for background work — session auto-summaries and proactive
// check-ins (summarizeConversation / generateShort) — never a chat reply.
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

// Summary/proactive backend (default gemini — free). Read at call time so smoke scripts that set
// env after import, and the env.js load order in src/main/index.js, both work.
const summaryProvider = () => process.env.GHOST_PROVIDER || 'gemini'
const summaryFallback = () => process.env.GHOST_FALLBACK_PROVIDER || 'gemini'


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
  'browser_close_tab',
  'browser_wait_for',
  'browser_wait_for_navigation',
  'browser_get_page',
  'browser_get_text',
  'browser_click',
  'browser_fill',
  'browser_screenshot',
  'browser_read_pages',
  'browser_click_at',
  'browser_hover',
  'browser_find',
  'browser_drag',
  'browser_scroll',
  'browser_press_key',
  'browser_list_tabs',
  'browser_use_tab',
  'browser_list_browsers',
  'browser_use_browser'
].map((n) => `mcp__${BROWSER_SERVER}__${n}`)

// Our cross-session memory, exposed to the agent as an in-process SDK MCP server.
const MEMORY_SERVER = 'ghost-memory'
const MEMORY_TOOL_NAMES = ['memory_save', 'memory_recall'].map((n) => `mcp__${MEMORY_SERVER}__${n}`)

// Reversible file operations (moves/renames/creates/deletes/writes) + an undo stack.
const FILES_SERVER = 'ghost-files'
const FILES_TOOL_NAMES = ['file_write', 'file_create', 'file_move', 'file_delete', 'undo_last', 'undo_list'].map(
  (n) => `mcp__${FILES_SERVER}__${n}`
)

// Scheduled reminders (fired by the in-process scheduler in src/main/tools/reminders.js).
const REMINDER_SERVER = 'ghost-reminders'
const REMINDER_TOOL_NAMES = ['reminder_set', 'reminder_list', 'reminder_cancel'].map(
  (n) => `mcp__${REMINDER_SERVER}__${n}`
)

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

// The system prompt is assembled per brain: the two brains have DIFFERENT tool sets (Claude gets
// the SDK built-ins + our MCP servers; Gemini gets src/main/tools toolSpecs), so each is told only
// about tools it can actually call. Shared head/tail, per-brain tools section.
const SHARED_HEAD = `You are Ghost-Prime (enhanced with Jarvis Mark-LIII), an autonomous AI desktop assistant running locally on the user's Chrome OS / Crostini Linux machine. You act on their behalf with real tools — you do the work, you don't just advise on how to do it.

YOUR TOOLS — all already loaded and directly callable this turn. There is NO step to "load", "search for", "enable", or "initialize" a tool first; when a task needs one, just call it.`

// Claude brain: SDK built-ins + the in-process MCP servers registered in streamChatClaudeAgent.
function claudeToolsSection() {
  return `
- shell_run — run a command in a LIVE terminal the user can see and type into. shell_open / shell_list / shell_read / shell_kill — open extra terminals, list them, read a terminal's latest output, or close one.
- Read / Write / Edit / Glob / Grep — read and change local files.
- WebFetch / WebSearch — fetch a URL or search the web for current information.
- browser_navigate / browser_get_page / browser_get_text / browser_find / browser_click / browser_click_at / browser_hover / browser_fill / browser_screenshot / browser_read_pages / browser_drag — drive the browser (via the Chrome extension bridge or Playwright).
- browser_list_tabs / browser_use_tab / browser_close_tab / browser_scroll / browser_press_key / browser_wait_for / browser_wait_for_navigation / browser_go_back / browser_go_forward / browser_reload — browser tab and navigation controls. browser_list_browsers / browser_use_browser switch between separate connected browsers/profiles.
- memory_save / memory_recall — your long-term memory across sessions (supports tags + a ttl for temporary facts).
- file_write / file_create / file_move / file_delete — REVERSIBLE file changes. When the user might want to undo a change (moving/renaming/deleting/rewriting a file), prefer these over the plain Write tool so undo_last can restore it. undo_last / undo_list — take back the last such change, or show what's undoable. (Use the Edit tool for surgical in-place code edits.)
- reminder_set / reminder_list / reminder_cancel — schedule a desktop notification for later ("remind me at 5 to…"). Resolve vague times to an absolute time or minutes-from-now yourself.
- clipboard_read / clipboard_write / notify_user — clipboard and desktop notifications.${
    SCREEN_ENABLED
      ? '\n- screen_screenshot / screen_type / screen_key / screen_click / launch_app — see and drive native Linux apps beyond the browser.'
      : ''
  }
- You do NOT have the Jarvis one-shot tools on this brain (volume, brightness, battery/power, telemetry, weather, YouTube, Jarvis actions) — use shell_run (pactl, brightnessctl, upower…), WebSearch/WebFetch, or browser_navigate instead, or say so plainly.

TERMINALS (your shell):
- Run commands with shell_run. It runs in a real terminal the user is watching, and waits for the command to finish before returning its output + exit code. Terminals are PERSISTENT: a cd, an exported variable, or an activated venv carries over to your next shell_run in that terminal.
- You can keep SEVERAL terminals. Open a dedicated one with shell_open (e.g. one for a dev server, another for commands). Target a specific terminal by passing { terminal: "<id>" } (ids come from shell_list); omit it to use or auto-create your main one.
- For anything long-running or that never exits — dev servers, watchers, tail -f — call shell_run with { background: true } so it starts and returns immediately instead of hanging. Check on it later with shell_read, and shell_kill it when done.
- Tidy up after yourself: close terminals and stop processes you started once a task is finished, but LEAVE running anything the user still needs (like a server they asked you to start).`
}

// Gemini brain: derived from toolSpecs at call time so the list can't drift from what is
// actually registered (name + first sentence of each description).
function geminiToolsSection() {
  const firstSentence = (d) => String(d || '').split(/(?<=\.)\s+/)[0]
  const lines = getToolSpecs().map((t) => `- ${t.function.name} — ${firstSentence(t.function.description)}`)
  return `\n${lines.join('\n')}
- Undo: file_write / file_create / file_move / file_delete are REVERSIBLE — when the user might want to undo a change (moving/renaming/deleting/rewriting a file), use these so undo_last can restore it; undo_list shows what's undoable. Use file_edit for surgical in-place edits (file_edit is not undoable).`
}

const SHARED_TAIL = `

DRIVING THE BROWSER:
- Look first: browser_get_page numbers every visible button, link, field and dropdown as [N]. Act on them with browser_click { ref: N } / browser_fill { ref: N, value } — the most reliable way. { text } (visible label) and { selector } (standard CSS) also work.
- When layout matters or nothing is numbered where you need to click (canvas, maps, icon buttons), take browser_screenshot { annotate: true }: each element's [N] is drawn on the image — click by ref, or browser_click_at { x, y } (0..1 fractions of the image) for anything unnumbered. Ref numbering and annotate are fully supported on the Playwright backend; on the Chrome-extension backend, if a result says a ref is unknown or annotate is unsupported, fall back to browser_click { text } or browser_click_at { x, y } from a plain screenshot.
- Every action result tells you where you are now, whether the page changed ("page changed" → refs are stale, call browser_get_page again), and any dialog, download, or new tab it caused. Clicks already wait for the navigation they trigger — you do not need browser_wait_for_navigation after them.
- Content that appears later (spinners, search results, SPAs): browser_wait_for { text | selector } before acting. Hover menus: browser_hover first. Long pages: browser_find { text } jumps to a phrase; browser_scroll reveals more. (browser_hover / browser_find by ref are fully supported on the Playwright backend; on the extension backend prefer { text }.)
- Dropdowns / checkboxes: browser_fill with the option's visible text, or "true"/"false". Editors with no form field (Docs, Notion, code editors): click into them, then browser_press_key { text } / { keys }.
- Research across several pages: browser_read_pages with all the URLs at once.
- Confirm outcomes from actual results (URL, title, page text) — never assume a click worked.

HOW TO WORK:
- Act directly and autonomously. Reversible actions proceed without asking.
- Ground every progress and success claim in an actual tool result.
- Be concise and clear: state the outcome first, then any details. Plain, natural language suitable for voice.`

// brain: 'gemini' | 'claude'
export function buildSystemPrompt(brain) {
  return SHARED_HEAD + (brain === 'claude' ? claudeToolsSection() : geminiToolsSection()) + SHARED_TAIL
}


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
    content: `${buildSystemPrompt('gemini')}${memoryContext}${pageContext}\n\nCurrent Autonomy Mode: ${mode.toUpperCase()}. In PLAN mode, do not execute state-modifying actions — lay out an investigation plan first.`
  }

  const conversation = [
    systemMessage,
    ...messages.map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      // Pass rich content (array of text + image_url parts) straight through for vision; else a string.
      content: typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content : String(m.content || '')
    }))
  ]

  let fullOutput = ''
  let turns = 0
  const MAX_TURNS = 30 // browser tasks routinely take 15+ tool round-trips
  const imageTurns = new Set() // screenshot turns we injected (pruned to the newest few)
  let exhausted = false // we reached the text-only last round (the notice below blames the budget)
  let lastFinish = 'unknown' // finish_reason of the final completion, for the empty-reply notice

  while (turns < MAX_TURNS) {
    turns++
    if (signal?.aborted) throw new Error('Request aborted')

    // The last allowed round is text-only: otherwise its tools would run and their results could
    // never be read (no further model call), leaving the user with tool cards and no reply.
    const isLastTurn = turns >= MAX_TURNS
    if (isLastTurn) exhausted = true // whatever happens now, the budget is spent
    let res
    try {
      res = await openai.chat.completions.create(
        {
          model: useModel,
          messages: isLastTurn
            ? [...conversation, { role: 'system', content: 'Tool budget exhausted. Do not call tools. Summarise what you did, what succeeded/failed, and what remains.' }]
            : conversation,
          tools: getToolSpecs(),
          tool_choice: isLastTurn ? 'none' : 'auto'
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
    lastFinish = choice?.finish_reason || 'unknown'
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

    // Images a tool produced this round (browser_screenshot). Gemini's OpenAI-compatible endpoint
    // only accepts text in tool messages, so they go back as a user turn AFTER all the tool results
    // — that's what lets the model actually see the screenshot it asked for.
    const toolImages = []
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
        'browser_get_page',
        'browser_get_text',
        'browser_find',
        'browser_screenshot',
        'browser_list_tabs',
        'browser_list_browsers',
        'browser_wait_for',
        'browser_wait_for_navigation',
        'browser_read_pages',
        'undo_list',
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
        toolRes = await executeTool(name, args, { signal })
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
      if (toolRes.image) toolImages.push({ name, image: toolRes.image })
    }

    if (toolImages.length) {
      // Only the newest screenshots stay in context — each one costs image tokens on every later
      // request, and the old ones no longer show the current page anyway.
      const KEEP_IMAGES = 2
      const prior = conversation.filter((m) => imageTurns.has(m))
      for (const m of prior.slice(0, Math.max(0, prior.length + toolImages.length - KEEP_IMAGES))) {
        m.content = '[earlier screenshot removed — take a new one if you need to see the page]'
        imageTurns.delete(m)
      }
      for (const { name, image } of toolImages) {
        const turn = {
          role: 'user',
          content: [
            { type: 'text', text: `[Image result of ${name} — this is the screenshot you just took, not a new message from the user.]` },
            { type: 'image_url', image_url: { url: image } }
          ]
        }
        imageTurns.add(turn)
        conversation.push(turn)
      }
    }
  }

  // A Stop that lands after the final reply has already streamed must not throw the reply away
  // (ipc.js would skip saveMessage on the aborted path).
  if (signal?.aborted && !fullOutput.trim()) throw new Error('Request aborted')
  // Belt-and-braces: a provider that ignores tool_choice, or an empty final content, must not end
  // the turn silently (ipc.js skips persisting an empty reply; Discord shows "(no response)").
  // Only blame the tool budget when it really ran out — an empty first-turn reply (safety block,
  // finish_reason length, provider hiccup) gets a truthful notice instead.
  if (!fullOutput.trim()) {
    const notice = exhausted
      ? `*Stopped after ${MAX_TURNS} tool rounds without a final reply. Ask me to continue if the task is unfinished.*` // *…* — no _italic_ rule in the renderer
      : `*The model returned an empty reply (finish_reason: ${lastFinish}). Please try again.*`
    onDelta(notice)
    fullOutput += notice
  }

  return fullOutput
}

async function streamChatOpenAI({ messages, signal, onDelta, model, provider = summaryProvider() }) {
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
          const lead = r.partial ? 'Opened (still loading when the timeout hit)' : 'Navigated'
          return { content: [{ type: 'text', text: browser.formatActionResult(lead, { ...r, navigated: false }) }] }
        }
      ),
      tool(
        'browser_go_back',
        "Go back to the previous page in the current tab's history (the browser Back button).",
        {},
        async () => {
          const r = await browser.browserGoBack()
          return { content: [{ type: 'text', text: browser.formatActionResult('Went back', { ...r, navigated: false }) }] }
        }
      ),
      tool(
        'browser_go_forward',
        "Go forward to the next page in the current tab's history (the browser Forward button).",
        {},
        async () => {
          const r = await browser.browserGoForward()
          return { content: [{ type: 'text', text: browser.formatActionResult('Went forward', { ...r, navigated: false }) }] }
        }
      ),
      tool(
        'browser_reload',
        'Reload / refresh the current page.',
        {},
        async () => {
          const r = await browser.browserReload()
          return { content: [{ type: 'text', text: browser.formatActionResult('Reloaded', { ...r, navigated: false }) }] }
        }
      ),
      tool(
        'browser_get_page',
        'Get a structured snapshot of the current page: every visible button, link, input field and ' +
          'dropdown, each numbered [N], plus a short excerpt. Call this BEFORE browser_click or ' +
          'browser_fill, then act with { ref: N } — the most reliable way to hit exactly the right element ' +
          '(no ambiguous labels, no guessed selectors). Much faster than reading 20k chars of raw text.',
        { limit: z.number().optional() },
        async ({ limit }) => {
          const r = await browser.browserGetPage({ limit })
          return { content: [{ type: 'text', text: r.formatted || browser.formatPageSnapshot(r) }] }
        }
      ),
      tool(
        'browser_get_text',
        'Get the visible text of the current page (main document plus substantial iframes). Returns up ' +
          'to ~20k characters; if the page is longer, the result ends with a nextOffset — call again ' +
          'with { offset: <nextOffset> } to read the next chunk. Prefer browser_get_page when you need ' +
          'to interact; use this for reading long articles or full page content.',
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
        'browser_find',
        'Find a phrase on the current page (like Ctrl+F): returns how many times it occurs, a snippet ' +
          'of context around each hit, and scrolls the first one into view. Use it to locate a price, ' +
          'a name, a section — far cheaper than paging through browser_get_text.',
        { text: z.string(), limit: z.number().optional() },
        async ({ text, limit }) => {
          const r = await browser.browserFind({ text, limit })
          if (!r.count) return { content: [{ type: 'text', text: `"${text}" was not found on the page.` }] }
          const body =
            `${r.count} match${r.count === 1 ? '' : 'es'} for "${text}"${r.scrolled ? ' (scrolled the first one into view)' : ''}:\n` +
            r.matches.map((m, i) => `${i + 1}. ${m}`).join('\n')
          return { content: [{ type: 'text', text: body }] }
        }
      ),
      tool(
        'browser_click',
        'Click an element on the current page. BEST: pass { ref: N } — the number shown next to the ' +
          'element in browser_get_page or on an annotated screenshot — it is unambiguous. Otherwise ' +
          '{ text: "Log In" } clicks by visible button/link text, or { selector } with a STANDARD CSS ' +
          'selector: an id (#submit), class (.login-btn), or attribute ([aria-label="Log In"]); ' +
          ':nth-of-type() for position; or an xpath ("xpath=//button[normalize-space()=\'Log In\']"). ' +
          'Pass { double: true } to double-click; { button: "right" } for right-click/context menu. ' +
          'NEVER use jQuery selectors like :contains(), :visible, :eq() — invalid CSS, they fail. ' +
          'The result says whether the page changed (then refs are stale — call browser_get_page again) ' +
          'and reports any dialog, download, or new tab the click caused; the click already waits for ' +
          'the navigation it triggers.',
        {
          ref: z.number().optional(),
          selector: z.string().optional(),
          text: z.string().optional(),
          double: z.boolean().optional(),
          button: z.enum(['left', 'right', 'middle']).optional()
        },
        async ({ ref, selector, text, double, button }) => {
          const r = await browser.browserClick({ ref, selector, text, double, button })
          const what = ref != null ? `[${ref}]` : text ? `text "${text}"` : selector
          return { content: [{ type: 'text', text: browser.formatActionResult(`Clicked ${what}`, r) }] }
        }
      ),
      tool(
        'browser_fill',
        'Type a value into an input/textarea/editor, choose an option in a native <select> dropdown ' +
          "(by the option's visible text or value), or set a checkbox/radio (value \"true\"/\"false\"). " +
          'Target the field with { ref: N } from browser_get_page (preferred), { label } (its visible ' +
          'label/placeholder), or { selector } with STANDARD CSS (#id, .class, [name="email"]) — never ' +
          'jQuery :contains(). Add { pressEnter: true } to submit right after (search boxes, login forms).',
        {
          ref: z.number().optional(),
          selector: z.string().optional(),
          label: z.string().optional(),
          value: z.string(),
          pressEnter: z.boolean().optional()
        },
        async ({ ref, selector, label, value, pressEnter }) => {
          const r = await browser.browserFill({ ref, selector, label, value, pressEnter })
          const what = ref != null ? `[${ref}]` : label ? `field "${label}"` : selector
          return { content: [{ type: 'text', text: browser.formatActionResult(`Filled ${what}${pressEnter ? ' and pressed Enter' : ''}`, r) }] }
        }
      ),
      tool(
        'browser_screenshot',
        'Capture a screenshot of the current browser page so you can see it. Pass { annotate: true } ' +
          "to draw every clickable element's number [N] onto the image (and get a legend) — then act " +
          'with browser_click { ref: N }; this is the way to handle icon-only buttons, canvases and ' +
          'layouts where text labels are ambiguous. Defaults to the visible viewport; { fullPage: true } ' +
          'captures the entire scrollable page (not combinable with annotate).',
        { fullPage: z.boolean().optional(), annotate: z.boolean().optional() },
        async ({ fullPage, annotate }) => {
          const r = await browser.browserScreenshot({ fullPage, annotate })
          const content = [{ type: 'image', data: r.base64, mimeType: 'image/png' }]
          if (r.marks) content.push({ type: 'text', text: `Numbered elements: ${browser.formatMarks(r.marks)}` })
          if (typeof r.note === 'string' && r.note) content.push({ type: 'text', text: r.note }) // e.g. annotate unsupported on this backend
          return { content }
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
          return { content: [{ type: 'text', text: browser.formatActionResult(`Clicked at (${x}, ${y})`, r) }] }
        }
      ),
      tool(
        'browser_hover',
        'Hover an element — by { ref: N } from browser_get_page, { text } (visible label), or ' +
          '{ selector } (CSS). This opens hover-driven menus (nav dropdowns, row action icons, ' +
          'tooltips); call browser_get_page afterwards to see what appeared, then click it.',
        { ref: z.number().optional(), text: z.string().optional(), selector: z.string().optional() },
        async ({ ref, text, selector }) => {
          const r = await browser.browserHover({ ref, text, selector })
          const what = ref != null ? `[${ref}]` : text ? `"${text}"` : selector
          return { content: [{ type: 'text', text: browser.formatActionResult(`Hovering ${what}`, r) }] }
        }
      ),
      tool(
        'browser_drag',
        'Drag-and-drop on the page. Element mode: { fromSelector, toSelector } (standard CSS). Point ' +
          'mode: { from:{x,y}, to:{x,y} } as viewport fractions 0..1 — screenshot first, find the handle ' +
          'and target visually, then drag. For sliders, reordering, Kanban cards, drag-to-upload.',
        {
          fromSelector: z.string().optional(),
          toSelector: z.string().optional(),
          from: z.object({ x: z.number(), y: z.number() }).optional(),
          to: z.object({ x: z.number(), y: z.number() }).optional()
        },
        async ({ fromSelector, toSelector, from, to }) => {
          const r = await browser.browserDrag({ fromSelector, toSelector, from, to })
          return { content: [{ type: 'text', text: browser.formatActionResult(`Dragged (${r.mode})`, r) }] }
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
          const r = await browser.browserScroll({ direction, amount, selector })
          return { content: [{ type: 'text', text: `Scrolled ${direction || 'down'}${selector ? ` in ${selector}` : ''} (now at ${r.scrollY}px).` }] }
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
          const r = await browser.browserWaitFor({ selector, text, timeoutMs })
          return { content: [{ type: 'text', text: `Found ${selector ? `selector ${selector}` : `"${text}"`} — at ${r.url}.` }] }
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
          const r = await browser.browserPressKey({ text, keys })
          const did = [text != null && text !== '' ? 'Typed text' : null, keys ? `pressed ${Array.isArray(keys) ? keys.join(', ') : keys}` : null]
            .filter(Boolean)
            .join('; ')
          return { content: [{ type: 'text', text: browser.formatActionResult(did || 'Sent keystrokes', r) }] }
        }
      ),
      tool(
        'browser_wait_for_navigation',
        'Wait for a slow page load or redirect chain to finish. Clicks, Enter and navigate already ' +
          'wait for the navigation they trigger, so you rarely need this — reach for it when a result ' +
          'says the page is still loading. Pass { timeoutMs } (default 30000, max 60000).',
        { timeoutMs: z.number().optional() },
        async ({ timeoutMs }) => {
          const r = await browser.browserWaitForNavigation({ timeoutMs })
          return { content: [{ type: 'text', text: browser.formatActionResult(r.navigated ? 'Navigation complete' : 'No navigation happened', { ...r, navigated: false }) }] }
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
          const r = await browser.useTab(tabId)
          return { content: [{ type: 'text', text: r.pinned ? browser.formatActionResult(`Acting on tab ${r.tabId} now`, r) : 'Unpinned — using the default tab.' }] }
        }
      ),
      tool(
        'browser_close_tab',
        'Close the current browser tab (opens about:blank if it would close the last tab). Use this to clean up tabs you opened during a task.',
        {},
        async () => {
          const r = await browser.browserCloseTab()
          return { content: [{ type: 'text', text: browser.formatActionResult('Closed tab', r) }] }
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
// Files MCP server — reversible file ops + undo (src/main/tools/file-undo.js).
// ---------------------------------------------------------------------------
let filesMcpServer = null
async function getFilesMcpServer() {
  if (filesMcpServer) return filesMcpServer
  const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk')
  const { z } = await import('zod')
  const ok = (text) => ({ content: [{ type: 'text', text }] })
  const guard = (fn) => async (a) => {
    try {
      return ok(await fn(a))
    } catch (e) {
      return ok(`Error: ${e?.message || e}`)
    }
  }
  filesMcpServer = createSdkMcpServer({
    name: FILES_SERVER,
    version: '1.0.0',
    tools: [
      tool(
        'file_write',
        'Write/overwrite a file, REVERSIBLY — the previous version is snapshotted so "undo" restores ' +
          'it. Prefer this over the plain Write tool when the user might want to take the change back. ' +
          'Use the Edit tool for surgical in-place code edits; use this for whole-file writes.',
        { path: z.string(), content: z.string() },
        guard(({ path, content }) => fileUndo.writeFile(path, content))
      ),
      tool(
        'file_create',
        'Create a NEW file reversibly (errors if it already exists — use file_write to overwrite). ' +
          'Undo removes it.',
        { path: z.string(), content: z.string().optional() },
        guard(({ path, content }) => fileUndo.createFile(path, content || ''))
      ),
      tool(
        'file_move',
        'Move or rename a file reversibly. Undo puts it back where it was.',
        { from: z.string(), to: z.string() },
        guard(({ from, to }) => fileUndo.moveFile(from, to))
      ),
      tool(
        'file_delete',
        'Delete a file reversibly — it is snapshotted first, so undo restores it. Files only, not folders.',
        { path: z.string() },
        guard(({ path }) => fileUndo.deleteFile(path))
      ),
      tool(
        'undo_last',
        'Take back the most recent reversible file operation (write/create/move/delete). Use when the ' +
          'user says "undo that", "revert", "put it back", etc.',
        {},
        guard(() => fileUndo.undoLast())
      ),
      tool('undo_list', 'Show the stack of file operations that can still be undone (newest first).', {}, guard(() => fileUndo.undoList()))
    ]
  })
  return filesMcpServer
}

// ---------------------------------------------------------------------------
// Reminders MCP server — schedule notifications (src/main/tools/reminders.js).
// ---------------------------------------------------------------------------
let remindersMcpServer = null
async function getRemindersMcpServer() {
  if (remindersMcpServer) return remindersMcpServer
  const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk')
  const { z } = await import('zod')
  const fmt = (ms) => new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
  remindersMcpServer = createSdkMcpServer({
    name: REMINDER_SERVER,
    version: '1.0.0',
    tools: [
      tool(
        'reminder_set',
        'Schedule a reminder that will pop a desktop notification (and speak, if voice is on) at a ' +
          'time. Give EITHER an absolute `at` (ISO 8601, e.g. "2026-09-19T17:00:00") OR a relative ' +
          '`in_minutes`. Resolve vague times ("at 5", "in half an hour") yourself before calling.',
        { text: z.string(), at: z.string().optional(), in_minutes: z.number().positive().optional() },
        async ({ text, at, in_minutes }) => {
          try {
            const { dueAt } = reminders.setReminder({ text, at, inMinutes: in_minutes })
            return { content: [{ type: 'text', text: `Reminder set for ${fmt(dueAt)}: "${text}"` }] }
          } catch (e) {
            return { content: [{ type: 'text', text: `Could not set reminder: ${e?.message || e}` }] }
          }
        }
      ),
      tool('reminder_list', 'List all pending reminders with their ids and times.', {}, async () => {
        const list = reminders.listReminders()
        const text = list.length
          ? list.map((r) => `- ${fmt(r.dueAt)} — ${r.text}  (id: ${r.id})`).join('\n')
          : 'No pending reminders.'
        return { content: [{ type: 'text', text }] }
      }),
      tool(
        'reminder_cancel',
        'Cancel a pending reminder by its id (get ids from reminder_list).',
        { id: z.string() },
        async ({ id }) => ({
          content: [{ type: 'text', text: reminders.cancelReminderById(id) ? 'Reminder cancelled.' : 'No such reminder.' }]
        })
      )
    ]
  })
  return remindersMcpServer
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
  // Flatten any rich (image) content to text — the Agent SDK prompt is a string, so images dropped
  // into the chat are noted but not shown on the Claude brain (they DO work on the Gemini brain).
  const flat = (c) =>
    typeof c === 'string'
      ? c
      : Array.isArray(c)
        ? c.map((p) => (p?.type === 'text' ? p.text : p?.type === 'image_url' ? '[image attached]' : '')).filter(Boolean).join(' ')
        : String(c ?? '')
  const transcript = messages
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${flat(m.content)}`)
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
  const filesServer = await getFilesMcpServer()
  const remindersServer = await getRemindersMcpServer()
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
        buildSystemPrompt('claude') +
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
        ...FILES_TOOL_NAMES,
        ...REMINDER_TOOL_NAMES,
        ...(CANVA_ENABLED ? [`mcp__${CANVA_SERVER}`] : []), // allow all Canva tools
        ...(screenServer ? SCREEN_TOOL_NAMES : [])
      ],
      mcpServers: {
        [BROWSER_SERVER]: browserServer,
        [MEMORY_SERVER]: memoryServer,
        [SHELL_SERVER]: shellServer,
        [SYSTEM_SERVER]: systemServer,
        [FILES_SERVER]: filesServer,
        [REMINDER_SERVER]: remindersServer,
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
        // SDKResultError carries the reason in `errors: string[]` (no `result`); a success-with-
        // is_error carries a `result` string. Surface it so the user sees why and so
        // isClaudeUnavailable() can match not-logged-in / usage-limit text and fall over.
        const detail =
          (Array.isArray(msg.errors) && msg.errors.filter(Boolean).join('\n')) ||
          (typeof msg.result === 'string' && msg.result) ||
          ''
        throw new Error(detail ? `${detail} (${msg.subtype})` : `claude-agent failed (${msg.subtype})`)
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
  const cfg = OPENAI_PROVIDERS[summaryFallback()]
  return !!(cfg && process.env[cfg.apiKeyEnv])
}

// --- Brain router --------------------------------------------------------
// Pick per turn: Gemini (cheap/fast, and the only vision path today) vs Claude (hard/long/agentic
// reasoning, on the Pro login — no API bill). Zero-cost heuristic, overridable with /brain or
// GHOST_BRAIN_MODE. Applies to every entry point (chat UI and the Discord bot).
function contentHasImage(c) {
  return Array.isArray(c) && c.some((p) => p?.type === 'image_url')
}
function contentToPlain(c) {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((p) => (p?.type === 'text' ? p.text : '')).join(' ')
  return String(c ?? '')
}
// Signals that a turn deserves the stronger brain.
function isHardTask(text) {
  const t = String(text || '')
  if (t.length > 600) return true
  if (/```/.test(t)) return true
  if (/\[Attached file:/.test(t) && t.length > 300) return true
  return /\b(refactor|debug|implement|architect(?:ure)?|design|plan(?: out| this)?|multi-?step|step[- ]by[- ]step|analy[sz]e|optimi[sz]e|migrate|algorithm|derive|prove|reason (?:through|about)|think (?:through|hard|carefully|deeply)|write (?:a |the |some )?(?:code|function|script|module|class|test|program|app)|codebase|whole file|entire file|end[- ]to[- ]end|complex|thorough)\b/i.test(t)
}
// Computer control — driving the browser, running commands, changing files, opening apps — goes to
// Claude: it's the stronger agentic brain and its browser tools hand it screenshots natively. The
// Jarvis one-shot controls (volume, brightness, battery, weather, telemetry, YouTube, reminders,
// clipboard) exist only on the Gemini path, so those stay there. Set GHOST_CONTROL_BRAIN=gemini to
// keep everything on the free brain.
const controlBrain = () => (process.env.GHOST_CONTROL_BRAIN || 'claude').toLowerCase() // call-time: see summaryProvider() above
function isGeminiOnlyControl(t) {
  return /\b(volume|mute|unmute|louder|quieter|brightness|brighter|dimmer|battery|charg(?:e|ing)|weather|forecast|temperature|cpu|ram|memory usage|disk space|telemetry|system stats|remind(?:er|ers)?|youtube|play (?:a |the |some |me )?(?:song|video|music|track)|lock (?:the |my )?screen|suspend|clipboard|notify me)\b/i.test(
    t
  )
}
export function isComputerControl(text) {
  const t = String(text || '')
  if (!t.trim() || isGeminiOnlyControl(t)) return false
  // A URL or site name: the user wants something done on the web.
  if (/https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|org|net|io|de|co\.uk|edu|gov|app|dev)\b/i.test(t)) return true
  // Browser interaction verbs.
  if (/\b(click|tap|double[- ]?click|right[- ]?click|scroll|hover|drag|screenshot|screen ?shot)\b/i.test(t)) return true
  if (/\b(go to|navigate|visit|browse|open|load|pull up|bring up)\b[^.?!\n]{0,40}\b(site|website|web ?page|page|url|link|tab|browser|chrome|dashboard|portal)\b/i.test(t)) return true
  if (/\b(log|sign)[ -]?(in|out|up)\b/i.test(t)) return true
  if (/\b(fill|type|enter|paste|put)\b[^.?!\n]{0,40}\b(form|field|box|password|username|email|search bar|search box|text ?area|editor|doc|spreadsheet|sheet|cell)\b/i.test(t)) return true
  if (/\b(search|look (?:it |this |that )?up|find|check)\b[^.?!\n]{0,40}\b(on|in) (?:google|youtube|amazon|wikipedia|reddit|twitter|x|ebay|github|linkedin|maps|the (?:site|web|page|internet|store))\b/i.test(t)) return true
  if (/\b(download|upload|submit|book|order|buy|purchase|add to (?:my |the )?cart|check ?out|checkout|apply for|register for|unsubscribe|cancel my)\b/i.test(t)) return true
  if (/\b(post|send|reply|comment|message|dm|email|tweet|share)\b[^.?!\n]{0,40}\b(on|to|in|via) [a-z]/i.test(t)) return true
  if (/\b(read|summari[sz]e|what(?:'s| is) on|what does)\b[^.?!\n]{0,24}\b(this|the|that|my) (?:page|tab|site|screen|article|form)\b/i.test(t)) return true
  // Terminal / dev work.
  if (/\b(run|execute|launch|start|stop|kill|restart)\b[^.?!\n]{0,40}\b(command|script|test|tests|build|server|dev server|process|container|npm|node|python|bash|it|this|that)\b/i.test(t)) return true
  if (/\b(install|uninstall|compile|deploy|rebuild|git|npm|pnpm|yarn|pip|docker|sudo|apt|curl|ssh|bash|shell|terminal|command line|cli)\b/i.test(t)) return true
  // Files & folders.
  if (/\b(create|make|move|rename|delete|remove|copy|organi[sz]e|clean up|tidy|sort|edit|open|save|zip|unzip|extract)\b[^.?!\n]{0,40}\b(files?|folders?|director(?:y|ies)|downloads|desktop|documents|project|repo|\.[a-z]{2,4}\b)/i.test(t)) return true
  // Apps.
  if (/\b(launch|open|start|quit|close|switch to)\b[^.?!\n]{0,24}\b(app|application|program|window|terminal|discord|vs ?code|code editor|spotify|slack|zoom|calendar|settings)\b/i.test(t)) return true
  return false
}
// Returns 'gemini' | 'claude'. Order: explicit per-turn override → GHOST_BRAIN_MODE → heuristic.
export function pickBrain(opts = {}) {
  const ov = String(opts.brain || '').toLowerCase()
  if (ov === 'gemini' || ov === 'claude') return ov
  const mode = String(process.env.GHOST_BRAIN_MODE || 'auto').toLowerCase()
  if (mode === 'gemini' || mode === 'claude') return mode
  const lastUser = [...(opts.messages || [])].reverse().find((m) => m.role === 'user')
  const c = lastUser?.content
  if (contentHasImage(c)) return 'gemini' // a dropped image: only the Gemini path takes it as input
  const text = contentToPlain(c)
  if (isHardTask(text)) return 'claude'
  // Jarvis one-shots exist only on Gemini. Checked AFTER isHardTask so a coding ask that merely
  // mentions cpu/memory/battery/temperature ("refactor this so CPU usage stays flat") keeps the
  // stronger brain.
  if (isGeminiOnlyControl(text)) return 'gemini'
  if (controlBrain() === 'claude' && isComputerControl(text)) return 'claude'
  return 'gemini'
}

function runBrain(opts, brain) {
  if (brain === 'claude') return streamChatClaudeAgent(opts)
  // `model` is the Claude alias from /model (sonnet|opus|haiku), effort/thinking are Claude-only —
  // never send them to Gemini (it would 404 on model "opus").
  const { model, effort, thinking, ...rest } = opts
  return streamChatGeminiAgent({ ...rest, provider: 'gemini' })
}

export async function streamChat(opts) {
  const brain = pickBrain(opts)
  opts.onEvent?.({ kind: 'brain', brain }) // tell the UI which brain is answering
  let streamedAny = false
  let usedTools = false
  const onDelta = (t) => {
    streamedAny = true
    opts.onDelta?.(t)
  }
  const onEvent = (ev) => {
    if (ev?.kind === 'tool_use') usedTools = true
    opts.onEvent?.(ev)
  }
  try {
    return await runBrain({ ...opts, onDelta, onEvent }, brain)
  } catch (err) {
    // never double-answer, and never replay a turn whose tools already ran (side effects would repeat)
    if (opts.signal?.aborted || streamedAny || usedTools) throw err
    if (!isClaudeUnavailable(err)) throw err // only availability errors fall over to the other brain
    const other = brain === 'claude' ? 'gemini' : 'claude'
    const reason = (err?.message || String(err)).split('\n')[0].slice(0, 160)
    console.warn(`[ghost] ${brain} unavailable → ${other}: ${reason}`)
    opts.onEvent?.({ kind: 'brain', brain: other, fallback: true })
    opts.onDelta?.(`*⚡ ${brain} was unavailable (${reason}). Using ${other} for this reply.*\n\n`) // *…* — the renderer has no _italic_ rule
    return await runBrain({ ...opts, onDelta, onEvent }, other)
  }
}

// ---------------------------------------------------------------------------
// Session auto-summary: distill a finished chat into a few DURABLE, cross-session facts.
// Deliberately cheap — Haiku, no tools, no thinking, tiny output — and never throws (returns null
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

// messages: [{role, content}]. known: facts already saved (won't be repeated). Returns string[],
// or null when the model call failed / came back blank (so the caller can retry later).
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
    if (summaryProvider() === 'claude-agent') {
      try {
        text = await summarizeViaClaude(SUMMARY_SYSTEM, prompt, signal)
      } catch (e) {
        if (isClaudeUnavailable(e) && fallbackReady()) text = await summarizeViaOpenAI(SUMMARY_SYSTEM, prompt, signal, summaryFallback())
        else throw e
      }
    } else {
      text = await summarizeViaOpenAI(SUMMARY_SYSTEM, prompt, signal, summaryProvider())
    }
    if (!String(text || '').trim()) return null // blank/aborted reply: "didn't get an answer", not "nothing durable"
    return parseFacts(text)
  } catch (e) {
    if (process.env.GHOST_DEBUG) console.warn('[auto-summary] summarize failed:', e?.message || e)
    return null // null = call failed (caller retries next time); [] = model genuinely found nothing durable
  }
}

// A cheap one-shot generation (Haiku, no tools) used by the proactive engine for briefings and
// check-ins. Never throws — returns '' on any failure so background timers can't crash.
export async function generateShort(systemPrompt, prompt) {
  try {
    if (summaryProvider() === 'claude-agent') {
      try {
        return (await summarizeViaClaude(systemPrompt, prompt)).trim()
      } catch (e) {
        if (isClaudeUnavailable(e) && fallbackReady()) return (await summarizeViaOpenAI(systemPrompt, prompt, undefined, summaryFallback())).trim()
        throw e
      }
    }
    return (await summarizeViaOpenAI(systemPrompt, prompt, undefined, summaryProvider())).trim()
  } catch (e) {
    if (process.env.GHOST_DEBUG) console.warn('[proactive] generate failed:', e?.message || e)
    return ''
  }
}

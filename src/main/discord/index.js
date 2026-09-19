import { streamChat } from '../agent/provider.js'

// Discord relay for Ghost-Prime. Runs INSIDE the Electron main process, so the bot is online only
// while Ghost-Prime is running — message it from Discord and it talks to the same agent (tools and
// all). discord.js is heavy + ESM-ish, so it's loaded lazily and the whole thing is a no-op unless
// DISCORD_BOT_TOKEN is set.
//
// What it does:
//   • Streams the reply LIVE — you watch the message fill in, with a status line ("🌐 browsing…",
//     "⌨️ running a command…") while the agent works.
//   • Reads text attachments (.txt/.md/code/logs/JSON…) so you can drop a long file instead of pasting.
//   • Sends very long answers back as a single .txt attachment instead of a wall of chunks.
//   • Control commands: !help · !reset · !stop · !mode · !status.
//   • In servers it answers in the configured channel OR whenever you @mention it.
//
// SAFETY: this agent can run shell + drive the browser, so the bot ONLY obeys user IDs on
// DISCORD_ALLOWED_USER_IDS. With no allowlist it logs in but refuses every message.

let client = null
let AttachmentBuilder = null // captured from discord.js on startup, used for long-reply .txt files
const histories = new Map() // channelId -> [{role, content}]
const chains = new Map() // channelId -> Promise (serialize agent runs per channel)
const running = new Map() // channelId -> AbortController (in-flight run, so !stop can cancel it)
const modes = new Map() // channelId -> 'plan' | 'auto' | 'full' (per-channel autonomy override)
const brains = new Map() // channelId -> 'auto' | 'gemini' | 'claude' (per-channel brain override)

const MAX_HISTORY = 20 // messages kept per channel for context
const DISCORD_LIMIT = 1900 // stay under Discord's 2000-char message cap
// Past this many chars (~2 messages) a reply goes out as a .txt attachment instead of many chunks.
const FILE_THRESHOLD = DISCORD_LIMIT * 2
const ATTACH_MAX_BYTES = 256 * 1024 // cap per inbound text attachment we'll read (256 KB)
const EDIT_INTERVAL = 1100 // ms between live message edits — keeps us clear of Discord's edit rate limit
// File extensions / mime prefixes we treat as readable text. Catches the obvious code/doc types so
// someone can drop a long file on the message instead of pasting it.
const TEXT_EXTS =
  /\.(txt|md|markdown|log|json|ya?ml|csv|tsv|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|cc|hpp|sh|bash|zsh|sql|toml|ini|cfg|conf|env|diff|patch|gradle|properties)$/i

const DEFAULT_MODE = () => process.env.DISCORD_MODE || 'auto' // plan | auto | full

const HELP = [
  '**Ghost-Prime — Discord control**',
  'Just message me and I act on your machine — browse the web, run shell commands, edit files, remember things. Attach a text file (`.txt`, `.md`, code, logs, JSON…) and I’ll read it.',
  '',
  '**Commands**',
  '`!help` — this message',
  '`!reset` — forget this conversation’s history',
  '`!stop` — cancel what I’m doing right now',
  '`!mode [plan|auto|full]` — show or set autonomy (`full` skips permission checks — careful)',
  '`!brain [auto|gemini|claude]` — which brain answers (auto routes by task)',
  '`!status` — show brain, mode, and history size'
].join('\n')

const COMMANDS = new Set(['help', 'commands', 'reset', 'clear', 'stop', 'cancel', 'mode', 'brain', 'status', 'ping'])

function allowedIds() {
  return (process.env.DISCORD_ALLOWED_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}
const isAllowed = (userId) => allowedIds().includes(String(userId))

// A friendly verb + emoji for the status line, derived from the tool the agent just called.
function activityFor(name) {
  const n = String(name || '')
  if (/browser_/.test(n) || /ghost-browser/.test(n)) return ['🌐', 'browsing']
  if (/shell_/.test(n)) return ['⌨️', 'running a command']
  if (/memory_/.test(n)) return ['🧠', 'checking memory']
  if (/canva/i.test(n)) return ['🎨', 'working in Canva']
  if (/web(fetch|search)/i.test(n)) return ['🔎', 'searching the web']
  if (/^(Read|Write|Edit|Glob|Grep)$/.test(n)) return ['📁', 'working with files']
  if (/clipboard/.test(n)) return ['📋', 'using the clipboard']
  if (/notify/.test(n)) return ['🔔', 'getting your attention']
  if (/screen_|launch_app/.test(n)) return ['🖥️', 'controlling the desktop']
  return ['⚙️', 'working']
}
const statusLine = ([emoji, verb]) => `${emoji} _${verb}…_`

// Split a long reply into Discord-sized chunks, preferring to break on newlines.
function chunk(text, size = DISCORD_LIMIT) {
  const out = []
  let buf = ''
  for (const line of String(text).split('\n')) {
    if (line.length > size) {
      if (buf) {
        out.push(buf)
        buf = ''
      }
      for (let i = 0; i < line.length; i += size) out.push(line.slice(i, i + size))
      continue
    }
    if (buf.length + line.length + 1 > size) {
      out.push(buf)
      buf = ''
    }
    buf += (buf ? '\n' : '') + line
  }
  if (buf) out.push(buf)
  return out.length ? out : ['(no response)']
}

// Keep ``` code fences balanced across a chunk boundary: close an open fence at the end of a part
// and reopen it (same language) at the start of the next, so neither message shows a broken fence.
function balanceFences(parts) {
  const out = []
  let carryLang = null // non-null => we're inside an unclosed fence opened in a previous part
  for (const raw of parts) {
    let s = carryLang !== null ? '```' + carryLang + '\n' + raw : raw
    let open = false
    let lang = ''
    for (const f of s.match(/```[^\n`]*/g) || []) {
      if (!open) {
        open = true
        lang = f.slice(3).trim()
      } else {
        open = false
      }
    }
    if (open) {
      s += '\n```'
      carryLang = lang
    } else {
      carryLang = null
    }
    out.push(s)
  }
  return out
}

const looksTextual = (att) =>
  (att.contentType && /^text\//i.test(att.contentType)) ||
  /\b(json|xml|yaml|javascript|x-sh|csv)\b/i.test(att.contentType || '') ||
  TEXT_EXTS.test(att.name || '')

// Download any text-like attachments on a message and return them as labelled blocks to feed the
// agent. Lets a user drop a long file ("see attached") instead of pasting it into the message.
async function readTextAttachments(msg) {
  const atts = msg.attachments ? [...msg.attachments.values()] : []
  const blocks = []
  for (const att of atts) {
    if (!looksTextual(att)) continue
    if (att.size && att.size > ATTACH_MAX_BYTES) {
      blocks.push(`[attachment ${att.name} skipped — ${Math.round(att.size / 1024)} KB exceeds the ${ATTACH_MAX_BYTES / 1024} KB limit]`)
      continue
    }
    try {
      const res = await fetch(att.url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      let text = await res.text()
      if (text.length > ATTACH_MAX_BYTES) text = text.slice(0, ATTACH_MAX_BYTES) + '\n…[truncated]'
      blocks.push(`--- attached file: ${att.name || 'file'} ---\n${text}`)
    } catch (e) {
      blocks.push(`[failed to read attachment ${att.name}: ${e?.message || e}]`)
    }
  }
  return blocks
}

export async function startDiscord() {
  const token = process.env.DISCORD_BOT_TOKEN
  if (!token) return // not configured — silent no-op

  let discord
  try {
    discord = await import('discord.js')
  } catch (e) {
    console.warn('[discord] discord.js not available:', e?.message || e)
    return
  }
  const { Client, GatewayIntentBits, Partials, ActivityType } = discord
  AttachmentBuilder = discord.AttachmentBuilder

  if (!allowedIds().length) {
    console.warn('[discord] DISCORD_BOT_TOKEN is set but DISCORD_ALLOWED_USER_IDS is empty — the bot will refuse every message until you add your Discord user id.')
  }

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent // privileged — enable "Message Content Intent" in the Discord dev portal
    ],
    partials: [Partials.Channel, Partials.Message] // needed to receive DMs
  })

  client.once('ready', () => {
    console.log(`[discord] online as ${client.user?.tag}`)
    try {
      client.user.setActivity('Ghost-Prime', { type: ActivityType.Listening })
    } catch {}
  })
  client.on('error', (e) => console.error('[discord] client error:', e?.message || e))
  client.on('messageCreate', (msg) => handleMessage(msg).catch((e) => console.error('[discord]', e?.message || e)))

  try {
    await client.login(token)
  } catch (e) {
    console.error('[discord] login failed:', e?.message || e)
    client = null
  }
}

export function stopDiscord() {
  try {
    client?.destroy()
  } catch {}
  for (const ac of running.values()) {
    try {
      ac.abort()
    } catch {}
  }
  running.clear()
  client = null
}

// Handle the !commands. Returns true if the message WAS a command (and was handled), so the caller
// stops. Run OUTSIDE the per-channel chain so !stop works while a run is in flight.
function handleCommand(msg, typed) {
  if (!typed.startsWith('!')) return false
  const [word, ...rest] = typed.slice(1).split(/\s+/)
  const cmd = word.toLowerCase()
  if (!COMMANDS.has(cmd)) return false // unknown !thing — treat as a normal prompt
  const arg = rest.join(' ').trim()
  const channelId = msg.channelId

  if (cmd === 'help' || cmd === 'commands') {
    msg.reply(HELP).catch(() => {})
  } else if (cmd === 'reset' || cmd === 'clear') {
    histories.delete(channelId)
    msg.reply('🧹 Cleared this conversation’s history.').catch(() => {})
  } else if (cmd === 'stop' || cmd === 'cancel') {
    const ac = running.get(channelId)
    if (ac) {
      ac.abort()
      msg.reply('🛑 Stopping…').catch(() => {})
    } else {
      msg.reply('Nothing is running right now.').catch(() => {})
    }
  } else if (cmd === 'mode') {
    if (!arg) {
      msg.reply(`Mode is **${modes.get(channelId) || DEFAULT_MODE()}**. Set it with \`!mode plan|auto|full\`.`).catch(() => {})
    } else if (!['plan', 'auto', 'full'].includes(arg.toLowerCase())) {
      msg.reply('Mode must be `plan`, `auto`, or `full`.').catch(() => {})
    } else {
      const m = arg.toLowerCase()
      modes.set(channelId, m)
      msg.reply(`Mode set to **${m}**.${m === 'full' ? ' ⚠️ I’ll skip permission checks in this channel.' : ''}`).catch(() => {})
    }
  } else if (cmd === 'brain') {
    if (!arg) {
      msg.reply(`Brain is **${brains.get(channelId) || 'auto'}**. Set it with \`!brain auto|gemini|claude\` (auto routes cheap asks to Gemini, hard ones to Claude).`).catch(() => {})
    } else if (!['auto', 'gemini', 'claude'].includes(arg.toLowerCase())) {
      msg.reply('Brain must be `auto`, `gemini`, or `claude`.').catch(() => {})
    } else {
      brains.set(channelId, arg.toLowerCase())
      msg.reply(`Brain set to **${arg.toLowerCase()}**.`).catch(() => {})
    }
  } else if (cmd === 'status' || cmd === 'ping') {
    const m = modes.get(channelId) || DEFAULT_MODE()
    const h = histories.get(channelId)?.length || 0
    const brain = brains.get(channelId) || 'auto'
    msg
      .reply(`🟢 Online · brain: \`${brain}\` · mode: **${m}** · history: ${h} msg${h === 1 ? '' : 's'}${running.has(channelId) ? ' · (working…)' : ''}`)
      .catch(() => {})
  }
  return true
}

async function handleMessage(msg) {
  if (!client || msg.author?.bot) return
  const isDM = !msg.guild
  const mentioned = !!(msg.guild && client.user && msg.mentions?.users?.has(client.user.id))
  const inConfiguredChannel = process.env.DISCORD_CHANNEL_ID && msg.channelId === process.env.DISCORD_CHANNEL_ID
  // In a server: only act in the configured channel or when explicitly @mentioned. Never react
  // across whole servers. DMs are always fair game.
  if (!isDM && !inConfiguredChannel && !mentioned) return

  if (!isAllowed(msg.author?.id)) {
    msg.reply("You're not authorized to control Ghost-Prime.").catch(() => {})
    return
  }

  // Strip a leading/inline @Ghost mention so the agent sees a clean prompt.
  let typed = (msg.content || '').replace(/<@!?(\d+)>/g, (m, id) => (client.user && id === client.user.id ? '' : m)).trim()

  // Commands run immediately (not queued behind a running agent) so !stop can interrupt.
  if (handleCommand(msg, typed)) return

  const fileBlocks = await readTextAttachments(msg)
  if (!typed && !fileBlocks.length) {
    // No text and nothing readable attached — almost always the Message Content Intent is off, OR
    // they attached only non-text files (images/binaries) we can't read.
    const onlyAttachments = msg.attachments?.size > 0
    msg
      .reply(
        onlyAttachments
          ? "I can only read text-based attachments (`.txt`, `.md`, code, logs, JSON, etc.) — that file looks binary."
          : "I can't read message content. Enable the **Message Content Intent** in the Discord Developer Portal → your app → Bot."
      )
      .catch(() => {})
    return
  }

  // Fold any attached files into the prompt so the agent sees them as part of the message.
  const content = [typed, ...fileBlocks].filter(Boolean).join('\n\n')

  // Serialize per channel so concurrent messages don't interleave their agent runs.
  const prev = chains.get(msg.channelId) || Promise.resolve()
  const next = prev.then(() => respond(msg, content)).catch((e) => console.error('[discord]', e?.message || e))
  chains.set(msg.channelId, next)
}

async function respond(msg, content) {
  const channelId = msg.channelId
  const history = histories.get(channelId) || []
  const messages = [...history, { role: 'user', content }]
  const mode = modes.get(channelId) || DEFAULT_MODE()

  // A live placeholder we edit as the agent thinks → acts → types its answer.
  msg.channel.sendTyping().catch(() => {})
  let placeholder = null
  try {
    placeholder = await msg.channel.send(statusLine(['🧠', 'thinking']))
  } catch {}

  const ac = new AbortController()
  running.set(channelId, ac)

  // Throttled live editor: re-render at most once per EDIT_INTERVAL.
  let liveText = ''
  let activity = ['🧠', 'thinking']
  let closing = false
  let timer = null
  let lastRendered = ''
  let lastEditAt = 0
  const render = () => {
    if (liveText) {
      const cap = DISCORD_LIMIT - 50
      const head = liveText.length > cap ? liveText.slice(0, cap) + '…' : liveText
      return head + (closing ? '' : ' ▌')
    }
    return statusLine(activity)
  }
  const pump = () => {
    if (closing || timer || !placeholder) return
    const wait = Math.max(0, EDIT_INTERVAL - (Date.now() - lastEditAt))
    timer = setTimeout(async () => {
      timer = null
      const text = render()
      if (text && text !== lastRendered) {
        lastRendered = text
        lastEditAt = Date.now()
        try {
          await placeholder.edit(text)
        } catch {}
      }
    }, wait)
  }

  let reply
  try {
    reply = await streamChat({
      messages,
      mode, // plan | auto | full (full = no permission checks — careful)
      brain: brains.get(channelId) || 'auto', // per-channel router override (!brain)
      signal: ac.signal,
      onDelta: (t) => {
        liveText += t
        pump()
      },
      onEvent: (ev) => {
        if (ev?.kind === 'tool_use') {
          activity = activityFor(ev.name)
          if (!liveText) pump() // only drive the status line until real text starts streaming
        }
      }
    })
  } catch (e) {
    if (ac.signal.aborted) {
      reply = (liveText.trim() ? liveText.trim() + '\n\n' : '') + '🛑 _Stopped._'
    } else {
      reply = `⚠️ ${e?.message || e}`
    }
  } finally {
    running.delete(channelId)
    closing = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
  reply = (reply ?? '').trim() || '(no response)'

  history.push({ role: 'user', content }, { role: 'assistant', content: reply })
  while (history.length > MAX_HISTORY) history.shift()
  histories.set(channelId, history)

  await deliver(msg.channel, placeholder, reply)
}

// Land the final reply: edit the live placeholder into the answer. Long answers go out as a single
// .txt attachment (a preview line + the file) instead of many chunked messages.
async function deliver(channel, placeholder, reply) {
  if (reply.length > FILE_THRESHOLD && AttachmentBuilder) {
    try {
      const file = new AttachmentBuilder(Buffer.from(reply, 'utf8'), { name: 'ghost-reply.txt' })
      const preview = reply.slice(0, 240).replace(/\s+/g, ' ').trim()
      const payload = { content: `📄 Long answer (${reply.length} chars) — full text attached.\n> ${preview}…`, files: [file] }
      if (placeholder) await placeholder.edit(payload).catch(() => channel.send(payload).catch(() => {}))
      else await channel.send(payload).catch(() => {})
      return
    } catch (e) {
      console.warn('[discord] file reply failed, falling back to chunks:', e?.message || e)
    }
  }

  const parts = balanceFences(chunk(reply))
  if (placeholder) await placeholder.edit(parts[0]).catch(() => channel.send(parts[0]).catch(() => {}))
  else await channel.send(parts[0]).catch(() => {})
  for (let i = 1; i < parts.length; i++) await channel.send(parts[i]).catch(() => {})
}

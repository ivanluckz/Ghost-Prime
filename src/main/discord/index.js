import { streamChat } from '../agent/provider.js'

// Discord relay for Ghost-Prime. Runs INSIDE the Electron main process, so the bot is online only
// while Ghost-Prime is running — message it from Discord and it talks to the same agent (tools and
// all). discord.js is ESM-only-ish + heavy, so it's loaded lazily and the whole thing is a no-op
// unless DISCORD_BOT_TOKEN is set.
//
// SAFETY: this agent can run shell + drive the browser, so the bot ONLY obeys user IDs on
// DISCORD_ALLOWED_USER_IDS. With no allowlist it logs in but refuses every message.

let client = null
let AttachmentBuilder = null // captured from discord.js on startup, used for long-reply .txt files
const histories = new Map() // channelId -> [{role, content}]
const chains = new Map() // channelId -> Promise (serialize requests per channel)

const MAX_HISTORY = 20 // messages kept per channel for context
const DISCORD_LIMIT = 1900 // stay under Discord's 2000-char message cap
// Past this many chars (~2 messages) a reply goes out as a .txt attachment instead of many chunks.
const FILE_THRESHOLD = DISCORD_LIMIT * 2
const ATTACH_MAX_BYTES = 256 * 1024 // cap per inbound text attachment we'll read (256 KB)
// File extensions / mime prefixes we treat as readable text. Catches the obvious code/doc types so
// someone can drop a long file on the message instead of pasting it.
const TEXT_EXTS =
  /\.(txt|md|markdown|log|json|ya?ml|csv|tsv|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|cc|hpp|sh|bash|zsh|sql|toml|ini|cfg|conf|env|diff|patch|gradle|properties)$/i

function allowedIds() {
  return (process.env.DISCORD_ALLOWED_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}
const isAllowed = (userId) => allowedIds().includes(String(userId))

// Split a long reply into Discord-sized chunks, preferring to break on newlines / code fences.
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
  client = null
}

async function handleMessage(msg) {
  if (!client || msg.author?.bot) return
  const isDM = !msg.guild
  const inConfiguredChannel = process.env.DISCORD_CHANNEL_ID && msg.channelId === process.env.DISCORD_CHANNEL_ID
  // Only act in DMs or the one configured channel — never react across whole servers.
  if (!isDM && !inConfiguredChannel) return

  if (!isAllowed(msg.author?.id)) {
    msg.reply("You're not authorized to control Ghost-Prime.").catch(() => {})
    return
  }

  const typed = msg.content?.trim() || ''
  const fileBlocks = await readTextAttachments(msg)
  const hasFiles = fileBlocks.length > 0

  if (!typed && !hasFiles) {
    // No text and nothing readable attached — almost always the Message Content Intent is off, OR
    // they attached only non-text files (images/binaries) we can't read.
    const onlyAttachments = msg.attachments?.size > 0
    msg.reply(
      onlyAttachments
        ? "I can only read text-based attachments (`.txt`, `.md`, code, logs, JSON, etc.) — that file looks binary."
        : "I can't read message content. Enable the **Message Content Intent** in the Discord Developer Portal → your app → Bot."
    ).catch(() => {})
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

  msg.channel.sendTyping().catch(() => {})
  const typing = setInterval(() => msg.channel.sendTyping().catch(() => {}), 8000)

  let reply
  try {
    reply = await streamChat({
      messages,
      mode: process.env.DISCORD_MODE || 'auto' // plan | auto | full (full = no permission checks — careful)
    })
  } catch (e) {
    reply = `⚠️ ${e?.message || e}`
  } finally {
    clearInterval(typing)
  }
  reply = (reply || '').trim() || '(no response)'

  history.push({ role: 'user', content }, { role: 'assistant', content: reply })
  while (history.length > MAX_HISTORY) history.shift()
  histories.set(channelId, history)

  // Long answers go out as a single .txt attachment (readable, no 5-message spam) with a short
  // preview line. Falls back to chunked messages if the file can't be built/sent.
  if (reply.length > FILE_THRESHOLD && AttachmentBuilder) {
    try {
      const file = new AttachmentBuilder(Buffer.from(reply, 'utf8'), { name: 'ghost-reply.txt' })
      const preview = reply.slice(0, 240).replace(/\s+/g, ' ').trim()
      await msg.channel.send({
        content: `📄 Long answer (${reply.length} chars) — full text attached.\n> ${preview}…`,
        files: [file]
      })
      return
    } catch (e) {
      console.warn('[discord] file reply failed, falling back to chunks:', e?.message || e)
    }
  }

  for (const part of chunk(reply)) await msg.channel.send(part).catch(() => {})
}

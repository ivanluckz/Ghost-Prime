import { streamChat } from '../agent/provider.js'

// Discord relay for Ghost-Prime. Runs INSIDE the Electron main process, so the bot is online only
// while Ghost-Prime is running — message it from Discord and it talks to the same agent (tools and
// all). discord.js is ESM-only-ish + heavy, so it's loaded lazily and the whole thing is a no-op
// unless DISCORD_BOT_TOKEN is set.
//
// SAFETY: this agent can run shell + drive the browser, so the bot ONLY obeys user IDs on
// DISCORD_ALLOWED_USER_IDS. With no allowlist it logs in but refuses every message.

let client = null
const histories = new Map() // channelId -> [{role, content}]
const chains = new Map() // channelId -> Promise (serialize requests per channel)

const MAX_HISTORY = 20 // messages kept per channel for context
const DISCORD_LIMIT = 1900 // stay under Discord's 2000-char message cap

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

  const content = msg.content?.trim()
  if (!content) {
    // Almost always means the Message Content Intent isn't enabled in the dev portal.
    msg.reply("I can't read message content. Enable the **Message Content Intent** in the Discord Developer Portal → your app → Bot.").catch(() => {})
    return
  }

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

  for (const part of chunk(reply)) await msg.channel.send(part).catch(() => {})
}

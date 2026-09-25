import { streamChat, currentRun, runQueueDepth, abortCurrentRun } from '../agent/provider.js'
import { friendlyError } from '../agent/friendly-error.js'
import { onReminderFired } from '../memory/db.js'

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
//   • Reminders set from a channel fire back INTO that channel (the reminder row carries
//     origin 'discord:<channelId>'), and notify_user posts to the channel that started the run —
//     so a user driving Ghost from their phone is actually told, not just the desktop.
//   • Agent runs are serialized globally in provider.js (one at a time across the desktop UI and
//     every channel — they share one browser and one set of terminals); a message that has to wait
//     shows a "⏳ queued" status instead of interleaving with the running task.
//
// SAFETY: this agent can run shell + drive the browser, so the bot ONLY obeys user IDs on
// DISCORD_ALLOWED_USER_IDS. With no allowlist it logs in but refuses every message.

let client = null
let AttachmentBuilder = null // captured from discord.js on startup, used for long-reply .txt files
const histories = new Map() // channelId -> [{role, content}]
// channelId -> Promise: keeps ONE channel's messages in arrival order with a single cancellable run.
// Cross-channel / cross-surface ordering is the global run slot in provider.js's streamChat.
const chains = new Map()
let offReminders = null // unsubscribe from db.onReminderFired while the bot is up
// Discord reminders that fired before the bot finished logging in (one already due at app start
// fires ~3 s in, long before the gateway is up). Delivered on 'clientReady'. Bounded.
const heldReminders = []
const running = new Map() // channelId -> AbortController (in-flight run, so !stop can cancel it)
const modes = new Map() // channelId -> 'plan' | 'auto' | 'full' (per-channel autonomy override)
const brains = new Map() // channelId -> 'auto' | 'gemini' | 'claude' (per-channel brain override)

const MAX_HISTORY = 20 // messages kept per channel for context
const DISCORD_LIMIT = 1900 // stay under Discord's 2000-char message cap
// Headroom balanceFences() needs to reopen (```lang\n, lang capped at FENCE_LANG_MAX) and close (\n```)
// a fence inside one part without pushing it past the cap.
const FENCE_PAD = 30
const FENCE_LANG_MAX = 20
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
  '`!stop` — cancel what I’m doing right now (`!stop all` also cancels a task running on the desktop or in another channel)',
  '`!mode [plan|auto|full]` — show or set autonomy. `plan` is read-only (no state-changing tools). `auto` and `full` both run tools without asking on the Gemini brain; on the Claude brain `auto` has a permission classifier and `full` skips it — careful.',
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
    if (buf && buf.length + line.length + 1 > size) {
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
      carryLang = lang.slice(0, FENCE_LANG_MAX) // cap so a junk "fence" line can't balloon the next part
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

let stopped = false // set by stopDiscord() so a pending login retry can't recreate a client after quit
let retryTimer = null
let retryWake = null // resolver for the pending sleep, so stopDiscord() can wake the loop and let it exit
const sleep = (ms) =>
  new Promise((r) => {
    retryWake = r
    retryTimer = setTimeout(() => {
      retryTimer = null
      retryWake = null
      r()
    }, ms)
  })

// onStatus (optional): ({ state: 'online' | 'retrying' | 'error', detail }) => void, for a future UI pill.
export async function startDiscord({ onStatus } = {}) {
  const token = process.env.DISCORD_BOT_TOKEN
  if (!token) return // not configured — silent no-op
  stopped = false

  let discord
  try {
    discord = await import('discord.js')
  } catch (e) {
    console.warn('[discord] discord.js not available:', e?.message || e)
    return
  }
  // discord.js v14 exports the error-code enum as DiscordjsErrorCodes (older builds: ErrorCodes).
  const { Client, GatewayIntentBits, Partials, ActivityType, DiscordjsErrorCodes: ErrorCodes = discord.ErrorCodes } = discord
  AttachmentBuilder = discord.AttachmentBuilder
  // Bad token / missing privileged intent won't fix itself — don't retry those. A disallowed intent
  // surfaces from @discordjs/ws as a plain Error with no code, so match its message too.
  const FATAL = new Set([ErrorCodes.TokenInvalid, ErrorCodes.DisallowedIntents])
  const isFatal = (e) =>
    FATAL.has(e?.code) || e?.status === 401 || /disallowed intents|invalid intents|sharding is required/i.test(e?.message || '')
  const report = (state, detail) => {
    try {
      onStatus?.({ state, detail })
    } catch {}
  }

  // Reminders asked for from a Discord channel come back to that channel when they fire (the desktop
  // notification still shows too). Origins are 'discord:<channelId>' (see db.addReminder). Subscribe
  // NOW, before login: a reminder that is already due fires within seconds of launch. Until the bot
  // is ready, hold them (no "not connected" noise from a bot that never logs in).
  offReminders?.()
  offReminders = onReminderFired((r) => {
    const target = channelFromOrigin(r?.origin)
    if (!target) return
    const text = `⏰ **Reminder:** ${r.text}`
    if (client?.isReady?.()) notifyDiscord(target, text).catch((e) => console.warn('[discord] reminder delivery failed:', e?.message || e))
    else if (heldReminders.length < 20) heldReminders.push({ target, text })
  })

  if (!allowedIds().length) {
    console.warn('[discord] DISCORD_BOT_TOKEN is set but DISCORD_ALLOWED_USER_IDS is empty — the bot will refuse every message until you add your Discord user id.')
  }

  // Login with exponential backoff: at app launch the network is often not up yet (laptop wake, DNS
  // blip) and discord.js gives up after one failed gateway fetch. Once connected it reconnects itself.
  let delay = 5_000
  while (!stopped) {
    const c = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent // privileged — enable "Message Content Intent" in the Discord dev portal
      ],
      partials: [Partials.Channel, Partials.Message], // needed to receive DMs
      // Model output quotes untrusted web pages / files — never let it ping @everyone/@here/roles.
      // Only the allowlisted owner(s) stay mentionable; replies still notify the person we reply to.
      allowedMentions: { parse: [], users: allowedIds(), repliedUser: true }
    })

    c.once('clientReady', () => {
      console.log(`[discord] online as ${c.user?.tag}`)
      report('online', c.user?.tag)
      try {
        c.user.setActivity('Ghost-Prime', { type: ActivityType.Listening })
      } catch {}
      // Deliver the reminders that fired while we were still logging in.
      for (const { target, text } of heldReminders.splice(0)) {
        notifyDiscord(target, text).catch((e) => console.warn('[discord] reminder delivery failed:', e?.message || e))
      }
    })
    c.on('error', (e) => console.error('[discord] client error:', e?.message || e))
    c.on('messageCreate', (msg) => handleMessage(msg).catch((e) => console.error('[discord]', e?.message || e)))
    client = c

    try {
      await c.login(token)
      return // connected — @discordjs/ws handles reconnects from here
    } catch (e) {
      client = null // login() already destroyed the client on failure
      if (isFatal(e)) {
        console.error('[discord] login failed permanently:', e?.message || e)
        report('error', e?.message || String(e))
        return
      }
      if (stopped) return
      console.warn(`[discord] login failed (${e?.code || e?.message || e}) — retrying in ${delay / 1000}s`)
      report('retrying', e?.message || String(e))
      await sleep(delay)
      delay = Math.min(delay * 2, 60_000)
    }
  }
}

export function stopDiscord() {
  stopped = true
  offReminders?.()
  offReminders = null
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  retryWake?.() // wake a pending backoff sleep so the login loop sees `stopped` and exits
  retryWake = null
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

// 'discord:<channelId>' → channelId (null for anything else, e.g. a desktop-originated reminder).
export const originFor = (channelId) => `discord:${channelId}`
export function channelFromOrigin(origin) {
  const m = /^discord:(\d+)$/.exec(String(origin || ''))
  return m ? m[1] : null
}

// Post a message to a channel by id — used for reminders / notify_user that were asked for from
// Discord. Resolves the channel through the client cache or a fetch (DM channels are not cached
// after a restart). Long text is chunked like any other reply. Rejects when the bot is offline.
export async function notifyDiscord(channelId, text) {
  if (!client) throw new Error('Discord bot is not connected')
  const channel = client.channels.cache.get(channelId) || (await client.channels.fetch(channelId))
  if (!channel || typeof channel.send !== 'function') throw new Error(`channel ${channelId} is not sendable`)
  const parts = balanceFences(chunk(String(text || ''), DISCORD_LIMIT - FENCE_PAD)).filter((p) => p.trim())
  for (const part of parts) await channel.send(part)
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
    // `!stop` cancels this channel's run. When this channel has nothing running (or on `!stop all`)
    // it cancels whatever holds the shared run slot instead — the desktop, or another channel — so
    // a stuck desktop task that has every channel "⏳ queued" can be cleared from the phone.
    const ac = running.get(channelId)
    const all = /^all$/i.test(arg)
    const run = currentRun()
    const holdsSlot = !!run && run.origin === originFor(channelId)
    const lines = []
    if (ac) {
      ac.abort()
      lines.push('🛑 Stopping…')
    }
    if (run && !holdsSlot && (all || !ac)) {
      const where = run.surface === 'discord' ? 'another channel' : 'the desktop'
      lines.push(
        abortCurrentRun()
          ? `🛑 Stopping the task from ${where}…`
          : `A task from ${where} is running but can’t be cancelled from here — stop it on the desktop.`
      )
    }
    msg.reply(lines.join('\n') || 'Nothing is running right now.').catch(() => {})
  } else if (cmd === 'mode') {
    if (!arg) {
      msg.reply(`Mode is **${modes.get(channelId) || DEFAULT_MODE()}**. Set it with \`!mode plan|auto|full\`.`).catch(() => {})
    } else if (!['plan', 'auto', 'full'].includes(arg.toLowerCase())) {
      msg.reply('Mode must be `plan`, `auto`, or `full`.').catch(() => {})
    } else {
      const m = arg.toLowerCase()
      modes.set(channelId, m)
      const warn =
        m === 'full'
          ? ' ⚠️ No permission checks in this channel.'
          : m === 'auto'
            ? ' Tools run without asking on the Gemini brain (Claude uses a permission classifier).'
            : ' Read-only — I’ll plan but not act.'
      msg.reply(`Mode set to **${m}**.${warn}`).catch(() => {})
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
    // The shared run slot: who holds it (this channel / another channel / the desktop) and how many
    // runs are waiting — so a "why is it slow" from the phone gets a real answer.
    const run = currentRun()
    const waiting = Math.max(0, runQueueDepth() - (run ? 1 : 0))
    let busy = ''
    if (running.has(channelId)) busy = run?.origin === originFor(channelId) ? ' · (working…)' : ' · (queued — waiting for another task)'
    else if (run) busy = ` · busy: ${run.surface === 'discord' ? 'another channel' : 'the desktop'} is running a task`
    if (waiting) busy += ` · ${waiting} waiting`
    msg
      .reply(`🟢 Online · brain: \`${brain}\` · mode: **${m}** · history: ${h} msg${h === 1 ? '' : 's'}${busy}`)
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

  // Serialize per channel (arrival order, one !stop target); provider.js's global run slot then
  // serializes across channels and the desktop, so no two agent loops ever share the browser.
  const prev = chains.get(msg.channelId) || Promise.resolve()
  const next = prev.then(() => respond(msg, content)).catch((e) => console.error('[discord]', e?.message || e))
  chains.set(msg.channelId, next)
}

async function respond(msg, content) {
  const channelId = msg.channelId
  const messages = [...(histories.get(channelId) || []), { role: 'user', content }]
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
  // The channel's own notifications (notify_user from the agent) — separate messages, so they
  // survive the placeholder being edited into the final reply.
  const notify = (text) => notifyDiscord(channelId, text)
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
      surface: 'discord',
      origin: originFor(channelId), // stamped on reminders set during this run → they fire back here
      notify,
      signal: ac.signal,
      abort: () => ac.abort(), // lets `!stop all` from another channel (or the desktop) cancel this run
      onDelta: (t) => {
        liveText += t
        pump()
      },
      onEvent: (ev) => {
        if (ev?.kind === 'queued') {
          // Another run (desktop, or another channel) holds the shared browser/terminals — we wait.
          activity = ['⏳', ev.behind === 'desktop' ? 'queued — the desktop is busy' : 'queued behind another task']
          if (!liveText) pump()
        } else if (ev?.kind === 'brain') {
          activity = ['🧠', 'thinking']
          if (!liveText) pump()
        } else if (ev?.kind === 'tool_use') {
          activity = activityFor(ev.name)
          if (!liveText) pump() // only drive the status line until real text starts streaming
        }
      }
    })
  } catch (e) {
    if (ac.signal.aborted) {
      reply = (liveText.trim() ? liveText.trim() + '\n\n' : '') + '🛑 _Stopped._'
    } else {
      console.error('[discord] run failed:', e?.stack || e)
      reply = `⚠️ ${friendlyError(e)}`
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

  // Re-read the live history (not the copy from before the run) so a !reset issued mid-run sticks.
  const history = histories.get(channelId) || []
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

  // Chunk with fence headroom, then drop any empty parts (Discord rejects blank messages).
  let parts = balanceFences(chunk(reply, DISCORD_LIMIT - FENCE_PAD)).filter((p) => p.trim())
  if (!parts.length) parts = ['(no response)']
  if (placeholder) await placeholder.edit(parts[0]).catch(() => channel.send(parts[0]).catch(() => {}))
  else await channel.send(parts[0]).catch(() => {})
  for (let i = 1; i < parts.length; i++) await channel.send(parts[i]).catch(() => {})
}

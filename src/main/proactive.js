// Proactive engine + morning briefing. Turns Ghost from purely reactive into "present":
//  • Morning briefing — first launch of a new day, greet + recap what we did (from the session
//    summaries) + the time.
//  • Check-ins — after a stretch of idle time within waking hours, a short context-aware line.
// Every generated line is pushed into the chat via onMessage() and spoken only if voice is on.
// Cheap (Haiku, a few calls/day) and fully disableable with GHOST_PROACTIVE=0.
import { memoryDigest, allMemories, getPref, setPref } from './memory/db.js'
import { generateShort } from './agent/provider.js'

const enabled = () => process.env.GHOST_PROACTIVE !== '0'
const IDLE_MS = Number(process.env.GHOST_PROACTIVE_IDLE_MIN || 25) * 60000 // silence before a check-in
const MIN_GAP_MS = 90 * 60000 // never check in more often than this
const WAKE_START = 8 // 08:00
const WAKE_END = 22 // 22:00

let onMessage = null
let timer = null
let lastActivity = Date.now()
let lastCheckIn = 0
let usedThisRun = false // don't nag if the user never spoke this session

export function noteActivity() {
  lastActivity = Date.now()
  usedThisRun = true
}

function withinWakingHours() {
  const h = new Date().getHours()
  return h >= WAKE_START && h < WAKE_END
}

function digestText() {
  const d = memoryDigest(8)
  return d.length ? d.map((m) => `- [${m.type}] ${m.content}`).join('\n') : '(nothing yet)'
}

function recentSummaries(limit = 6) {
  try {
    return allMemories(60)
      .filter((m) => Array.isArray(m.tags) && m.tags.includes('session-summary'))
      .slice(0, limit)
      .map((m) => `- ${m.content}`)
  } catch {
    return []
  }
}

async function briefingIfNewDay() {
  // Local calendar day (not UTC) — the greeting text and waking-hours logic are local too.
  const d = new Date()
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  if (getPref('lastBriefingDate') === today) return
  setPref('lastBriefingDate', today) // set first so a failure never loops
  const when = new Date().toLocaleString(undefined, { weekday: 'long', hour: 'numeric', minute: '2-digit' })
  const recap = recentSummaries().join('\n') || '(no earlier sessions to recap)'
  const text = await generateShort(
    'You are Ghost-Prime greeting your user at the start of their day. Warm, brief (1-3 sentences), not corny. ' +
      'Greet them, note the day/time naturally, and if there is anything to recap, mention it in one line. No lists, no markdown.',
    `Time: ${when}\n\nWhat you know about them:\n${digestText()}\n\nRecent things you did together:\n${recap}\n\nWrite the greeting.`
  )
  if (text) onMessage?.(text.trim(), { kind: 'briefing' })
}

async function maybeCheckIn() {
  if (!usedThisRun || !withinWakingHours()) return
  const now = Date.now()
  if (now - lastActivity < IDLE_MS) return
  if (now - lastCheckIn < MIN_GAP_MS) return
  lastCheckIn = now
  const hour = new Date().getHours()
  const part = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 21 ? 'evening' : 'night'
  const text = await generateShort(
    'You are Ghost-Prime, checking in on your user after a quiet stretch. ONE short, natural sentence — ' +
      'a light nudge or offer of help tied to what they care about. Never pushy, never a list, no markdown. ' +
      'If nothing is worth saying, reply with exactly SKIP.',
    `It is ${part}. What you know about them:\n${digestText()}\n\nWrite the check-in (or SKIP).`
  )
  const clean = (text || '').trim()
  if (clean && clean.toUpperCase() !== 'SKIP') onMessage?.(clean, { kind: 'checkin' })
}

export function initProactive({ onMessage: cb } = {}) {
  onMessage = cb
  if (!enabled()) return
  // Briefing shortly after boot (let the DB + window settle first).
  setTimeout(() => briefingIfNewDay().catch(() => {}), 8000)
  if (timer) clearInterval(timer)
  timer = setInterval(() => maybeCheckIn().catch(() => {}), 5 * 60000)
  if (timer.unref) timer.unref()
}

export function stopProactive() {
  if (timer) clearInterval(timer)
  timer = null
}

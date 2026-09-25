// Proactive engine + morning briefing. Turns Ghost from purely reactive into "present":
//  • Morning briefing — first launch of a new day, greet + recap what we did (from the session
//    summaries) + the time. Counted as delivered only once it actually reached the UI.
//  • Check-ins — after a stretch of idle time within waking hours, a short context-aware line.
// Every generated line is pushed into the chat via onMessage() and spoken only if voice is on.
// Cheap (Haiku, a few calls/day) and fully disableable with GHOST_PROACTIVE=0.
import { memoryDigest, allMemories, getPref, setPref } from './memory/db.js'
import { generateShort } from './agent/provider.js'
import { envBool } from './env.js'

const enabled = () => envBool('GHOST_PROACTIVE', true)
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

// Local calendar day (not UTC) — the greeting text and waking-hours logic are local too.
function localDay() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// The day's briefing is marked delivered only once it was actually handed to the UI (non-empty text
// AND onMessage accepted it — main buffers pushes until the renderer is listening, so "accepted"
// means it will be shown). A failed/empty generation (429, missing key, offline) is retried on the
// next tick, a bounded number of times per day, so one bad call can't eat the day's briefing —
// and can't loop forever either.
const BRIEFING_MAX_ATTEMPTS = 4
let briefingAttempts = { day: '', count: 0 }
let briefingInFlight = false

async function briefingIfNewDay() {
  const today = localDay()
  if (getPref('lastBriefingDate') === today) return false
  if (briefingInFlight) return false
  if (briefingAttempts.day !== today) briefingAttempts = { day: today, count: 0 }
  if (briefingAttempts.count >= BRIEFING_MAX_ATTEMPTS) return false
  briefingAttempts.count++
  briefingInFlight = true
  try {
    const when = new Date().toLocaleString(undefined, { weekday: 'long', hour: 'numeric', minute: '2-digit' })
    const recap = recentSummaries().join('\n') || '(no earlier sessions to recap)'
    const text = (
      (await generateShort(
        'You are Ghost-Prime greeting your user at the start of their day. Warm, brief (1-3 sentences), not corny. ' +
          'Greet them, note the day/time naturally, and if there is anything to recap, mention it in one line. No lists, no markdown.',
        `Time: ${when}\n\nWhat you know about them:\n${digestText()}\n\nRecent things you did together:\n${recap}\n\nWrite the greeting.`
      )) || ''
    ).trim()
    if (!text) return false
    // onMessage reports whether the line reached (or was queued for) the UI; a callback that returns
    // nothing is treated as delivered, matching the old fire-and-forget contract.
    const delivered = onMessage ? onMessage(text, { kind: 'briefing' }) !== false : false
    if (!delivered) return false
    setPref('lastBriefingDate', today)
    return true
  } finally {
    briefingInFlight = false
  }
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
  if (clean && !isSkip(clean)) onMessage?.(clean, { kind: 'checkin' })
}

// Did the model say "nothing to say"? It rarely answers exactly SKIP: "SKIP.", '"SKIP"', "Skip." or
// "SKIP — nothing to add" were posted as check-ins (and read aloud). A real sentence that merely
// starts with "Skip…" ("Skip the snacks today!") is still a check-in.
export function isSkip(text) {
  const t = String(text || '').trim()
  return /^\W*skip\W*$/i.test(t) || /^\W*SKIP\b/.test(t)
}

// The 5-minute tick only RETRIES a briefing the boot attempt already started for today (failed
// generation / rejected push). It never arms a fresh one: an app left running over midnight would
// otherwise greet "the start of your day" at ~00:05 — and then mark the day delivered, so the real
// morning got nothing. A new day's briefing comes from the next launch, like before.
function briefingRetryDue() {
  return briefingAttempts.day === localDay() && briefingAttempts.count > 0 && !briefingInFlight
}
function tick() {
  const p = briefingRetryDue() ? briefingIfNewDay() : Promise.resolve(false)
  return p
    .catch(() => {})
    .then(() => maybeCheckIn())
    .catch(() => {})
}

export function initProactive({ onMessage: cb } = {}) {
  onMessage = cb
  if (!enabled()) return
  // Briefing shortly after boot (let the DB + window settle first); the tick retries it if that
  // first attempt produced nothing (see briefingIfNewDay).
  setTimeout(() => briefingIfNewDay().catch(() => {}), 8000)
  if (timer) clearInterval(timer)
  timer = setInterval(tick, 5 * 60000)
  if (timer.unref) timer.unref()
}

export function stopProactive() {
  if (timer) clearInterval(timer)
  timer = null
}

// Test hooks (smoke-proactive): run the briefing / the interval tick on demand, and set or reset
// the per-day attempt budget (e.g. to a stale day, simulating an app left running past midnight).
export const _briefingIfNewDay = briefingIfNewDay
export const _tick = tick
export const _resetBriefingAttempts = (day = '', count = 0) => {
  briefingAttempts = { day, count }
}

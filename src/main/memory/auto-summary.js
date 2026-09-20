// Distill a chat into durable cross-session memories when you LEAVE it (switch chats / quit).
// Best-effort and fire-and-forget: it never throws and never blocks the UI. The agent already
// saves memories on purpose via memory_save; this catches the durable facts it didn't think to.
// Turn it off with GHOST_AUTO_SUMMARIZE=0.
import {
  sessionMessages,
  sessionSummaryState,
  markSessionSummarized,
  sessionSummaryMemories,
  memoryDigest,
  allMemories,
  saveMemory
} from './db.js'
import { summarizeConversation } from '../agent/provider.js'

const enabled = () => process.env.GHOST_AUTO_SUMMARIZE !== '0'
const MIN_USER_TURNS = 2 // need a real back-and-forth, not a one-line ask
const MIN_CHARS = 400 // …with some substance to it
const MIN_NEW_MESSAGES = 4 // re-summarize a grown chat only after this many new messages
const FAILURE_BACKOFF_MS = 10 * 60 * 1000 // after a failed model call (429 / no key) don't retry every chat switch

const inFlight = new Set() // don't double-summarize the same session concurrently
let lastFailureAt = 0

export async function maybeSummarizeSession(sessionId) {
  if (!enabled() || !sessionId || inFlight.has(sessionId)) return
  if (Date.now() - lastFailureAt < FAILURE_BACKOFF_MS) return // still backing off from the last failure
  inFlight.add(sessionId)
  try {
    const msgs = sessionMessages(sessionId)
    const userTurns = msgs.reduce((n, m) => n + (m.role === 'user' ? 1 : 0), 0)
    const chars = msgs.reduce((n, m) => n + (m.content?.length || 0), 0)
    if (userTurns < MIN_USER_TURNS || chars < MIN_CHARS) return // too thin to be worth a memory

    const { summarizedAt, summaryCount } = sessionSummaryState(sessionId)
    if (summarizedAt && msgs.length - summaryCount < MIN_NEW_MESSAGES) return // already captured, little new

    // ALREADY KNOWN = this chat's earlier summaries + what's in memory from every other chat and
    // memory_save, so stable facts ("on Chrome OS") aren't re-saved by each new session. Bounded
    // to keep the prompt cheap.
    const known = [
      ...new Set([
        ...sessionSummaryMemories(sessionId),
        ...memoryDigest(8).map((m) => m.content),
        ...allMemories(60).map((m) => m.content)
      ])
    ].slice(0, 80)
    const facts = await summarizeConversation(msgs, { known })
    if (!Array.isArray(facts)) {
      // model call failed — leave the chat unmarked so we retry, but not on every switch/quit
      lastFailureAt = Date.now()
      return
    }
    // Hard dedup guard (normalized text) so the LLM-side "do not repeat" isn't the only defense.
    const norm = (t) => t.toLowerCase().replace(/\s+/g, ' ').trim()
    const seen = new Set(known.map(norm))
    let saved = 0
    for (const f of facts) {
      const text = String(f).trim()
      if (!text || seen.has(norm(text))) continue
      seen.add(norm(text))
      // importance 4: explicit memory_save facts (default 5) outrank auto-summaries in the digest
      saveMemory(text, 'session-summary', 4, { tags: ['session-summary'], sessionId })
      saved++
    }
    // Mark even when nothing durable surfaced, so we don't retry until the chat grows further.
    markSessionSummarized(sessionId, msgs.length)
    if (process.env.GHOST_DEBUG) console.log(`[auto-summary] ${sessionId.slice(0, 8)}: +${saved} fact(s)`)
  } catch (e) {
    lastFailureAt = Date.now()
    if (process.env.GHOST_DEBUG) console.warn('[auto-summary] failed:', e?.message || e)
  } finally {
    inFlight.delete(sessionId)
  }
}

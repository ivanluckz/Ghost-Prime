// Distill a chat into durable cross-session memories when you LEAVE it (switch chats / quit).
// Best-effort and fire-and-forget: it never throws and never blocks the UI. The agent already
// saves memories on purpose via memory_save; this catches the durable facts it didn't think to.
// Turn it off with GHOST_AUTO_SUMMARIZE=0.
import {
  sessionMessages,
  sessionSummaryState,
  markSessionSummarized,
  sessionSummaryMemories,
  saveMemory
} from './db.js'
import { summarizeConversation } from '../agent/provider.js'

const enabled = () => process.env.GHOST_AUTO_SUMMARIZE !== '0'
const MIN_USER_TURNS = 2 // need a real back-and-forth, not a one-line ask
const MIN_CHARS = 400 // …with some substance to it
const MIN_NEW_MESSAGES = 4 // re-summarize a grown chat only after this many new messages

const inFlight = new Set() // don't double-summarize the same session concurrently

export async function maybeSummarizeSession(sessionId) {
  if (!enabled() || !sessionId || inFlight.has(sessionId)) return
  inFlight.add(sessionId)
  try {
    const msgs = sessionMessages(sessionId)
    const userTurns = msgs.reduce((n, m) => n + (m.role === 'user' ? 1 : 0), 0)
    const chars = msgs.reduce((n, m) => n + (m.content?.length || 0), 0)
    if (userTurns < MIN_USER_TURNS || chars < MIN_CHARS) return // too thin to be worth a memory

    const { summarizedAt, summaryCount } = sessionSummaryState(sessionId)
    if (summarizedAt && msgs.length - summaryCount < MIN_NEW_MESSAGES) return // already captured, little new

    const known = sessionSummaryMemories(sessionId) // so we add only NEW facts on a re-summary
    const facts = await summarizeConversation(msgs, { known })
    for (const f of facts) {
      const text = String(f).trim()
      if (text) saveMemory(text, 'session-summary', 5, { tags: ['session-summary'], sessionId })
    }
    // Mark even when nothing durable surfaced, so we don't retry until the chat grows further.
    markSessionSummarized(sessionId, msgs.length)
    if (process.env.GHOST_DEBUG) console.log(`[auto-summary] ${sessionId.slice(0, 8)}: +${facts.length} fact(s)`)
  } catch (e) {
    if (process.env.GHOST_DEBUG) console.warn('[auto-summary] failed:', e?.message || e)
  } finally {
    inFlight.delete(sessionId)
  }
}

// Scheduled reminders. Persisted in SQLite (survive restarts) and fired by a lightweight
// in-process poller. When one is due we hand it to the onFire callback wired in index.js
// (desktop notification + optional voice + a line pushed into the chat).
import { addReminder, dueReminders, pendingReminders, markReminderFired, cancelReminder } from '../memory/db.js'

let timer = null
let fireCb = null

export function initReminders({ onFire } = {}) {
  fireCb = onFire
  if (timer) clearInterval(timer)
  const tick = () => {
    let due = []
    try {
      due = dueReminders(Date.now())
    } catch {
      return
    }
    for (const r of due) {
      markReminderFired(r.id) // mark first so a slow/crashing callback can't double-fire
      try {
        fireCb?.(r)
      } catch {}
    }
  }
  timer = setInterval(tick, 20000)
  if (timer.unref) timer.unref()
  setTimeout(tick, 3000) // catch anything already overdue from a previous run
}

export function stopReminders() {
  if (timer) clearInterval(timer)
  timer = null
}

// Compute an absolute due time from either an ISO string (`at`) or a relative offset.
function resolveDueAt({ at, inMinutes, inSeconds } = {}) {
  if (at) {
    const t = Date.parse(at)
    if (!Number.isNaN(t)) return t
  }
  if (inMinutes != null && !Number.isNaN(Number(inMinutes))) return Date.now() + Number(inMinutes) * 60000
  if (inSeconds != null && !Number.isNaN(Number(inSeconds))) return Date.now() + Number(inSeconds) * 1000
  return null
}

// Used by the agent tool. Returns { id, dueAt } or throws a clear error.
export function setReminder({ text, at, inMinutes, inSeconds } = {}) {
  const clean = String(text || '').trim()
  if (!clean) throw new Error('reminder text is required')
  const dueAt = resolveDueAt({ at, inMinutes, inSeconds })
  if (!dueAt) throw new Error('need a time: pass `at` (ISO 8601) or `inMinutes` / `inSeconds`')
  if (dueAt < Date.now() - 1000) throw new Error('that time is in the past')
  const id = addReminder(clean, dueAt)
  // addReminder returns null when the database didn't open at startup: nothing was saved, so it
  // would never fire. Say so (the model tells the user) instead of reporting success.
  if (!id) throw new Error("reminders are unavailable right now (the app's database didn't open), so it was not saved")
  return { id, dueAt }
}

export function listReminders() {
  return pendingReminders().map((r) => ({ id: r.id, text: r.text, dueAt: r.due_at }))
}

export function cancelReminderById(id) {
  return cancelReminder(id)
}

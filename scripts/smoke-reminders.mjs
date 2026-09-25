// Reminders: two bugs found on 25 Sep.
//  1. With the database unavailable, reminder_set said "Reminder set for …" and nothing ever fired.
//  2. A Discord reminder that was already due when the app started fired ~3 s after launch, before
//     the Discord bot had logged in, and was never delivered to Discord.
// Offline (sqlite via node:sqlite, discord.js stubbed). About 8 s.
// Run: node --import ./scripts/lib/register-offline-stubs.mjs scripts/smoke-reminders.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && extra ? `  → ${String(extra).slice(0, 300)}` : ''}`)
}
try {
  await import('node:sqlite')
} catch {
  console.log('SKIP: this Node has no node:sqlite (needs Node 22.5+)')
  process.exit(0)
}
const dir = mkdtempSync(join(tmpdir(), 'ghost-reminders-'))
process.env.GHOST_STUB_DATA_DIR = dir
const db = await import('../src/main/memory/db.js')
const reminders = await import('../src/main/tools/reminders.js')
const { executeTool } = await import('../src/main/tools/index.js')

// ---- 1. no database: say so instead of pretending ----------------------------------------------
let threw = null
try {
  reminders.setReminder({ text: 'drink water', inMinutes: 2 })
} catch (e) {
  threw = e.message
}
check(!!threw && /can't|cannot|unavailable|not saved/i.test(threw), 'no database: setReminder refuses with a clear reason', threw)
const t = await executeTool('reminder_set', { text: 'drink water', delay_seconds: 120 })
check(t.isError && !/Reminder set for/.test(t.output), 'no database: the reminder_set tool reports an error, not success', JSON.stringify(t))

// ---- 2. a Discord reminder due at startup reaches Discord ---------------------------------------
db.initDb(process.cwd())
db.addReminder('stand up and stretch', Date.now() - 60000, 'discord:4242') // saved before a restart
const ok = reminders.setReminder({ text: 'works with a database', inMinutes: 5 })
check(!!ok.id, 'with a database, reminders save as before')
process.env.DISCORD_BOT_TOKEN = 'test-token'
process.env.DISCORD_ALLOWED_USER_IDS = '1'
globalThis.__discordLoginMs = 4500 // the gateway takes longer than the 3 s first check
const fired = []
reminders.initReminders({ onFire: (r) => fired.push(r.text) })
const { startDiscord, stopDiscord } = await import('../src/main/discord/index.js')
startDiscord()
await new Promise((r) => setTimeout(r, 6500))
check(fired.includes('stand up and stretch'), 'the overdue reminder fired on the desktop at startup', JSON.stringify(fired))
const sent = globalThis.__discordSent.filter((m) => m.id === '4242')
check(sent.length === 1 && /stand up and stretch/.test(sent[0].content), 'it was delivered to its Discord channel once the bot was online', JSON.stringify(globalThis.__discordSent))

stopDiscord()
reminders.stopReminders()
rmSync(dir, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

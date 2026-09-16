// Fire a task at Ghost-Prime from the command line / a scheduled timer.
//   node scripts/run-task.mjs "Summarize my unread email and read it to me."
// Reuses the app's local /task endpoint (same channel as right-click / wake daemon); launches the
// app first if it isn't running. Reads GHOST_BRIDGE_* / GHOST_LAUNCH_CMD from .env.
import dotenv from 'dotenv'
import { spawn } from 'node:child_process'

dotenv.config()
const BRIDGE = (process.env.GHOST_BRIDGE_URL || 'http://127.0.0.1:8731').replace(/\/$/, '')
const TOKEN = process.env.GHOST_BRIDGE_TOKEN || 'ghost-local'
const LAUNCH = process.env.GHOST_LAUNCH_CMD || 'gtk-launch ghost-prime'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const prompt = process.argv.slice(2).join(' ').trim()
if (!prompt) {
  console.error('usage: node scripts/run-task.mjs "your task"')
  process.exit(1)
}

async function up() {
  try {
    return (await fetch(`${BRIDGE}/ping?token=${TOKEN}`)).ok
  } catch {
    return false
  }
}

async function ensureApp() {
  if (await up()) return true
  spawn(LAUNCH, { shell: true, detached: true, stdio: 'ignore' }).unref()
  for (let i = 0; i < 40; i++) {
    if (await up()) return true
    await sleep(500)
  }
  return false
}

const ok = await ensureApp()
if (!ok) {
  console.error('Ghost-Prime app is not reachable (could not launch it).')
  process.exit(1)
}
const res = await fetch(`${BRIDGE}/task?token=${TOKEN}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt })
})
console.log(`sent (${res.status}): ${prompt}`)

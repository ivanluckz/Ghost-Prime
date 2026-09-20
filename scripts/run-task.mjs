// Fire a task at Ghost-Prime from the command line / a scheduled timer.
//   node scripts/run-task.mjs "Summarize my unread email and read it to me."
// Reuses the app's local /task endpoint (same channel as right-click / wake daemon); launches the
// app first if it isn't running. Reads GHOST_BRIDGE_* / GHOST_LAUNCH_CMD from .env.
//
// Launch order when the app is down: GHOST_LAUNCH_CMD (if set) → the repo's own bin/ghost-prime
// launcher (detaches itself, builds on first run) → `gtk-launch ghost-prime` (desktop entry) as a
// last resort. GHOST_LAUNCH_WAIT_S (default 90) caps how long we wait for /ping to answer — a first
// run has to build, which takes well over the old 20 s.
import dotenv from 'dotenv'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolve .env next to the repo, not the cwd: a cron / systemd job runs from $HOME and would
// otherwise never see the repo's GHOST_BRIDGE_TOKEN / GHOST_LAUNCH_CMD.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: join(ROOT, '.env') })
const BRIDGE = (process.env.GHOST_BRIDGE_URL || 'http://127.0.0.1:8731').replace(/\/$/, '')
const TOKEN = process.env.GHOST_BRIDGE_TOKEN || 'ghost-local'
const LAUNCHER = join(ROOT, 'bin', 'ghost-prime')
// Single-quoted for `sh -c` so a checkout under a path with spaces still runs the launcher.
const shq = (s) => `'${s.replace(/'/g, `'\\''`)}'`
// Tried in order until one starts the app (a command that exits non-zero right away is skipped).
const LAUNCHERS = [process.env.GHOST_LAUNCH_CMD, existsSync(LAUNCHER) ? shq(LAUNCHER) : null, 'gtk-launch ghost-prime'].filter(Boolean)
const WAIT_MS = Math.max(5, Number(process.env.GHOST_LAUNCH_WAIT_S) || 90) * 1000
const POLL_MS = 500
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const prompt = process.argv.slice(2).join(' ').trim()
if (!prompt) {
  console.error('usage: node scripts/run-task.mjs "your task"')
  process.exit(1)
}

// A 403 means the app IS up but GHOST_BRIDGE_TOKEN doesn't match — launching another copy and
// waiting 90 s for /ping would never fix that, so fail right away with the real cause.
async function up() {
  let r
  try {
    r = await fetch(`${BRIDGE}/ping?token=${TOKEN}`)
  } catch {
    return false
  }
  if (r.status === 403) {
    console.error(`bridge at ${BRIDGE} rejected GHOST_BRIDGE_TOKEN — fix the token in ${join(ROOT, '.env')}`)
    process.exit(1)
  }
  return r.ok
}

// Spawn the launcher and resolve with its exit code (null if it is still running when we stop
// caring, e.g. a foreground command). A command that is missing / fails to start reports 127 via
// the shell, which we surface so a wrong GHOST_LAUNCH_CMD is not a silent 90 s wait.
function launch(cmd) {
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }
    let child
    try {
      child = spawn(cmd, { shell: true, detached: true, stdio: 'ignore' })
    } catch (e) {
      return done({ code: 127, error: e.message })
    }
    child.on('error', (e) => done({ code: 127, error: e.message }))
    child.on('exit', (code) => done({ code }))
    child.unref()
    // bin/ghost-prime returns as soon as Electron is detached; a custom command may block — don't
    // wait on it, poll /ping instead.
    setTimeout(() => done({ code: null }), 3000)
  })
}

async function ensureApp() {
  if (await up()) return true
  const deadline = Date.now() + WAIT_MS
  for (const cmd of LAUNCHERS) {
    console.error(`Ghost-Prime is not running — launching: ${cmd}`)
    const r = await launch(cmd)
    if (r.code !== null && r.code !== 0) {
      console.error(`  launcher exited with code ${r.code}${r.error ? ` (${r.error})` : ''} — trying the next one`)
      continue
    }
    while (Date.now() < deadline) {
      if (await up()) return true
      await sleep(POLL_MS)
    }
    return false // it started something but /ping never answered; don't stack a second launch
  }
  return false
}

const ok = await ensureApp()
if (!ok) {
  console.error(`Ghost-Prime app is not reachable at ${BRIDGE} (could not launch it within ${WAIT_MS / 1000}s).`)
  console.error(`Tried: ${LAUNCHERS.join(' · ')}. Set GHOST_LAUNCH_CMD in .env if the app lives elsewhere, or start it by hand: ghost-prime`)
  process.exit(1)
}
const res = await fetch(`${BRIDGE}/task?token=${TOKEN}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt })
})
console.log(`sent (${res.status}): ${prompt}`)

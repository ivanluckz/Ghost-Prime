import { homedir, tmpdir } from 'node:os'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow } from 'electron'

// node-pty is a native module. Load it lazily + defensively: an ABI mismatch (e.g. after an
// Electron upgrade without a rebuild) must never crash the whole app at import time — terminals
// just report "backend unavailable" until rebuilt (`npx electron-rebuild -f -o node-pty`).
let pty = null
let ptyTried = false
let ptyError = null
async function loadPty() {
  if (ptyTried) return pty
  ptyTried = true
  try {
    const m = await import('node-pty')
    pty = m?.default?.spawn ? m.default : m
  } catch (e) {
    ptyError = e
    pty = null
  }
  return pty
}

const MAX_SCROLLBACK = 200_000 // bytes of raw output kept per session, for UI re-attach / agent reads
const AGENT_TIMEOUT_DEFAULT = 120_000

const sessions = new Map() // id -> session
let counter = 0

// Shell integration: bash emits OSC-133 semantic markers itself (invisible in the terminal) so we can
// tell where a command's output begins (C) and ends (D;<exit>) WITHOUT typing any marker commands
// that would echo into the user's view. We point bash at this rc file, which also sources the user's
// normal profile/bashrc so their prompt and aliases are intact.
let rcPath = null
function ensureRc() {
  if (rcPath) return rcPath
  const body = [
    '# Ghost-Prime shell integration (OSC 133 semantic prompts)',
    'if [ -r /etc/profile ]; then . /etc/profile; fi',
    'if [ -r "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi',
    "__ghost_done() { local e=$?; printf '\\033]133;D;%s\\007' \"$e\"; }",
    'case "${PROMPT_COMMAND:-}" in',
    '  *__ghost_done*) ;;',
    '  *) PROMPT_COMMAND="__ghost_done${PROMPT_COMMAND:+; $PROMPT_COMMAND}" ;;',
    'esac',
    "PS0='\\e]133;C\\a'",
    "printf '\\033]133;A\\007'",
    ''
  ].join('\n')
  const p = join(tmpdir(), 'ghost-prime-shell.bash')
  writeFileSync(p, body, 'utf8')
  rcPath = p
  return rcPath
}

// ---- ANSI / control-sequence stripping (only for the text handed to the AGENT; the UI keeps raw) --
function stripAnsi(s) {
  return String(s)
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '') // OSC (titles, the 133 markers themselves)
    .replace(/\x1b[P^_X][\s\S]*?\x1b\\/g, '') // DCS / PM / APC / SOS
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI (colors, cursor moves, bracketed paste)
    .replace(/\x1b[=>NOc]/g, '') // single-char escapes
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '') // stray control chars (keep \t \n \r)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

// ---- broadcast to the renderer -------------------------------------------------------------------
function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

function snapshot() {
  return [...sessions.values()].map((s) => ({
    id: s.id,
    name: s.name,
    cwd: s.cwd,
    alive: s.alive,
    agent: s.agent,
    busy: !!s.capture,
    lastExit: s.lastExit,
    createdAt: s.createdAt
  }))
}
const emitSessions = () => broadcast('shell:sessions', snapshot())

// ---- lifecycle -----------------------------------------------------------------------------------
export async function createSession({ name, cwd, cols = 80, rows = 24, agent = false } = {}) {
  const p = await loadPty()
  if (!p) throw new Error(`Terminal backend unavailable: ${ptyError?.message || 'node-pty failed to load'}`)

  const n = ++counter
  const startCwd = cwd || homedir()
  const shell = p.spawn('bash', ['--init-file', ensureRc()], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: startCwd,
    env: { ...process.env, TERM: 'xterm-256color', GHOST_TERMINAL: '1' }
  })

  const session = {
    id: `t${n}`,
    name: name || `Terminal ${n}`,
    cwd: startCwd,
    pty: shell,
    alive: true,
    agent: !!agent,
    createdAt: Date.now(),
    scrollback: '',
    capture: null,
    osc: null, // null = unknown, true = OSC-133 integration live, false = fell back to printf markers
    lastExit: null // exit code once the shell process dies (so shell_list surfaces deaths)
  }

  shell.onData((data) => {
    session.scrollback = (session.scrollback + data).slice(-MAX_SCROLLBACK)
    // Integration is live the moment we see any OSC-133 marker (emitted on the first prompt).
    if (session.osc === null && session.scrollback.slice(-64).indexOf('\x1b]133;') !== -1) session.osc = true
    broadcast('shell:data', { id: session.id, data })
    if (session.capture) session.capture.feed(data)
  })
  shell.onExit(({ exitCode }) => {
    session.alive = false
    session.lastExit = exitCode
    broadcast('shell:data', { id: session.id, data: `\r\n\x1b[2m[process exited: ${exitCode}]\x1b[0m\r\n` })
    if (session.capture) session.capture.onExit(exitCode)
    emitSessions()
  })

  sessions.set(session.id, session)
  emitSessions()
  return { id: session.id, name: session.name, cwd: session.cwd }
}

export function writeToSession(id, data) {
  const s = sessions.get(id)
  if (s?.alive) s.pty.write(data)
}

export function resizeSession(id, cols, rows) {
  const s = sessions.get(id)
  if (s?.alive && cols > 0 && rows > 0) {
    try {
      s.pty.resize(cols, rows)
    } catch {}
  }
}

export function killSession(id) {
  const s = sessions.get(id)
  if (!s) return false
  try {
    s.pty.kill()
  } catch {}
  s.alive = false
  sessions.delete(id)
  emitSessions()
  return true
}

export function listSessions() {
  return snapshot()
}

export function getScrollback(id) {
  return sessions.get(id)?.scrollback || ''
}

export function killAll() {
  for (const s of sessions.values()) {
    try {
      s.pty.kill()
    } catch {}
  }
  sessions.clear()
}

// Wait until the shell is live — detected by its first OSC-133 marker (set on session.osc by the
// onData handler). Nothing is typed, so nothing shows. Falls through on timeout (osc stays false → we
// use the printf-marker fallback for that session).
function waitReady(session, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (session.osc) return resolve(true)
    const t0 = Date.now()
    const iv = setInterval(() => {
      if (session.osc) {
        clearInterval(iv)
        resolve(true)
      } else if (!session.alive || Date.now() - t0 > timeoutMs) {
        clearInterval(iv)
        if (session.osc === null) session.osc = false
        resolve(!!session.osc)
      }
    }, 40)
  })
}

// ---- agent-facing run/read -----------------------------------------------------------------------
export async function runForAgent({ id, command, name, cwd, background = false, timeoutMs = AGENT_TIMEOUT_DEFAULT }) {
  let session = id ? sessions.get(id) : null
  if (!session || !session.alive) {
    const created = await createSession({ name, cwd, agent: true })
    session = sessions.get(created.id)
  }
  if (!session) throw new Error('Could not open a terminal session.')
  if (session.osc === null) await waitReady(session) // learn the capture method before running

  if (background) {
    session.pty.write(command + '\r')
    emitSessions()
    return {
      sessionId: session.id,
      name: session.name,
      background: true,
      output:
        `Started in ${session.name} (${session.id}); it keeps running in the background. ` +
        `Use shell_read on ${session.id} to see its latest output, shell_list to see all terminals, ` +
        `or shell_kill to stop it.`
    }
  }

  if (session.capture) throw new Error(`${session.name} (${session.id}) is busy running another command.`)

  return session.osc ? captureOsc(session, command, timeoutMs) : capturePrintf(session, command, timeoutMs)
}

function finalize(session, resolve, { code, raw, timedOut, exited, timeoutMs }) {
  session.capture = null
  emitSessions()
  const text = stripAnsi(raw).replace(/^\s*\n/, '').trimEnd()
  resolve({
    sessionId: session.id,
    name: session.name,
    exitCode: code,
    timedOut,
    exited,
    output:
      text +
      (timedOut
        ? `\n\n[still running after ${Math.round(timeoutMs / 1000)}s — left running in ${session.id}; check it with shell_read]`
        : '')
  })
}

// Primary path: bash's OSC-133 markers bracket the command's output. C = output starts (right after
// the echoed command line), D;<exit> = command finished. Both are invisible in the terminal, so the
// user sees only their command + its output, and we get a clean capture with the real exit code.
function captureOsc(session, command, timeoutMs) {
  return new Promise((resolve) => {
    const startRe = /\x1b\]133;C\x07/
    const endRe = /\x1b\]133;D(?:;(-?\d+))?\x07/
    let raw = ''
    let started = false
    let settled = false
    const timer = setTimeout(() => done(null, { timedOut: true }), timeoutMs)

    function done(code, { timedOut = false, exited = false } = {}) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      finalize(session, resolve, { code, raw, timedOut, exited, timeoutMs })
    }

    session.capture = {
      feed(data) {
        raw += data
        if (!started) {
          const m = raw.match(startRe)
          if (!m) return
          started = true
          raw = raw.slice(m.index + m[0].length) // drop the command echo before output
        }
        const d = raw.match(endRe)
        if (d) {
          raw = raw.slice(0, d.index)
          done(d[1] != null ? parseInt(d[1], 10) : null, {})
        }
      },
      onExit(code) {
        done(typeof code === 'number' ? code : null, { exited: true })
      }
    }

    session.pty.write(command + '\r')
    emitSessions()
  })
}

// Fallback (no shell integration): bracket the command with printf markers. The `%s` format keeps the
// echoed wrapper lines from containing the literal token, so only the printf OUTPUT matches — we slice
// the command's output out of the stream and filter the wrapper echoes.
function capturePrintf(session, command, timeoutMs) {
  const token = 'G' + Math.random().toString(36).slice(2, 10).toUpperCase()
  const startRe = new RegExp(`__BEG_${token}__`)
  const endRe = new RegExp(`__END_${token}_(-?\\d+)__`)

  return new Promise((resolve) => {
    let raw = ''
    let settled = false
    const timer = setTimeout(() => done(null, { timedOut: true }), timeoutMs)

    function done(code, { timedOut = false, exited = false } = {}) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      let text = raw
      const b = text.search(startRe)
      if (b >= 0) text = text.slice(b).replace(startRe, '')
      const e = text.search(endRe)
      if (e >= 0) text = text.slice(0, e)
      text = text
        .split('\n')
        .filter((line) => !/printf '__(?:BEG|END)_%s/.test(line))
        .join('\n')
      finalize(session, resolve, { code, raw: text, timedOut, exited, timeoutMs })
    }

    session.capture = {
      feed(data) {
        raw += data
        const m = raw.match(endRe)
        if (m) done(parseInt(m[1], 10), {})
      },
      onExit(code) {
        done(typeof code === 'number' ? code : null, { exited: true })
      }
    }

    session.pty.write(`printf '__BEG_%s__\\n' ${token}\r`)
    session.pty.write(command + '\r')
    session.pty.write(`printf '__END_%s_%d__\\n' ${token} "$?"\r`)
    emitSessions()
  })
}

export function readSession({ id, maxBytes = 8000 }) {
  const s = sessions.get(id)
  if (!s) return { error: `No terminal "${id}". Use shell_list to see open terminals.` }
  return {
    sessionId: id,
    name: s.name,
    alive: s.alive,
    busy: !!s.capture,
    lastExit: s.lastExit,
    output: stripAnsi(s.scrollback).trimEnd().slice(-maxBytes)
  }
}

import { homedir, tmpdir, userInfo } from 'node:os'
import { writeFileSync, mkdirSync, lstatSync, statSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { app, BrowserWindow } from 'electron'

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
let mainAgentId = null // the terminal shell_run uses when no { terminal } is given (so cd / env persist)

// Agent terminals never open a pager (git log / man / journalctl would sit in `less` and shell_run
// would wait out its whole timeout), and turn off ! history expansion (see the rc file).
const AGENT_ENV = { PAGER: 'cat', GIT_PAGER: 'cat', MANPAGER: 'cat', SYSTEMD_PAGER: 'cat', LESS: '-FRX', GHOST_AGENT_TERMINAL: '1' }

// "~", "~/x" and relative paths mean the home folder, like everywhere else the agent names a path.
// A folder that doesn't exist is an error, not a terminal that dies on spawn.
function resolveCwd(cwd) {
  const raw = String(cwd ?? '').trim()
  if (!raw || raw === '~') return homedir()
  const p = raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : resolve(homedir(), raw)
  let ok = false
  try {
    ok = statSync(p).isDirectory()
  } catch {}
  if (!ok) throw new Error(`No such folder: ${raw}`)
  return p
}

// bash -n parses without running: an unclosed quote or a syntax error would otherwise leave the
// live terminal waiting at a "> " continuation prompt and shell_run hanging until its timeout.
function syntaxProblem(line) {
  try {
    const r = spawnSync('bash', ['-O', 'extglob', '-n', '-c', line], { encoding: 'utf8', timeout: 3000 })
    if (r.error || r.status === 0 || r.status == null) return ''
    return (r.stderr || 'syntax error').trim().split('\n').slice(-2).join(' ').replace(/^bash: (?:-c: )?(?:line \d+: )?/, '')
  } catch {
    return ''
  }
}

// Several lines typed into an interactive shell run as separate commands, and only the first one's
// output was captured. A { … } group runs them as ONE command in the same shell (cd still sticks).
function asOneCommand(command) {
  const cmd = String(command ?? '').replace(/\s+$/, '')
  return cmd.includes('\n') ? `{ ${cmd}\n}` : cmd
}

// Shell integration: bash emits OSC-133 semantic markers itself (invisible in the terminal) so we can
// tell where a command's output begins (C) and ends (D;<exit>) WITHOUT typing any marker commands
// that would echo into the user's view. We point bash at this rc file, which also sources the user's
// normal profile/bashrc so their prompt and aliases are intact.
//
// The file is sourced by every terminal, so it lives in a per-user private dir (userData, or a
// uid-scoped tmpdir fallback) with 0600 perms. The fallback path is predictable, so ensureRc()
// verifies the dir is a plain directory we own (no symlink, not group/other writable) and creates
// the file with O_EXCL, so a pre-planted dir or symlink can never redirect what bash sources.
let rcPath = null
function rcDir() {
  try {
    const d = app?.getPath?.('userData')
    if (d) return { dir: d, fallback: false }
  } catch {}
  let uid = 'u'
  try {
    uid = String(userInfo().uid ?? process.getuid?.() ?? 'u')
  } catch {}
  return { dir: join(tmpdir(), `ghost-prime-${uid}`), fallback: true }
}

// The tmpdir fallback lives at a predictable path in a shared directory, so mkdirSync({recursive})
// succeeding is not enough: another local user could have pre-created it (or planted a symlink)
// before we got there. Refuse anything that isn't a plain directory we own with no group/other
// write bit. userData is under the user's own config dir, so it only needs to be a directory.
function assertSafeDir(dir, fallback) {
  const st = lstatSync(dir)
  if (!fallback) {
    if (!(st.isDirectory() || (st.isSymbolicLink() && statSync(dir).isDirectory()))) throw new Error(`rc dir is not a directory: ${dir}`)
    return
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`unsafe rc dir (not a plain directory): ${dir}`)
  const uid = process.getuid?.()
  if (uid !== undefined && st.uid !== undefined && st.uid !== uid) throw new Error(`unsafe rc dir (owned by uid ${st.uid}, not ${uid}): ${dir}`)
  if (uid !== undefined && (st.mode & 0o022) !== 0) throw new Error(`unsafe rc dir (group/other writable): ${dir}`)
}
export function ensureRc() {
  if (rcPath) return rcPath
  const body = [
    '# Ghost-Prime shell integration (OSC 133 semantic prompts)',
    'if [ -r /etc/profile ]; then . /etc/profile; fi',
    'if [ -r "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi',
    '# Agent terminals: no ! history expansion, so text like "echo Done!" runs as written.',
    'if [ -n "${GHOST_AGENT_TERMINAL:-}" ]; then set +H; fi',
    "__ghost_done() { local e=$?; printf '\\033]133;D;%s\\007' \"$e\"; }",
    'case "${PROMPT_COMMAND:-}" in',
    '  *__ghost_done*) ;;',
    '  *) PROMPT_COMMAND="__ghost_done${PROMPT_COMMAND:+; $PROMPT_COMMAND}" ;;',
    'esac',
    "PS0='\\e]133;C\\a'",
    "printf '\\033]133;A\\007'",
    ''
  ].join('\n')
  const { dir, fallback } = rcDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  assertSafeDir(dir, fallback)
  const p = join(dir, 'shell-init.bash')
  // Remove whatever is there (a stale copy, or a planted symlink — rmSync unlinks the link itself,
  // never its target) and create fresh with O_EXCL: 'wx' cannot follow a symlink, so the content
  // always lands in a brand-new 0600 file we own. writeFileSync's mode applies at creation, and
  // we always create, so no follow-up chmod (which would follow symlinks) is needed.
  rmSync(p, { force: true })
  writeFileSync(p, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
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

// Every live chunk carries the session's sequence number AFTER appending it to the scrollback, so
// `getScrollback().seq` names exactly the last chunk the text already contains; the renderer writes
// only chunks with a higher seq after replaying history (no duplicated output on attach mid-stream).
function emitData(session, data) {
  session.seq += 1
  broadcast('shell:data', { id: session.id, data, seq: session.seq })
}

// ---- lifecycle -----------------------------------------------------------------------------------
export async function createSession({ name, cwd, cols = 80, rows = 24, agent = false } = {}) {
  const p = await loadPty()
  if (!p) throw new Error(`Terminal backend unavailable: ${ptyError?.message || 'node-pty failed to load'}`)

  const startCwd = resolveCwd(cwd)
  const n = ++counter
  const shell = p.spawn('bash', ['--init-file', ensureRc()], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: startCwd,
    env: { ...process.env, TERM: 'xterm-256color', GHOST_TERMINAL: '1', ...(agent ? AGENT_ENV : {}) }
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
    seq: 0, // increments per shell:data chunk so a re-attaching UI can drop chunks its scrollback already holds
    capture: null,
    fg: false, // a command is running in the foreground (OSC-133 C seen, no D yet) — e.g. a background server
    oscTail: '', // end of the previous chunk, so a marker split across two chunks is still seen
    osc: null, // null = unknown, true = OSC-133 integration live, false = fell back to printf markers
    lastExit: null // exit code once the shell process dies (so shell_list surfaces deaths)
  }

  shell.onData((data) => {
    session.scrollback = (session.scrollback + data).slice(-MAX_SCROLLBACK)
    // Integration is live the moment we see any OSC-133 marker (emitted on the first prompt). Look at
    // this chunk (plus the tail of the last one), not the scrollback's last 64 bytes: a long coloured
    // prompt printed after the marker used to push it out of view, costing an 8 s wait.
    const seen = session.oscTail + data
    session.oscTail = data.slice(-16)
    if (seen.includes('\x1b]133;')) {
      if (session.osc === null) session.osc = true
      const marks = [...seen.matchAll(/\x1b\]133;([ACD])/g)]
      if (marks.length) session.fg = marks[marks.length - 1][1] === 'C' // C = running, A/D = at the prompt
    }
    emitData(session, data)
    if (session.capture) session.capture.feed(data)
  })
  shell.onExit(({ exitCode }) => {
    session.alive = false
    session.lastExit = exitCode
    const note = `\r\n\x1b[2m[process exited: ${exitCode}]\x1b[0m\r\n`
    session.scrollback = (session.scrollback + note).slice(-MAX_SCROLLBACK) // re-attach shows the exit too
    emitData(session, note)
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
  const s = sessions.get(id)
  return { text: s?.scrollback || '', seq: s?.seq || 0 }
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
  const line = asOneCommand(command)
  if (!line.trim()) throw new Error('shell_run needs a command.')
  const bad = syntaxProblem(line)
  if (bad) throw new Error(`Not run: bash would reject this command line (${bad}). Fix the quoting or syntax and try again.`)

  let session = id ? sessions.get(id) : null
  let note = ''
  if (id && (!session || !session.alive)) note = `(terminal ${id} is closed, so this ran in a new one)\n`
  // No { terminal }: keep using the agent's main terminal, so cd / exported variables persist — unless
  // it is gone, capturing, or has a command running in the foreground (a server started earlier).
  if (!id) {
    const main = mainAgentId ? sessions.get(mainAgentId) : null
    if (main && main.alive && !main.capture && !main.fg) session = main
  }
  if (!session || !session.alive) {
    const created = await createSession({ name, cwd, agent: true })
    session = sessions.get(created.id)
    if (!id) mainAgentId = created.id
  }
  if (!session) throw new Error('Could not open a terminal session.')
  if (session.osc === null) await waitReady(session) // learn the capture method before running

  if (background) {
    session.fg = true // it now owns the foreground until its OSC D marker arrives
    session.pty.write(line + '\r')
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

  const r = await (session.osc ? captureOsc(session, line, timeoutMs) : capturePrintf(session, line, timeoutMs))
  return note ? { ...r, output: note + r.output } : r
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
    // If an earlier command is still running here (it timed out), ITS end marker arrives first and
    // must not be taken for ours; only a capture that starts at an idle prompt may finish early.
    let atPrompt = !session.fg
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
          if (!m) {
            if (!atPrompt) {
              // Skip the earlier command's end marker; keep only what follows it. From then on the
              // shell is at its prompt, so the next marker is ours.
              const prev = raw.match(endRe)
              if (prev) {
                raw = raw.slice(prev.index + prev[0].length)
                atPrompt = true
                return this.feed('') // our own markers may already be in the same chunk
              }
              return
            }
            // Back at the prompt without running anything (a comment-only line, input bash refused
            // before running it): finish now with whatever bash printed, instead of waiting it out.
            const early = raw.match(endRe)
            if (early) {
              raw = raw.slice(0, early.index)
              raw = raw.slice(raw.indexOf('\n') + 1) // drop the echoed command line
              done(early[1] != null ? parseInt(early[1], 10) : null, {})
            }
            return
          }
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

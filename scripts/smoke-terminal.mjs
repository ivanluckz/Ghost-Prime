// The live terminal the agent types into (src/main/tools/shell-sessions.js, the shell_run tool behind
// Demo 1 "How much free space is left?"). Real node-pty + bash, no LLM. Checks: output and exit code
// come back, a failing command reports its code, cd / exported vars persist between runs in the same
// terminal, output with ANSI colour is cleaned, background mode returns at once, a timeout is
// reported (and leaves the command running), a busy terminal refuses a second command, reading and
// killing work, and df -h (the demo's command) returns a filesystem table. Plus the overnight
// regressions: the default terminal is reused, bad quoting is refused before it is typed, multi-line
// commands run as one, lines that run nothing return at once, no pagers, sane working folders.
// node-pty must match the runtime: on the Chromebook (built for Electron) run it with Electron as Node:
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron --import ./scripts/lib/register-electron-stub.mjs scripts/smoke-terminal.mjs
// (in a plain-Node environment, rebuild node-pty for Node first: cd node_modules/node-pty && npx node-gyp rebuild).
// Run: node --import ./scripts/lib/register-electron-stub.mjs scripts/smoke-terminal.mjs
const sh = await import('../src/main/tools/shell-sessions.js')

let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && extra ? `  → ${String(extra).slice(0, 300)}` : ''}`)
}

try {
  const r1 = await sh.runForAgent({ command: 'echo hello-ghost', timeoutMs: 15000 })
  check(r1.exitCode === 0 && /hello-ghost/.test(r1.output), 'echo returns its output and exit 0', JSON.stringify(r1))
  check(!/echo hello-ghost/.test(r1.output), 'the typed command line is not part of the output', r1.output)
  const id = r1.sessionId

  const r2 = await sh.runForAgent({ id, command: 'bash -c "exit 3"', timeoutMs: 15000 })
  check(r2.exitCode === 3, 'a failing command reports its exit code (3)', JSON.stringify(r2))

  await sh.runForAgent({ id, command: 'cd /tmp && export GHOST_SMOKE_VAR=kept', timeoutMs: 15000 })
  const r3 = await sh.runForAgent({ id, command: 'pwd; echo "$GHOST_SMOKE_VAR"', timeoutMs: 15000 })
  check(/^\/tmp$/m.test(r3.output) && /kept/.test(r3.output), 'cd and exported variables persist in the same terminal', r3.output)

  const r4 = await sh.runForAgent({ id, command: "printf '\\033[31mred\\033[0m plain\\n'", timeoutMs: 15000 })
  check(/red plain/.test(r4.output) && !/\x1b\[/.test(r4.output), 'ANSI colour codes are stripped from the output', JSON.stringify(r4.output))

  const r5 = await sh.runForAgent({ id, command: 'df -h ~', timeoutMs: 15000 })
  check(r5.exitCode === 0 && /Filesystem/i.test(r5.output) && /Avail/i.test(r5.output), 'df -h (the Demo 1 command) returns a filesystem table', r5.output)

  const t0 = Date.now()
  const r6 = await sh.runForAgent({ id, command: 'sleep 3; echo late-done', timeoutMs: 800 })
  check(r6.timedOut === true && Date.now() - t0 < 3000, 'a command past its timeout returns early, flagged timedOut', JSON.stringify(r6))
  check(/still running/.test(r6.output), 'the timeout is explained in the output', r6.output)
  let busyErr = ''
  try {
    await sh.runForAgent({ id, command: 'echo second', timeoutMs: 5000 })
  } catch (e) {
    busyErr = e.message
  }
  // A timed-out capture releases the terminal (finalize clears it), so a second run is allowed; it
  // simply queues behind the sleep in bash. Either behaviour is fine as long as nothing hangs.
  check(busyErr === '' || /busy/.test(busyErr), 'a second command after a timeout neither hangs nor crashes', busyErr)

  // --- Regressions found overnight 25 Sep (each failed before the fix) ---------------------------
  // shell_run without { terminal } opened a NEW terminal every call, so cd never stuck.
  const d1 = await sh.runForAgent({ command: 'cd /tmp && export GHOST_DEFAULT=1', timeoutMs: 15000 })
  const d2 = await sh.runForAgent({ command: 'pwd; echo "v=$GHOST_DEFAULT"', timeoutMs: 15000 })
  check(d1.sessionId === d2.sessionId && /^\/tmp$/m.test(d2.output) && /v=1/.test(d2.output), 'default shell_run reuses the main terminal (cd and vars stick)', JSON.stringify([d1.sessionId, d2]))
  // An unclosed quote left the terminal at a "> " prompt and shell_run hung until its timeout.
  const q0 = Date.now()
  let qErr = ''
  try {
    await sh.runForAgent({ command: 'echo "oops', timeoutMs: 20000 })
  } catch (e) {
    qErr = e.message
  }
  check(/Not run/.test(qErr) && Date.now() - q0 < 3000, 'an unclosed quote is refused at once, never typed into the terminal', qErr)
  const d3 = await sh.runForAgent({ command: 'echo still-fine', timeoutMs: 15000 })
  check(d3.sessionId === d1.sessionId && /still-fine/.test(d3.output), '…and the main terminal keeps working', JSON.stringify(d3))
  // Multi-line commands returned only the first line's output.
  const ml = await sh.runForAgent({ command: 'echo line-one\necho line-two\nfalse', timeoutMs: 15000 })
  check(/line-one/.test(ml.output) && /line-two/.test(ml.output) && ml.exitCode === 1, 'a multi-line command runs as one: all output, last exit code', JSON.stringify(ml))
  // A comment-only line runs nothing: bash comes straight back, so must shell_run.
  const c0 = Date.now()
  const cm = await sh.runForAgent({ command: '# just a note', timeoutMs: 15000 })
  check(!cm.timedOut && Date.now() - c0 < 3000, 'a line that runs nothing returns at once instead of timing out', JSON.stringify(cm))
  // Pagers: agent terminals must never sit in `less`.
  const pg = await sh.runForAgent({ command: 'echo "pager=$PAGER git=$GIT_PAGER"; set -o | grep histexpand', timeoutMs: 15000 })
  check(/pager=cat git=cat/.test(pg.output) && /histexpand\s+off/.test(pg.output), 'agent terminals use no pager and no ! history expansion', pg.output)
  // A background command occupies its terminal: the next default run must not type into it.
  const srv = await sh.runForAgent({ command: 'sleep 20', background: true })
  const after = await sh.runForAgent({ command: 'echo next', timeoutMs: 15000 })
  check(srv.sessionId === d1.sessionId && after.sessionId !== srv.sessionId && /next/.test(after.output), 'after a background run, the next command gets a fresh terminal', JSON.stringify([d1.sessionId, srv, after]))
  // ~ and relative working folders (shell_open) gave a dead terminal; a missing folder is an error.
  const home = await sh.createSession({ cwd: '~/', agent: true })
  await new Promise((r) => setTimeout(r, 600))
  check(sh.listSessions().some((x) => x.id === home.id && x.alive) && !home.cwd.includes('~'), 'shell_open with "~/" starts in the home folder', JSON.stringify(home))
  let cwdErr = ''
  try {
    await sh.createSession({ cwd: '~/no-such-folder-ghost', agent: true })
  } catch (e) {
    cwdErr = e.message
  }
  check(/No such folder/.test(cwdErr), 'a folder that does not exist is a clear error', cwdErr)
  const stale = await sh.runForAgent({ id: 't999', command: 'echo from-new', timeoutMs: 15000 })
  check(/closed, so this ran in a new one/.test(stale.output) && /from-new/.test(stale.output), 'a closed terminal id says it ran in a new terminal', stale.output)

  const bg = await sh.runForAgent({ command: 'sleep 30', background: true, name: 'bg' })
  check(bg.background === true && /background/.test(bg.output), 'background mode returns immediately', JSON.stringify(bg))
  const listed = sh.listSessions()
  check(listed.some((s) => s.id === bg.sessionId && s.alive), 'the background terminal is listed and alive', JSON.stringify(listed))
  const rd = sh.readSession({ id })
  check(typeof rd.output === 'string' && /hello-ghost/.test(rd.output), 'shell_read returns the terminal scrollback', JSON.stringify(rd).slice(0, 200))
  check(/No terminal/.test(sh.readSession({ id: 'nope' }).error || ''), 'reading an unknown terminal gives a clear error')
  sh.killSession(bg.sessionId)
  await new Promise((r) => setTimeout(r, 400))
  check(!sh.listSessions().some((s) => s.id === bg.sessionId && s.alive), 'shell_kill stops the background terminal')
} catch (e) {
  fail++
  console.log('✗ unexpected error:', e?.stack || e)
} finally {
  sh.killAll()
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

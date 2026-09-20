import { spawn } from 'node:child_process'
import { homedir } from 'node:os'

// Run a shell command and capture its output. No native deps — reliable in the
// Crostini container. (node-pty upgrade later for interactive/streaming sessions.)
// Resolves { code, exitCode, timedOut, stdout, stderr }; `code` is null when the shell was
// killed by a signal (the timeout or an abort).
export function runCommand({ command, cwd, timeoutMs = 30000, signal }) {
  return new Promise((resolve) => {
    // detached => own process group, so the timeout kills the whole tree (pipelines, `cmd &`,
    // dev servers), not just bash — otherwise grandchildren keep the pipes open and 'close'
    // never fires.
    const child = spawn('bash', ['-lc', command], { cwd: cwd || homedir(), detached: true })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let exited = false
    let done = false
    let grace = null

    const killGroup = () => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
      try {
        child.kill('SIGKILL')
      } catch {}
    }
    const finish = (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearTimeout(grace)
      signal?.removeEventListener('abort', onAbort)
      resolve({
        code,
        exitCode: code,
        timedOut,
        // Cap output so a chatty command can't blow up the model context.
        stdout: stdout.slice(-20000),
        stderr: stderr.slice(-8000)
      })
      // If a backgrounded grandchild (`npm run dev &`) still holds the pipes, stop collecting its
      // output — otherwise the closure strings grow for as long as it lives. resume() keeps the
      // pipe drained so it isn't blocked on a full buffer (no destroy: an EPIPE would kill a
      // server the user wants), and unref() lets the main process exit without waiting on it.
      for (const s of [child.stdout, child.stderr]) {
        s?.removeAllListeners('data')
        s?.resume()
      }
      child.unref()
    }
    const onAbort = () => {
      killGroup()
      finish(null)
    }

    const timer = setTimeout(() => {
      if (exited) return
      timedOut = true
      killGroup()
    }, timeoutMs)
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    // 'close' normally follows 'exit' almost immediately; if a backgrounded grandchild (or a
    // daemon that setsid()'d out of the group) is still holding the pipes, stop waiting after a
    // short grace period rather than hanging the agent turn.
    child.on('exit', (code) => {
      exited = true
      grace = setTimeout(() => finish(code), 250)
    })
    child.on('close', (code) => finish(code))
    child.on('error', (err) => {
      stderr += String(err?.message || err)
      finish(-1)
    })
  })
}

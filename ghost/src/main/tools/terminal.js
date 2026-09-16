import { spawn } from 'node:child_process'
import { homedir } from 'node:os'

// Run a shell command and capture its output. No native deps — reliable in the
// Crostini container. (node-pty upgrade later for interactive/streaming sessions.)
export function runCommand({ command, cwd, timeoutMs = 30000 }) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], { cwd: cwd || homedir() })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        code,
        timedOut,
        // Cap output so a chatty command can't blow up the model context.
        stdout: stdout.slice(-20000),
        stderr: stderr.slice(-8000)
      })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: -1, timedOut, stdout, stderr: String(err?.message || err) })
    })
  })
}

#!/usr/bin/env node
// Runs automatically after every `npm run build` (npm postbuild hook). Commits any pending changes
// and pushes the current branch to GitHub so the latest build is always backed up on the remote.
//
// COMMIT MESSAGE — "what did you change?" (so GitHub shows a real summary, not just a timestamp):
//   1. GHOST_PUSH_MSG env var       →  GHOST_PUSH_MSG="reworked the sidebar" npm run build
//   2. COMMIT_MSG.txt at repo root  →  type your summary in that file, then `npm run build`
//                                      (the file is cleared back to its template after each push)
//   3. otherwise a default          →  build: v<version> · <stamp>
//
// It NEVER fails the build — a problem (offline, no remote, nothing to commit) just prints a note.
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const sh = (cmd, opts = {}) => execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], ...opts }).toString().trim()
const tag = '[push-after-build]'
const msgFile = new URL('../COMMIT_MSG.txt', import.meta.url)

// The empty "field" we leave behind so there's always something to type into next time.
const TEMPLATE = `# Ghost-Prime — what did you change?  (the first line becomes the GitHub commit message)
# Type a short summary below, then run:  npm run build
# Lines starting with # are ignored. This file is cleared automatically after each push.

`

// A human "what changed" summary, from the env var (highest priority) or the COMMIT_MSG.txt field.
function userMessage() {
  const env = (process.env.GHOST_PUSH_MSG || '').trim()
  if (env) return { text: env, source: 'env' }
  try {
    if (existsSync(msgFile)) {
      const body = readFileSync(msgFile, 'utf8')
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('#'))
        .join('\n')
        .trim()
      if (body) return { text: body, source: 'file' }
    }
  } catch {}
  return null
}

try {
  sh('git rev-parse --is-inside-work-tree') // throws if not a git repo → caught below

  const dirty = sh('git status --porcelain')
  if (dirty) {
    let version = '?'
    try {
      version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version
    } catch {}
    const stamp = new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })

    const um = userMessage()
    let message
    if (um) {
      const lines = um.text.split('\n')
      const subject = lines[0].slice(0, 200)
      const extra = lines.slice(1).join('\n').trim()
      // <subject> \n\n [extra…] \n\n v<version> · <stamp> \n\n Co-Authored-By
      message =
        `${subject}\n\n${extra ? extra + '\n\n' : ''}v${version} · ${stamp}\n\n` +
        `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
    } else {
      message = `build: v${version} · ${stamp}\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
    }

    // Refuse to sweep secrets into the auto-commit: any .env / .env.* copy (except .env.example)
    // or the Jarvis API-key file. Throwing here skips BOTH the commit and the push.
    const SECRET_PATH = /(^|\/)\.env(\.|$)/
    const leaked = sh('git status --porcelain --untracked-files=all')
      .split('\n')
      .filter((l) => l && !l.slice(0, 2).includes('D')) // a deletion (e.g. git rm --cached) is fine to commit
      .map((l) => l.slice(3).trim().replace(/^.* -> /, '').replace(/^"|"$/g, ''))
      .filter((p) => (SECRET_PATH.test(p) && !p.endsWith('.env.example')) || p === 'jarvis/config/api_keys.json')
    if (leaked.length) {
      throw new Error(`refusing to commit secret file(s): ${leaked.join(', ')} — add them to .gitignore / git rm --cached first`)
    }

    sh('git add -A')
    // -F - reads the message from stdin, so we never have to shell-escape it.
    execSync('git commit -F -', { input: message, stdio: ['pipe', 'pipe', 'pipe'] })
    console.log(`${tag} committed: ${message.split('\n')[0]}${um ? ` (from ${um.source})` : ''}`)

    // Clear the field so the next build doesn't reuse a stale message.
    if (um?.source === 'file') {
      try {
        writeFileSync(msgFile, TEMPLATE)
      } catch {}
    }
  } else {
    console.log(`${tag} working tree clean — nothing to commit`)
  }

  try {
    sh('git push origin HEAD')
    console.log(`${tag} pushed to origin ✓`)
  } catch (e) {
    console.warn(`${tag} push skipped: ${String(e.message || e).split('\n')[0]}`)
  }
} catch (e) {
  console.warn(`${tag} skipped: ${String(e.message || e).split('\n')[0]}`)
}

#!/usr/bin/env node
// Runs automatically after every `npm run build` (npm postbuild hook). Commits any pending changes
// and pushes the current branch to GitHub so the latest build is always backed up on the remote.
// It NEVER fails the build — a problem (offline, no remote, nothing to commit) just prints a note.
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const sh = (cmd, opts = {}) => execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], ...opts }).toString().trim()
const tag = '[push-after-build]'

try {
  sh('git rev-parse --is-inside-work-tree') // throws if not a git repo → caught below

  const dirty = sh('git status --porcelain')
  if (dirty) {
    let version = '?'
    try {
      version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version
    } catch {}
    const stamp = new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    sh('git add -A')
    // -F - reads the message from stdin, so we never have to shell-escape it.
    execSync('git commit -F -', {
      input: `build: v${version} · ${stamp}\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    console.log(`${tag} committed pending changes (v${version} · ${stamp})`)
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

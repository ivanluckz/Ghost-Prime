// Reversible file operations + an in-memory undo stack. The agent uses these instead of raw
// writes when the user might want to take an action back — moves, renames, creates, deletes and
// content writes all snapshot what they replaced, so "undo that" restores it. Snapshots live in
// a trash dir under userData; the stack itself just holds closures (nothing runs until undo).
import { promises as fs } from 'node:fs'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'

const MAX_STACK = 50
const stack = [] // { id, label, at, backup, undo: async () => void }
let trashPurged = false

function trashDir() {
  const d = join(app.getPath('userData'), 'undo-trash')
  if (!trashPurged) {
    // Stack is in-memory only, so anything left from a previous process is orphaned.
    trashPurged = true
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

// Expand ~ and resolve relative paths against $HOME — the agent's cwd everywhere else
// (terminal_run, shell sessions, the Claude SDK query). process.cwd() is the app repo because
// the launcher cd's there, which is never what the user means. Shared with files.js.
export function resolvePath(p) {
  const s = String(p || '').trim()
  if (!s || s === '.' || s === '~') return homedir()
  if (s.startsWith('~/')) return join(homedir(), s.slice(2))
  return resolve(homedir(), s) // absolute paths pass through unchanged
}

// Mutating ops must never inherit the search tools' "empty means $HOME" default — a blank
// `path` from a malformed tool call would otherwise target the home directory itself.
function requirePath(p) {
  if (!String(p ?? '').trim()) throw new Error('path is required')
  return resolvePath(p)
}

// Best-effort: cleanup failures must never fail the user-visible operation.
async function discardBackup(backup) {
  if (!backup) return
  try { await fs.rm(backup, { force: true }) } catch {}
}

function push(label, undo, backup = null) {
  stack.push({ id: randomUUID(), label, at: Date.now(), backup, undo })
  while (stack.length > MAX_STACK) {
    const dropped = stack.shift()
    void discardBackup(dropped.backup)
  }
  return label
}

async function snapshot(path) {
  const dest = join(trashDir(), `${randomUUID()}-${basename(path)}`)
  await fs.copyFile(path, dest)
  return dest
}

export async function writeFile(path, content = '') {
  const p = requirePath(path)
  const existed = existsSync(p)
  if (existed && (await fs.stat(p)).isDirectory()) throw new Error(`${p} is a directory — refusing`)
  const backup = existed ? await snapshot(p) : null
  try {
    await fs.mkdir(dirname(p), { recursive: true })
    await fs.writeFile(p, String(content))
  } catch (err) {
    await discardBackup(backup) // nothing to undo, don't orphan the snapshot
    throw err
  }
  push(`write ${p}`, async () => {
    if (existed && backup) await fs.copyFile(backup, p)
    else await fs.rm(p, { force: true })
  }, backup)
  return `Wrote ${p}${existed ? ' (previous version can be undone)' : ' (new file; undo removes it)'}`
}

export async function createFile(path, content = '') {
  const p = requirePath(path)
  if (existsSync(p)) throw new Error(`already exists: ${p} (use file_write to overwrite)`)
  await fs.mkdir(dirname(p), { recursive: true })
  await fs.writeFile(p, String(content))
  push(`create ${p}`, async () => fs.rm(p, { force: true }))
  return `Created ${p} (undo removes it)`
}

export async function deleteFile(path) {
  const p = requirePath(path)
  if (!existsSync(p)) throw new Error(`not found: ${p}`)
  const st = await fs.stat(p)
  if (st.isDirectory()) throw new Error(`${p} is a directory — refusing (undo only covers files)`)
  const backup = await snapshot(p)
  await fs.rm(p, { force: true })
  push(`delete ${p}`, async () => fs.copyFile(backup, p), backup)
  return `Deleted ${p} (undo restores it)`
}

// rename() can't cross filesystems (e.g. ~ → the Chrome OS 9p share); fall back to copy + rm.
async function moveAny(from, to) {
  try { await fs.rename(from, to) }
  catch (err) {
    if (err.code !== 'EXDEV') throw err
    await fs.cp(from, to, { recursive: true, force: true, errorOnExist: false })
    await fs.rm(from, { recursive: true, force: true })
  }
}

export async function moveFile(src, dst) {
  const s = requirePath(src)
  let d = requirePath(dst)
  if (s === homedir()) throw new Error('refusing to move the home directory')
  if (!existsSync(s)) throw new Error(`not found: ${s}`)
  // Files only: the EXDEV copy+rm fallback would make a half-copied directory move irreversible.
  if ((await fs.stat(s)).isDirectory()) throw new Error(`${s} is a directory — refusing (undo only covers files)`)
  // "move report.pdf to ~/Downloads" — a directory destination means "into", like mv.
  if (existsSync(d) && (await fs.stat(d)).isDirectory()) d = join(d, basename(s))
  if (s === d) return `Already at ${d}`
  if (existsSync(d) && (await fs.stat(d)).isDirectory()) throw new Error(`${d} is a directory — refusing to overwrite it`)
  const overwrote = existsSync(d) ? await snapshot(d) : null
  try {
    await fs.mkdir(dirname(d), { recursive: true })
    await moveAny(s, d)
  } catch (err) {
    await discardBackup(overwrote)
    throw err
  }
  push(`move ${s} → ${d}`, async () => {
    await moveAny(d, s)
    if (overwrote) await fs.copyFile(overwrote, d)
  }, overwrote)
  return `Moved ${s} → ${d} (undo puts it back)`
}

export async function undoLast() {
  const entry = stack.pop()
  if (!entry) throw new Error('nothing to undo')
  await entry.undo()
  await discardBackup(entry.backup) // only after the restore succeeded
  return `Undid: ${entry.label}`
}

export function undoList() {
  if (!stack.length) return 'Undo stack is empty.'
  return stack
    .slice()
    .reverse()
    .map((e, i) => `${i + 1}. ${e.label}  (${new Date(e.at).toLocaleTimeString()})`)
    .join('\n')
}

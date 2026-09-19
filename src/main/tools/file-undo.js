// Reversible file operations + an in-memory undo stack. The agent uses these instead of raw
// writes when the user might want to take an action back — moves, renames, creates, deletes and
// content writes all snapshot what they replaced, so "undo that" restores it. Snapshots live in
// a trash dir under userData; the stack itself just holds closures (nothing runs until undo).
import { promises as fs } from 'node:fs'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'

const MAX_STACK = 50
const stack = [] // { id, label, at, undo: async () => void }

function trashDir() {
  const d = join(app.getPath('userData'), 'undo-trash')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

// Expand ~ and resolve relative paths against $HOME (the agent's cwd).
function resolvePath(p) {
  let s = String(p || '').trim()
  if (!s) throw new Error('path is required')
  if (s === '~') s = homedir()
  else if (s.startsWith('~/')) s = join(homedir(), s.slice(2))
  return resolve(homedir(), s)
}

function push(label, undo) {
  stack.push({ id: randomUUID(), label, at: Date.now(), undo })
  while (stack.length > MAX_STACK) stack.shift()
  return label
}

async function snapshot(path) {
  const dest = join(trashDir(), `${randomUUID()}-${basename(path)}`)
  await fs.copyFile(path, dest)
  return dest
}

export async function writeFile(path, content = '') {
  const p = resolvePath(path)
  const existed = existsSync(p)
  const backup = existed ? await snapshot(p) : null
  await fs.mkdir(dirname(p), { recursive: true })
  await fs.writeFile(p, String(content))
  push(`write ${p}`, async () => {
    if (existed && backup) await fs.copyFile(backup, p)
    else await fs.rm(p, { force: true })
  })
  return `Wrote ${p}${existed ? ' (previous version can be undone)' : ' (new file; undo removes it)'}`
}

export async function createFile(path, content = '') {
  const p = resolvePath(path)
  if (existsSync(p)) throw new Error(`already exists: ${p} (use write_file to overwrite)`)
  await fs.mkdir(dirname(p), { recursive: true })
  await fs.writeFile(p, String(content))
  push(`create ${p}`, async () => fs.rm(p, { force: true }))
  return `Created ${p} (undo removes it)`
}

export async function deleteFile(path) {
  const p = resolvePath(path)
  if (!existsSync(p)) throw new Error(`not found: ${p}`)
  const st = await fs.stat(p)
  if (st.isDirectory()) throw new Error(`${p} is a directory — refusing (undo only covers files)`)
  const backup = await snapshot(p)
  await fs.rm(p, { force: true })
  push(`delete ${p}`, async () => fs.copyFile(backup, p))
  return `Deleted ${p} (undo restores it)`
}

export async function moveFile(src, dst) {
  const s = resolvePath(src)
  const d = resolvePath(dst)
  if (!existsSync(s)) throw new Error(`not found: ${s}`)
  const overwrote = existsSync(d) ? await snapshot(d) : null
  await fs.mkdir(dirname(d), { recursive: true })
  await fs.rename(s, d)
  push(`move ${s} → ${d}`, async () => {
    await fs.rename(d, s)
    if (overwrote) await fs.copyFile(overwrote, d)
  })
  return `Moved ${s} → ${d} (undo puts it back)`
}

export async function undoLast() {
  const entry = stack.pop()
  if (!entry) throw new Error('nothing to undo')
  await entry.undo()
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

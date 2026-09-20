import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
// Shared resolver: relative paths land in $HOME, same as file_create/move/delete and the shells.
import { resolvePath } from './file-undo.js'

const execFileAsync = promisify(execFile)
const MAX_BUFFER = 8 * 1024 * 1024
// The default directory is $HOME, so an unbounded recursive search can run for minutes.
const SEARCH_TIMEOUT_MS = 30_000
const EXEC_OPTS = { maxBuffer: MAX_BUFFER, timeout: SEARCH_TIMEOUT_MS }
const timedOut = (err) => err.killed || err.signal === 'SIGTERM'

function firstLines(text, n = 50) {
  return text.split('\n').filter(Boolean).slice(0, n)
}

export async function fileRead({ path, offset = 1, limit = 500 } = {}) {
  try {
    const fullPath = resolvePath(path)
    if (!existsSync(fullPath)) return { error: `File not found: ${path}` }
    const stat = statSync(fullPath)
    if (stat.isDirectory()) return { error: `Path is a directory: ${path}. Use file_search instead.` }

    const raw = readFileSync(fullPath, 'utf8')
    const lines = raw.split('\n')
    const start = Math.max(1, parseInt(offset, 10) || 1)
    const count = Math.min(lines.length, parseInt(limit, 10) || 500)
    const slice = lines.slice(start - 1, start - 1 + count)

    return {
      path: fullPath,
      total_lines: lines.length,
      start_line: start,
      lines_returned: slice.length,
      content: slice.map((l, i) => `${start + i}: ${l}`).join('\n')
    }
  } catch (err) {
    return { error: `Failed to read file: ${err.message}` }
  }
}

export async function fileWrite({ path, content } = {}) {
  try {
    const fullPath = resolvePath(path)
    mkdirSync(dirname(fullPath), { recursive: true })
    writeFileSync(fullPath, content ?? '', 'utf8')
    return { success: true, path: fullPath, bytes: Buffer.byteLength(content ?? '', 'utf8') }
  } catch (err) {
    return { error: `Failed to write file: ${err.message}` }
  }
}

export async function fileEdit({ path, old_text, new_text } = {}) {
  try {
    const fullPath = resolvePath(path)
    if (!existsSync(fullPath)) return { error: `File not found: ${path}` }
    const original = readFileSync(fullPath, 'utf8')
    if (!original.includes(old_text)) {
      return { error: `Target text not found in ${path}. Ensure whitespace matches exactly.` }
    }
    // Replacer function so `$&`, `$$`, `$'` etc. in new_text are inserted literally.
    const updated = original.replace(old_text, () => new_text)
    writeFileSync(fullPath, updated, 'utf8')
    return { success: true, path: fullPath, message: `Replaced text successfully in ${path}` }
  } catch (err) {
    return { error: `Failed to edit file: ${err.message}` }
  }
}

// Both search tools go through execFile with argv arrays — no shell ever sees pattern/directory/path.
export async function fileSearch({ pattern = '*', directory = '.' } = {}) {
  try {
    const base = resolvePath(directory)
    let stdout = ''
    try {
      ;({ stdout } = await execFileAsync('find', [base, '-maxdepth', '4', '-name', String(pattern)], EXEC_OPTS))
    } catch (err) {
      if (timedOut(err)) return { error: `Search timed out after ${SEARCH_TIMEOUT_MS / 1000}s — narrow \`directory\`` }
      // find exits non-zero on unreadable subdirs but still prints matches; keep partial output
      stdout = err.stdout || ''
      if (!stdout && err.code !== 1) throw err
    }
    const files = firstLines(stdout)
    return { count: files.length, files }
  } catch (err) {
    return { error: `Search failed: ${err.message}` }
  }
}

export async function fileGrep({ pattern, directory = '.', path = null } = {}) {
  try {
    if (typeof pattern !== 'string' || !pattern) return { error: 'pattern is required' }
    const target = path ? resolvePath(path) : resolvePath(directory)
    const args = path
      ? ['-n', '-C', '2', '-i', '--', pattern, target]
      : ['-rn', '-C', '1', '-i',
         '--exclude-dir=node_modules', '--exclude-dir=.git', '--exclude-dir=dist', '--exclude-dir=out',
         '--exclude-dir=.cache', '--exclude-dir=.npm', '--exclude-dir=.local',
         '--', pattern, target]
    let stdout = ''
    try {
      ;({ stdout } = await execFileAsync('grep', args, EXEC_OPTS))
    } catch (err) {
      if (timedOut(err)) return { error: `Grep timed out after ${SEARCH_TIMEOUT_MS / 1000}s — narrow \`directory\`` }
      if (err.code === 1) stdout = ''            // grep: no matches
      else stdout = err.stdout || ''             // ENOBUFS / partial output — keep what we got
      if (!stdout && err.code !== 1) return { error: `Grep failed: ${err.message}` }
    }
    const matches = firstLines(stdout).join('\n')
    return { matches: matches || 'No matches found.' }
  } catch (err) {
    return { error: `Grep failed: ${err.message}` }
  }
}

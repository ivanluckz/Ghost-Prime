import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { resolve, join, dirname, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

function resolvePath(p) {
  if (!p) return process.cwd()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  if (isAbsolute(p)) return p
  return resolve(process.cwd(), p)
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
    const updated = original.replace(old_text, new_text)
    writeFileSync(fullPath, updated, 'utf8')
    return { success: true, path: fullPath, message: `Replaced text successfully in ${path}` }
  } catch (err) {
    return { error: `Failed to edit file: ${err.message}` }
  }
}

export async function fileSearch({ pattern = '*', directory = '.' } = {}) {
  try {
    const base = resolvePath(directory)
    const { stdout } = await execAsync(`find "${base}" -maxdepth 4 -name "${pattern}" 2>/dev/null | head -n 50`)
    const files = stdout.trim().split('\n').filter(Boolean)
    return { count: files.length, files }
  } catch (err) {
    return { error: `Search failed: ${err.message}` }
  }
}

export async function fileGrep({ pattern, directory = '.', path = null } = {}) {
  try {
    const target = path ? resolvePath(path) : resolvePath(directory)
    const cmd = path
      ? `grep -n -C 2 -i "${pattern.replace(/"/g, '\\"')}" "${target}" 2>/dev/null | head -n 50`
      : `grep -rn -C 1 -i --exclude-dir={node_modules,.git,dist,out} "${pattern.replace(/"/g, '\\"')}" "${target}" 2>/dev/null | head -n 50`
    const { stdout } = await execAsync(cmd).catch(() => ({ stdout: '' }))
    return { matches: stdout.trim() || 'No matches found.' }
  } catch (err) {
    return { error: `Grep failed: ${err.message}` }
  }
}

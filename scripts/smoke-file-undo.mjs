// Reversible file tools + undo (src/main/tools/file-undo.js), the tools behind Demo 2 ("make me a
// revision plan in a new folder called Showcase… actually, undo that"). Runs against a throwaway
// $HOME, no LLM. Covers create/undo, delete/undo (content restored), move into a folder/undo,
// overwrite/undo (previous content back), undo order (last in, first out), an empty stack, and the
// refusals that keep undo honest (directories, blank paths, overwriting with create).
// Run: node --import ./scripts/lib/register-electron-stub.mjs scripts/smoke-file-undo.mjs
import { mkdtempSync, existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const HOME = mkdtempSync(join(tmpdir(), 'ghost-undo-home-'))
process.env.HOME = HOME // os.homedir() reads $HOME on Linux; set before the module resolves paths
const fu = await import('../src/main/tools/file-undo.js')

let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && extra ? `  → ${String(extra).slice(0, 300)}` : ''}`)
}
const rejects = async (p) => {
  try {
    await p
    return ''
  } catch (e) {
    return e.message || String(e)
  }
}

try {
  const plan = join(HOME, 'Showcase', 'chemistry-revision-plan.txt')
  const msg = await fu.createFile('~/Showcase/chemistry-revision-plan.txt', 'Day 1 learn\nDay 2 practise\nDay 3 test yourself\n')
  check(existsSync(plan) && /Created/.test(msg), 'create makes the file inside a new Showcase folder', msg)
  check(/create .*chemistry-revision-plan\.txt/.test(fu.undoList()), 'undo_list shows the create')
  const u1 = await fu.undoLast()
  check(!existsSync(plan) && /Undid: create/.test(u1), 'undo removes the created file (Demo 2)', u1)

  writeFileSync(join(HOME, 'notes.txt'), 'original notes')
  await fu.deleteFile('notes.txt')
  check(!existsSync(join(HOME, 'notes.txt')), 'delete removes the file')
  await fu.undoLast()
  check(readFileSync(join(HOME, 'notes.txt'), 'utf8') === 'original notes', 'undo restores a deleted file with its content')

  mkdirSync(join(HOME, 'Screenshots'))
  writeFileSync(join(HOME, 'shot1.png'), 'png-bytes')
  const mv = await fu.moveFile('~/shot1.png', '~/Screenshots')
  check(existsSync(join(HOME, 'Screenshots', 'shot1.png')) && !existsSync(join(HOME, 'shot1.png')), 'move into a folder works like mv', mv)
  await fu.undoLast()
  check(existsSync(join(HOME, 'shot1.png')) && !existsSync(join(HOME, 'Screenshots', 'shot1.png')), 'undo puts a moved file back')

  await fu.writeFile('~/notes.txt', 'rewritten')
  check(readFileSync(join(HOME, 'notes.txt'), 'utf8') === 'rewritten', 'write overwrites')
  await fu.undoLast()
  check(readFileSync(join(HOME, 'notes.txt'), 'utf8') === 'original notes', 'undo brings the previous version back')

  // Last in, first out.
  await fu.createFile('~/a.txt', 'a')
  await fu.createFile('~/b.txt', 'b')
  await fu.undoLast()
  check(existsSync(join(HOME, 'a.txt')) && !existsSync(join(HOME, 'b.txt')), 'undo takes back the most recent change first')
  await fu.undoLast()
  check(!existsSync(join(HOME, 'a.txt')), 'a second undo takes back the one before')

  check(/nothing to undo/.test(await rejects(fu.undoLast())), 'undo with nothing left says so')
  check(/Undo stack is empty/.test(fu.undoList()), 'undo_list says the stack is empty')

  check(/directory/.test(await rejects(fu.deleteFile('~/Screenshots'))), 'deleting a folder is refused (undo only covers files)')
  check(/path is required/.test(await rejects(fu.deleteFile(''))), 'a blank path is refused, never the home folder')
  check(/already exists/.test(await rejects(fu.createFile('~/notes.txt', 'x'))), 'create refuses to overwrite an existing file')
  check(readFileSync(join(HOME, 'notes.txt'), 'utf8') === 'original notes', '…and leaves it untouched')
  check(/refusing to move the home directory/.test(await rejects(fu.moveFile('~', '~/elsewhere'))), 'moving the home folder is refused')
} catch (e) {
  fail++
  console.log('✗ unexpected error:', e?.stack || e)
} finally {
  rmSync(HOME, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

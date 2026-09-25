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

  // --- Regression (overnight 25 Sep): undo must not destroy changes made AFTER the step it undoes.
  // Claude edits files with its own Edit tool, which is not on the undo stack: "undo that" after an
  // edit used to pop the earlier create and delete the file, edits and all.
  await fu.createFile('~/essay.txt', 'first draft')
  writeFileSync(join(HOME, 'essay.txt'), 'first draft + two hours of edits') // an edit outside the undo tools
  const refused = await rejects(fu.undoLast())
  check(/changed since/.test(refused) && existsSync(join(HOME, 'essay.txt')), 'undo refuses to delete a created file that was edited since', refused)
  check(readFileSync(join(HOME, 'essay.txt'), 'utf8').includes('two hours'), '…and the edits are kept')
  check(/create .*essay\.txt/.test(fu.undoList()), '…and the step stays on the undo list')
  writeFileSync(join(HOME, 'essay.txt'), 'first draft') // back to what the step created
  await fu.undoLast()
  check(!existsSync(join(HOME, 'essay.txt')), 'once the file matches again, undo works')

  writeFileSync(join(HOME, 'report.txt'), 'v1')
  await fu.writeFile('~/report.txt', 'v2')
  writeFileSync(join(HOME, 'report.txt'), 'v3 typed by hand')
  check(/changed since/.test(await rejects(fu.undoLast())) && readFileSync(join(HOME, 'report.txt'), 'utf8') === 'v3 typed by hand', 'undoing a rewrite never overwrites later changes')
  writeFileSync(join(HOME, 'report.txt'), 'v2')
  await fu.undoLast()
  check(readFileSync(join(HOME, 'report.txt'), 'utf8') === 'v1', 'a clean rewrite still undoes to the previous version')

  writeFileSync(join(HOME, 'old.txt'), 'old')
  await fu.deleteFile('~/old.txt')
  writeFileSync(join(HOME, 'old.txt'), 'a NEW file with the same name')
  check(/changed since|exists again/.test(await rejects(fu.undoLast())) && readFileSync(join(HOME, 'old.txt'), 'utf8').startsWith('a NEW'), 'undoing a delete never overwrites a new file of the same name')
  rmSync(join(HOME, 'old.txt'))
  await fu.undoLast()
  check(readFileSync(join(HOME, 'old.txt'), 'utf8') === 'old', 'with the name free again, the deleted file comes back')

  // A destination ending in "/" means "into this folder", even before the folder exists.
  writeFileSync(join(HOME, 'plan.txt'), 'plan')
  const mvMsg = await fu.moveFile('~/plan.txt', '~/Showcase2/')
  check(readFileSync(join(HOME, 'Showcase2', 'plan.txt'), 'utf8') === 'plan', 'moving into a new folder ("~/Showcase2/") creates it and keeps the file name', mvMsg)
  await fu.undoLast()
  check(existsSync(join(HOME, 'plan.txt')), '…and undo puts it back')
  writeFileSync(join(HOME, 'plan2.txt'), 'plan2')
  await fu.moveFile(join(HOME, 'plan2.txt'), join(HOME, 'Abs') + '/')
  check(existsSync(join(HOME, 'Abs', 'plan2.txt')), 'the same with an absolute folder path ending in "/"')
} catch (e) {
  fail++
  console.log('✗ unexpected error:', e?.stack || e)
} finally {
  rmSync(HOME, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

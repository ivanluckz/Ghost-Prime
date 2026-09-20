// Smoke: the bash rc file the terminal sources must never be redirected by a pre-planted dir or
// symlink at the predictable tmpdir fallback (`$TMPDIR/ghost-prime-<uid>`), and must always be a
// fresh 0600 regular file we own. Runs each case in a child node process (ensureRc caches its path)
// with `electron` stubbed to a module WITHOUT `app`, which forces the fallback path.
//   node scripts/smoke-shell-rc.mjs
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, chmodSync, lstatSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = mkdtempSync(join(tmpdir(), 'ghost-rc-smoke-'))
const uid = String(process.getuid?.() ?? 'u')
// A loader that maps `electron` to a stub WITHOUT `app` (written to the scratch root; nesting
// data: URLs three deep is unreadable and quote-fragile).
const stubPath = join(root, 'electron-no-app.mjs')
writeFileSync(stubPath, "export const app = undefined\nexport class BrowserWindow { static getAllWindows() { return [] } }\n")
const loaderPath = join(root, 'loader.mjs')
writeFileSync(
  loaderPath,
  [
    "import { register } from 'node:module'",
    "import { pathToFileURL } from 'node:url'",
    `const stub = pathToFileURL(${JSON.stringify(stubPath)}).href`,
    "register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s, c, n) { if (s === 'electron') return { url: ${JSON.stringify(stub)}, shortCircuit: true }; return n(s, c) }`), import.meta.url)",
    ''
  ].join('\n')
)
const loader = loaderPath

function run(tmp) {
  const r = spawnSync(
    process.execPath,
    ['--no-warnings', '--import', loader, '-e', "import('./src/main/tools/shell-sessions.js').then((m) => console.log(m.ensureRc())).catch((e) => { console.error(e.message); process.exit(3) })"],
    { cwd: process.cwd(), env: { ...process.env, TMPDIR: tmp }, encoding: 'utf8' }
  )
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() }
}

let fails = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && extra ? ' — ' + extra : ''}`)
  if (!ok) fails++
}

// 1. Clean tmpdir: dir + file get created, file is a 0600 regular file, bash content present.
{
  const tmp = join(root, 'clean')
  mkdirSync(tmp, { recursive: true })
  const r = run(tmp)
  const p = join(tmp, `ghost-prime-${uid}`, 'shell-init.bash')
  const st = r.code === 0 && existsSync(p) ? lstatSync(p) : null
  check('clean tmpdir creates rc', r.code === 0 && r.out === p, r.err || r.out)
  check('rc is a regular 0600 file', !!st && st.isFile() && (st.mode & 0o777) === 0o600, st ? (st.mode & 0o777).toString(8) : 'missing')
  check('rc has OSC-133 hooks', !!st && /133;D/.test(readFileSync(p, 'utf8')))
  // Re-running replaces a stale file instead of failing (rmSync + wx).
  const r2 = run(tmp)
  check('second run replaces the existing rc', r2.code === 0 && r2.out === p, r2.err)
}

// 2. Planted symlink where the rc DIR should be → refused.
{
  const tmp = join(root, 'dirlink')
  const target = join(root, 'attacker-dir')
  mkdirSync(tmp, { recursive: true })
  mkdirSync(target, { recursive: true })
  symlinkSync(target, join(tmp, `ghost-prime-${uid}`))
  const r = run(tmp)
  check('symlinked rc dir is refused', r.code === 3 && /unsafe rc dir/.test(r.err), r.err || r.out)
  check('nothing written through the dir symlink', !existsSync(join(target, 'shell-init.bash')))
}

// 3. Group/other-writable pre-existing dir → refused.
{
  const tmp = join(root, 'loosedir')
  const d = join(tmp, `ghost-prime-${uid}`)
  mkdirSync(d, { recursive: true })
  chmodSync(d, 0o777)
  const r = run(tmp)
  check('world-writable rc dir is refused', r.code === 3 && /unsafe rc dir/.test(r.err), r.err || r.out)
}

// 4. Good dir but a planted symlink at the FILE path → link is unlinked, content lands in a new file.
{
  const tmp = join(root, 'filelink')
  const d = join(tmp, `ghost-prime-${uid}`)
  const victim = join(root, 'victim.bash')
  mkdirSync(d, { recursive: true, mode: 0o700 })
  writeFileSync(victim, '# untouched\n')
  symlinkSync(victim, join(d, 'shell-init.bash'))
  const r = run(tmp)
  const p = join(d, 'shell-init.bash')
  const st = existsSync(p) ? lstatSync(p) : null
  check('rc written despite planted file symlink', r.code === 0 && r.out === p, r.err || r.out)
  check('planted symlink replaced by a regular file', !!st && st.isFile() && !st.isSymbolicLink())
  check('symlink target was not written through', readFileSync(victim, 'utf8') === '# untouched\n')
}

rmSync(root, { recursive: true, force: true })
if (fails) {
  console.error(`\n${fails} check(s) failed`)
  process.exit(1)
}
console.log('\nsmoke-shell-rc: all checks passed')

// Site access (src/main/tools/site-policy.js + the browser_navigate gate), set up exactly as the
// showcase runbook does: /site strict, /site allow wikipedia.org, /site allow example.com. No browser
// launches: the gate refuses before any page opens. No LLM.
// Run: node --import ./scripts/lib/register-electron-stub.mjs scripts/smoke-site-policy.mjs
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

rmSync(join(app.getPath('userData'), 'site-policy.json'), { force: true }) // start from the defaults
const sp = await import('../src/main/tools/site-policy.js')
const { browserNavigate } = await import('../src/main/tools/browser.js')

let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && extra ? `  → ${String(extra).slice(0, 300)}` : ''}`)
}
const ok = (u) => sp.checkUrl(u).ok

check(sp.getPolicy().mode === 'open' && ok('https://google.com'), 'default is open: any site allowed')

// DEMO.md section 2 setup.
sp.setPolicy({ mode: 'strict' })
sp.setPolicy({ allow: [...sp.getPolicy().allow, 'wikipedia.org'] })
sp.setPolicy({ allow: [...sp.getPolicy().allow, 'example.com'] })
const pol = sp.getPolicy()
check(pol.mode === 'strict' && pol.allow.join(',') === 'wikipedia.org,example.com', 'strict with the two demo sites', JSON.stringify(pol))

check(ok('https://www.wikipedia.org/'), 'www.wikipedia.org allowed')
check(ok('https://en.wikipedia.org/wiki/Photosynthesis'), 'en.wikipedia.org (subdomain) allowed')
check(ok('http://example.com:8080/path?q=1'), 'example.com with a port and path allowed')
check(!ok('https://www.google.com/search?q=x'), 'google.com refused in strict mode')
check(!ok('https://wikipedia.org.evil.example/'), 'a look-alike host (wikipedia.org.evil.example) refused')
check(!ok('https://notwikipedia.org/'), 'a host that merely ends with the name (notwikipedia.org) refused')
check(/strict mode/.test(sp.checkUrl('https://youtube.com').reason || ''), 'the refusal explains strict mode and where to change it')
check(ok('about:blank') && ok('file:///tmp/x.html'), 'non-web schemes are not gated')

// The navigate tool refuses BEFORE opening a browser, and normalises a bare domain first.
let err = ''
try {
  await browserNavigate({ url: 'google.com' })
} catch (e) {
  err = e.message
}
check(/strict mode/.test(err), 'browser_navigate to a bare "google.com" is refused by the gate', err)
err = ''
try {
  await browserNavigate({ url: 'javascript:alert(1)' })
} catch (e) {
  err = e.message
}
check(/javascript: URLs cannot/.test(err), 'javascript: URLs are refused')

// Block list wins, also over the allow-list.
sp.setPolicy({ block: ['en.wikipedia.org'] })
check(!ok('https://en.wikipedia.org/wiki/X') && ok('https://fr.wikipedia.org/'), 'a blocked subdomain is refused while its siblings stay allowed')
check(/blocked-sites list/.test(sp.checkUrl('https://en.wikipedia.org/').reason || ''), 'the block refusal names the blocked list')

// Entries are cleaned when saved.
sp.setPolicy({ allow: ['https://www.Khan-Academy.org/some/page', '*.example.com', ''] })
const cleaned = sp.getPolicy().allow
check(cleaned.includes('khan-academy.org') && cleaned.includes('*.example.com') && !cleaned.includes(''), 'saved entries are normalised (scheme, www, path, case)', JSON.stringify(cleaned))
check(ok('https://www.khan-academy.org/x') && ok('https://a.example.com/'), 'normalised entries match')

// Persisted to disk (survives a restart).
const onDisk = JSON.parse(readFileSync(join(app.getPath('userData'), 'site-policy.json'), 'utf8'))
check(onDisk.mode === 'strict' && onDisk.block.includes('en.wikipedia.org'), 'the policy is saved to site-policy.json')

// Back to open (DEMO.md section 7).
sp.setPolicy({ mode: 'open', allow: [], block: [] })
check(ok('https://google.com') && sp.getPolicy().mode === 'open', '/site open puts it back to allow-all')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

// Site access (Settings → Site access) is a promise to teachers: "strict" = only allow-listed sites,
// and blocked sites never. Four ways around it, found 25 Sep:
//  1. A trailing dot ("facebook.com.") is the same site but did not match the block list.
//  2. web_fetch (Gemini brain) ignored the policy completely.
//  3. browser_read_pages checked the URL it was given, not where a redirect took it.
//  4. The Claude brain's built-in WebFetch ignored the policy completely.
// Local pages, bundled Chromium, Agent SDK stubbed. No internet, no LLM.
// Run: GHOST_BROWSER_HEADLESS=1 node --import ./scripts/lib/register-offline-stubs.mjs scripts/smoke-site-gaps.mjs
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dir = mkdtempSync(join(tmpdir(), 'ghost-site-gaps-'))
process.env.GHOST_STUB_DATA_DIR = dir
process.env.GHOST_BROWSER_BACKEND = 'playwright'
process.env.GHOST_BROWSER_HEADLESS ??= '1'
process.env.GHOST_BROWSER_CHANNEL ??= ''
process.env.GHOST_BROWSER_PROFILE = join(dir, 'profile')
process.env.GHOST_BRAIN_MODE = 'claude'

let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && extra ? `  → ${String(extra).slice(0, 300)}` : ''}`)
}
const server = createServer((req, res) => {
  const port = server.address().port
  if (req.url === '/go-secret') {
    res.writeHead(302, { location: `http://localhost:${port}/secret` })
    return res.end()
  }
  res.setHeader('content-type', 'text/html')
  res.end(req.url === '/secret' ? '<title>Secret</title>SECRET-CONTENT' : '<title>Fine</title>fine page')
}).listen(0, '127.0.0.1')
await new Promise((r) => server.once('listening', r))
const port = server.address().port
const allowed = `http://127.0.0.1:${port}`

const policy = await import('../src/main/tools/site-policy.js')
const { webFetch } = await import('../src/main/tools/web.js')
const b = await import('../src/main/tools/browser.js')
const { streamChat } = await import('../src/main/agent/provider.js')
try {
  // 1. trailing dot
  policy.setPolicy({ mode: 'open', allow: [], block: ['facebook.com'] })
  check(!policy.checkUrl('https://facebook.com./').ok, 'a blocked site with a trailing dot (facebook.com.) is still blocked')
  check(!policy.checkUrl('https://www.facebook.com./home').ok, '…also www. with a trailing dot')
  policy.setPolicy({ mode: 'strict', allow: ['wikipedia.org.'], block: [] })
  check(policy.checkUrl('https://en.wikipedia.org/wiki/X').ok, 'an allow-list entry typed with a trailing dot still allows the site')

  // 2. web_fetch obeys strict mode, before the request and after redirects
  policy.setPolicy({ mode: 'strict', allow: ['127.0.0.1'], block: [] })
  const ok = await webFetch({ url: `${allowed}/` })
  check(!ok.error && /fine page/.test(ok.content), 'web_fetch still reads an allowed site', JSON.stringify(ok))
  const direct = await webFetch({ url: `http://localhost:${port}/secret` })
  check(!!direct.error && !direct.content && /strict|allow-list/i.test(direct.error), 'web_fetch refuses a site that is not on the allow-list', JSON.stringify(direct))
  const redir = await webFetch({ url: `${allowed}/go-secret` })
  check(!!redir.error && !JSON.stringify(redir).includes('SECRET-CONTENT'), 'web_fetch does not return a forbidden site reached by a redirect', JSON.stringify(redir))
  policy.setPolicy({ mode: 'open', allow: [], block: ['localhost'] })
  const blocked = await webFetch({ url: `http://localhost:${port}/secret` })
  check(!!blocked.error && !blocked.content, 'web_fetch refuses a blocked site in open mode too', JSON.stringify(blocked))

  // 3. browser_read_pages after a redirect
  policy.setPolicy({ mode: 'strict', allow: ['127.0.0.1'], block: [] })
  const rp = await b.browserReadPages({ urls: [`${allowed}/`, `${allowed}/go-secret`], keepOpen: false })
  check(/fine page/.test(rp.pages[0].text), 'read_pages still reads an allowed page', JSON.stringify(rp.pages[0]))
  check(!JSON.stringify(rp.pages[1]).includes('SECRET-CONTENT') && !!rp.pages[1].error, 'read_pages does not return a forbidden page reached by a redirect', JSON.stringify(rp.pages[1]))

  // 4. the Claude brain's built-in WebFetch
  globalThis.__sdkCalls = []
  await streamChat({ messages: [{ role: 'user', content: 'read a page' }], mode: 'auto', onDelta() {}, onEvent() {} })
  const o = globalThis.__sdkCalls.at(-1)?.options || {}
  const pre = (o.hooks?.PreToolUse || []).filter((m) => !m.matcher || new RegExp(`^(${m.matcher})$`).test('WebFetch')).flatMap((m) => m.hooks)
  check(pre.length > 0, 'the Claude brain checks WebFetch before it runs (PreToolUse hook)', JSON.stringify(Object.keys(o.hooks || {})))
  const decide = async (url) => {
    for (const h of pre) {
      const r = await h({ hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: { url, prompt: 'x' }, tool_use_id: 't' }, 't', { signal: new AbortController().signal })
      if (r?.hookSpecificOutput?.permissionDecision === 'deny') return r.hookSpecificOutput.permissionDecisionReason || 'deny'
    }
    return 'allow'
  }
  check((await decide(`http://localhost:${port}/secret`)) !== 'allow', 'Claude WebFetch on a site not on the allow-list is denied')
  check((await decide(`${allowed}/`)) === 'allow', 'Claude WebFetch on an allowed site goes ahead')
} catch (e) {
  check(false, 'no unexpected error', e?.stack || e)
} finally {
  await b.browserClose?.().catch(() => {})
  server.close()
  rmSync(dir, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

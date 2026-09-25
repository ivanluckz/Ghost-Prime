// web_search (the Gemini brain's quick research tool) parses DuckDuckGo's HTML page. Two bugs found
// 25 Sep: result links came back mangled (the &amp; in DuckDuckGo's redirect link was never decoded,
// and the target was URL-decoded twice), and snippets were paired with titles by position, so one
// result without a snippet put every later snippet under the wrong link.
// Offline: fetch() returns a saved-style DuckDuckGo page. Run: node scripts/smoke-web-search.mjs
let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && extra ? `  → ${String(extra).slice(0, 300)}` : ''}`)
}
const ddg = (target) => `//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&amp;rut=abc123`
const block = (target, title, snippet) => `
<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="${ddg(target)}">${title}</a></h2>
    ${snippet == null ? '' : `<a class="result__snippet" href="${ddg(target)}">${snippet}</a>`}
  </div>
</div>`
const html = `<html><body>
${block('https://en.wikipedia.org/wiki/Photosynthesis', 'Photosynthesis - <b>Wikipedia</b>', 'Photosynthesis is how plants turn light into chemical energy.')}
${block('https://example.org/no-snippet?a=1&b=2', 'A page with no snippet', null)}
${block('https://www.britannica.com/science/photosynthesis?x=50%25', 'Photosynthesis | Britannica', 'Britannica explains chlorophyll &amp; light.')}
</body></html>`
globalThis.fetch = async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })

const { webSearch } = await import('../src/main/tools/web.js')
const r = await webSearch({ query: 'photosynthesis', num_results: 5 })
const [a, b, c] = r.results || []
check(r.count === 3, 'three results', JSON.stringify(r).slice(0, 200))
check(a?.url === 'https://en.wikipedia.org/wiki/Photosynthesis', 'the real address, not the DuckDuckGo redirect', a?.url)
check(b?.url === 'https://example.org/no-snippet?a=1&b=2', 'an address with & in it survives', b?.url)
check(c?.url === 'https://www.britannica.com/science/photosynthesis?x=50%25', 'an address with %25 is not decoded twice', c?.url)
check(b?.snippet === '', 'a result without a snippet gets none', JSON.stringify(b))
check(/Britannica explains chlorophyll & light/.test(c?.snippet || ''), "the next result keeps its own snippet", JSON.stringify(c))
check(a?.title === 'Photosynthesis - Wikipedia', 'titles lose their HTML', a?.title)
const two = await webSearch({ query: 'photosynthesis', num_results: 2 })
check(two.count === 2 && two.results[1].snippet === '', 'with a limit, the last kept result does not borrow the next one\'s snippet', JSON.stringify(two.results?.[1]))
// web_fetch on a page built by JavaScript: say so instead of returning an empty "success".
globalThis.fetch = async () => new Response('<html><body><div id="root"></div><script>render()</script></body></html>', { status: 200, headers: { 'content-type': 'text/html' } })
const { webFetch } = await import('../src/main/tools/web.js')
const f = await webFetch({ url: 'https://app.example.com/' })
check(!f.error && /JavaScript/.test(f.note || '') && /browser_navigate/.test(f.note || ''), 'web_fetch on a JavaScript-only page points to the browser instead', JSON.stringify(f))
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

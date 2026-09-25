import { checkUrl } from './site-policy.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const TIMEOUT_MS = 20_000 // a stalled host must not block the agent turn for minutes
const MAX_BYTES = 2 * 1024 * 1024 // cap the body so a huge page can't be buffered whole

// Timeout + the chat's abort signal (Stop button) combined, so either one cancels the request.
function combinedSignal(signal) {
  const t = AbortSignal.timeout(TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, t]) : t
}

// fetch() a text resource with a timeout, a content-type guard (no PDFs/ISOs/videos decoded
// into garbage) and a streaming 2 MB cap. Returns { text, finalUrl, truncatedBody, status }.
async function fetchText(url, signal) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: combinedSignal(signal) })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
  const ct = res.headers.get('content-type') || ''
  if (ct && !/^(text\/|application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml|javascript))/i.test(ct)) {
    throw new Error(`Unsupported content type: ${ct.split(';')[0]}`)
  }
  const len = Number(res.headers.get('content-length'))
  if (len > MAX_BYTES) throw new Error(`Response too large (${len} bytes)`)
  if (!res.body) return { text: '', finalUrl: res.url, truncatedBody: false, status: res.status } // 204/205: no body
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  let truncatedBody = false
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BYTES) {
      chunks.push(value.subarray(0, value.byteLength - (total - MAX_BYTES)))
      truncatedBody = true
      await reader.cancel()
      break
    }
    chunks.push(value)
  }
  return { text: new TextDecoder('utf-8').decode(Buffer.concat(chunks)), finalUrl: res.url, truncatedBody, status: res.status }
}

// Friendlier wording for the two abort cases than undici's raw error names.
function describeFetchError(err) {
  if (err?.name === 'TimeoutError') return `timed out after ${TIMEOUT_MS / 1000}s`
  if (err?.name === 'AbortError') return 'cancelled'
  return err?.message || String(err)
}

export async function webSearch({ query, num_results = 5, signal } = {}) {
  try {
    if (!query) return { error: 'Search query is required' }
    // Use DuckDuckGo HTML search endpoint (no API key required)
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
    const { text: html, status } = await fetchText(url, signal)
    // DDG answers automated requests with a 202 "anomaly" challenge page that contains zero
    // results — don't let that read as "no results for this query".
    if (status !== 200 || /anomaly-modal|challenge-form|anomaly\.js/.test(html)) {
      return { error: `DuckDuckGo blocked the request (bot challenge, HTTP ${status}). Use browser_navigate to search instead.` }
    }

    const results = []
    // The title anchor is <a class="result__a" href="…">Title</a> inside <h2 class="result__title">
    // (attribute order varies, so match it loosely).
    const titleRegex = /<h2 class="result__title">[\s\S]*?<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
    const snippetRegex = /<a class="result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g

    let match
    const cleanText = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim()

    // Each result's snippet is looked for only between its own title and the next result's title:
    // pairing the two lists by position put every later snippet under the wrong link as soon as one
    // result had none.
    const heads = []
    while ((match = titleRegex.exec(html)) !== null && heads.length <= num_results) {
      let rawUrl = match[1].replace(/&amp;/g, '&')
      // DDG wraps external urls in /l/?uddg=https%3A%2F%2F…&rut=… — searchParams already decodes
      // it once (decoding again broke addresses containing %25).
      if (rawUrl.includes('uddg=')) {
        try {
          rawUrl = new URL(rawUrl, 'https://duckduckgo.com').searchParams.get('uddg') || rawUrl
        } catch {}
      }
      heads.push({ url: rawUrl, title: cleanText(match[2]), end: titleRegex.lastIndex, start: match.index })
    }
    // One extra title was read so the last kept result's snippet search stops at the next result.
    for (let i = 0; i < Math.min(heads.length, num_results); i++) {
      const scope = html.slice(heads[i].end, i + 1 < heads.length ? heads[i + 1].start : undefined)
      snippetRegex.lastIndex = 0
      const sm = snippetRegex.exec(scope)
      results.push({ title: heads[i].title, url: heads[i].url, snippet: sm ? cleanText(sm[1]) : '' })
    }

    if (results.length === 0) {
      return { query, count: 0, results: [], message: 'No search results found.' }
    }

    return { query, count: results.length, results }
  } catch (err) {
    return { error: `Web search error: ${describeFetchError(err)}` }
  }
}

export async function webFetch({ url, signal } = {}) {
  try {
    if (!url) return { error: 'URL is required' }
    // Site access (Settings → Site access) applies here too: check the address, and where any
    // redirect ended up, before returning a single word of the page.
    const gate = checkUrl(url)
    if (!gate.ok) return { error: `Not fetched: ${gate.reason}` }
    const { text, finalUrl, truncatedBody } = await fetchText(url, signal)
    const after = checkUrl(finalUrl || url)
    if (!after.ok) return { error: `Not fetched: it redirected to ${finalUrl}. ${after.reason}` }
    // Strip script and style tags, return readable text
    const clean = text
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    // A page built by JavaScript (many apps, some news sites) has almost no text in its HTML. Say so,
    // or the model reads an empty result as "the page is empty".
    const note =
      clean.length < 80 ? 'This page has almost no text without JavaScript. Open it with browser_navigate and read it with browser_get_text instead.' : undefined
    return {
      url: finalUrl || url,
      content: clean.slice(0, 15000),
      truncated: truncatedBody || clean.length > 15000,
      ...(note ? { note } : {})
    }
  } catch (err) {
    return { error: `Web fetch error: ${describeFetchError(err)}` }
  }
}

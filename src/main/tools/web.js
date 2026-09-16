export async function webSearch({ query, num_results = 5 } = {}) {
  try {
    if (!query) return { error: 'Search query is required' }
    // Use DuckDuckGo HTML search endpoint (no API key required)
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    })
    if (!res.ok) throw new Error(`DuckDuckGo returned status ${res.status}`)
    const html = await res.text()

    const results = []
    const regex = /<a class="result__snippet[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__url[^>]*href="([^"]+)"/g
    // Alternative simpler regex for titles and snippets:
    const titleRegex = /<h2 class="result__title">[\s\S]*?<a class="result__url" href="([^"]+)">([\s\S]*?)<\/a>/g
    const snippetRegex = /<a class="result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g

    let match
    const cleanText = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim()

    const titles = []
    while ((match = titleRegex.exec(html)) !== null && titles.length < num_results) {
      let rawUrl = match[1]
      // DDG wraps external urls in /l/?kh=-1&uddg=https%3A%2F%2F...
      if (rawUrl.includes('uddg=')) {
        try {
          const u = new URL('https://duckduckgo.com' + rawUrl)
          rawUrl = decodeURIComponent(u.searchParams.get('uddg') || rawUrl)
        } catch {}
      }
      titles.push({ url: rawUrl, title: cleanText(match[2]) })
    }

    const snippets = []
    while ((match = snippetRegex.exec(html)) !== null && snippets.length < num_results) {
      snippets.push(cleanText(match[1]))
    }

    for (let i = 0; i < titles.length; i++) {
      results.push({
        title: titles[i].title,
        url: titles[i].url,
        snippet: snippets[i] || ''
      })
    }

    if (results.length === 0) {
      return { query, count: 0, results: [], message: 'No search results found.' }
    }

    return { query, count: results.length, results }
  } catch (err) {
    return { error: `Web search error: ${err.message}` }
  }
}

export async function webFetch({ url } = {}) {
  try {
    if (!url) return { error: 'URL is required' }
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    const text = await res.text()
    // Strip script and style tags, return readable text
    const clean = text
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    return {
      url,
      content: clean.slice(0, 15000),
      truncated: clean.length > 15000
    }
  } catch (err) {
    return { error: `Web fetch error: ${err.message}` }
  }
}

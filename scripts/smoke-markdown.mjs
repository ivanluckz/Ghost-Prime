// Chat Markdown renderer (src/renderer/components/chat/Markdown.jsx), no browser and no LLM:
//   • every streaming prefix of a rich reply gives each top-level block a UNIQUE React key (the
//     automatic JSX runtime evaluates `key` after the children, which once gave a paragraph the next
//     block's key: React then drops or duplicates blocks while a reply streams in)
//   • GitHub tables, > blockquotes (holding a list) and fenced code blocks render as such
//   • link sanitising: only http(s)/mailto become <a>; javascript:, data:, file: stay literal text
//   • no raw HTML ever reaches the DOM
// Run: node scripts/smoke-markdown.mjs
import { build } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Bundle the component next to node_modules so its `react` import resolves to the app's copy.
const outdir = join(process.cwd(), 'node_modules', '.cache', 'ghost-smoke')
mkdirSync(outdir, { recursive: true })
const outfile = join(outdir, `markdown-${process.pid}.mjs`)
await build({
  entryPoints: ['src/renderer/components/chat/Markdown.jsx'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  outfile,
  logLevel: 'warning'
})
const { default: Markdown } = await import(pathToFileURL(outfile).href)
rmSync(outfile, { force: true }) // loaded; nothing left behind
const { renderToStaticMarkup } = await import('react-dom/server')
const { createElement } = await import('react')

let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && extra ? `  → ${extra}` : ''}`)
}
const html = (text) => renderToStaticMarkup(createElement(Markdown, { text }))
const topKeys = (text) => [].concat(Markdown({ text }).props.children).map((c) => String(c?.key))

const reply = `# Photosynthesis

Here's **photosynthesis** in three *simple* sentences:

1. Plants make food from light.
2. They take in carbon dioxide and water.
3. They give out oxygen.

| Goes in | Comes out |
|---|:--:|
| Carbon dioxide | Glucose |
| Water | Oxygen |

> Source: Wikipedia.
> - read more later

The word equation:

\`\`\`text
carbon dioxide + water  --(light energy, absorbed by chlorophyll)-->  glucose + oxygen
\`\`\`

## Next

Want a quiz? [Wikipedia](https://en.wikipedia.org/wiki/Photosynthesis) · [mail](mailto:teacher@example.org)`

// 1. Unique keys for every prefix, exactly as the reply streams in.
let dupAt = -1
for (let n = 1; n <= reply.length && dupAt < 0; n++) {
  const keys = topKeys(reply.slice(0, n))
  if (new Set(keys).size !== keys.length) dupAt = n
}
check(dupAt < 0, 'unique block keys at every streaming prefix', dupAt >= 0 ? `first duplicate at char ${dupAt}: ${topKeys(reply.slice(0, dupAt)).join(',')}` : '')
check(topKeys('a\n\n```').join(',') === '0,1', 'paragraph then an unclosed fence get keys 0,1', topKeys('a\n\n```').join(','))
check(topKeys('# h\n\ntext').join(',') === '0,1', 'heading then paragraph get keys 0,1', topKeys('# h\n\ntext').join(','))

// 2. Block types.
const out = html(reply)
check(/<table class="md-table">/.test(out) && /<th[^>]*>Goes in<\/th>/.test(out) && /<td[^>]*>Oxygen<\/td>/.test(out), 'GitHub table renders with header and cells')
check(/<th style="text-align:center">/.test(out), 'table column alignment (:--:) is honoured')
check(/<blockquote class="md-quote"><p class="md-p">Source: Wikipedia.<\/p><ul class="md-ul">/.test(out), 'blockquote renders and can hold a list')
check(/<div class="md-codeblock">[\s\S]*<span class="md-lang">text<\/span>[\s\S]*<pre class="md-pre"><code>carbon dioxide/.test(out), 'fenced code block renders with its language label')
check(/<ol class="md-ol"><li>Plants make food/.test(out), 'ordered list renders')
check(/<h3 class="md-h md-h1">Photosynthesis<\/h3>/.test(out) && /<h4 class="md-h md-h2">Next<\/h4>/.test(out), 'headings map to h3/h4 with level classes')
check(/<strong>photosynthesis<\/strong>/.test(out) && /<em>simple<\/em>/.test(out), 'bold and italic')
check(/<table[\s\S]*<\/table>/.test(html('| a | b |\n|---|---|')) , 'a table whose body has not streamed in yet still renders its header')

// 3. Link sanitising.
check(/<a href="https:\/\/en.wikipedia.org\/wiki\/Photosynthesis" target="_blank" rel="noreferrer noopener">Wikipedia<\/a>/.test(out), 'https link becomes a safe external anchor')
check(/<a href="mailto:teacher@example.org"/.test(out), 'mailto link becomes an anchor')
for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'vbscript:x', '//evil.example/x']) {
  const h = html(`[click](${bad})`)
  check(!/<a /.test(h), `no anchor for ${bad}`, h)
}

// 4. Raw HTML is escaped, never injected.
const inj = html('<img src=x onerror=alert(1)> and <script>alert(1)</script>')
check(!/<img|<script/i.test(inj) && /&lt;img/.test(inj), 'raw HTML is escaped', inj)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

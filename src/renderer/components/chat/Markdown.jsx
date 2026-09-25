// Minimal, safe Markdown -> React renderer (no raw HTML injection).
// Supports: code fences, inline `code`, **bold**, *italic*, [links](url) (http/https/mailto only),
// # headings, nested -/*/+ and 1. lists, > blockquotes, GitHub | tables |, and --- rules.
// Good enough for chat replies, and tolerant of half-streamed input (an unclosed fence or a table
// whose delimiter row hasn't arrived yet simply renders as what it is so far).

import { useState } from 'react'

// A fenced code block with a language label and a one-click Copy button.
function CodeBlock({ code, lang }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    try {
      navigator.clipboard?.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {}
  }
  return (
    <div className="md-codeblock">
      <div className="md-codebar">
        <span className="md-lang">{lang || 'code'}</span>
        <button type="button" className={`md-copy${copied ? ' copied' : ''}`} onClick={copy}>
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      <pre className="md-pre">
        <code>{code}</code>
      </pre>
    </div>
  )
}

function renderInline(text, kp) {
  const nodes = []
  const regex = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let key = 0
  let m
  while ((m = regex.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('`')) {
      nodes.push(
        <code key={`${kp}-${key++}`} className="md-code">
          {tok.slice(1, -1)}
        </code>
      )
    } else if (tok.startsWith('**')) {
      nodes.push(<strong key={`${kp}-${key++}`}>{tok.slice(2, -2)}</strong>)
    } else if (tok.startsWith('*')) {
      nodes.push(<em key={`${kp}-${key++}`}>{tok.slice(1, -1)}</em>)
    } else {
      const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok)
      const href = mm[2].trim()
      // Only web/mail links become anchors; anything else (javascript:, file:, …) renders literally.
      if (/^(https?:|mailto:)/i.test(href)) {
        nodes.push(
          <a key={`${kp}-${key++}`} href={href} target="_blank" rel="noreferrer noopener">
            {mm[1]}
          </a>
        )
      } else {
        nodes.push(tok)
      }
    }
    last = m.index + tok.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

const FENCE = /^\s*```/
const HEADING = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const QUOTE = /^\s{0,3}>/
const TABLE_DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

// Split a table row into trimmed cells: outer pipes are optional and `\|` is a literal pipe.
function splitRow(line) {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
}

// A GitHub table starts at a row containing a pipe that is followed by a |---|:--:| delimiter row.
function isTableStart(lines, i) {
  const next = lines[i + 1]
  return lines[i].includes('|') && next != null && next.includes('|') && TABLE_DELIM.test(next)
}

function renderTable(lines, i, key) {
  const head = splitRow(lines[i])
  const align = splitRow(lines[i + 1]).map((c) =>
    c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : undefined
  )
  const rows = []
  i += 2
  while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|') && !FENCE.test(lines[i])) {
    rows.push(splitRow(lines[i]))
    i++
  }
  const cell = (Tag, text, c, kp) => (
    <Tag key={c} style={align[c] ? { textAlign: align[c] } : undefined}>
      {renderInline(text ?? '', kp)}
    </Tag>
  )
  const node = (
    <div key={key} className="md-table-wrap">
      <table className="md-table">
        <thead>
          <tr>{head.map((h, c) => cell('th', h, c, `th${key}-${c}`))}</tr>
        </thead>
        <tbody>
          {rows.map((r, j) => (
            <tr key={j}>{head.map((_, c) => cell('td', r[c], c, `td${key}-${j}-${c}`))}</tr>
          ))}
        </tbody>
      </table>
    </div>
  )
  return { node, next: i }
}

// Collect a run of list items (with their indent) plus indented continuation lines.
function collectListItems(lines, i) {
  const items = []
  while (i < lines.length) {
    const line = lines[i]
    const m = LIST_ITEM.exec(line)
    if (m && !RULE.test(line)) {
      items.push({
        indent: m[1].replace(/\t/g, '    ').length,
        ordered: /\d/.test(m[2]),
        num: parseInt(m[2], 10),
        text: m[3]
      })
      i++
      continue
    }
    // An indented plain line continues the previous item (a bullet the model wrapped by hand).
    if (items.length && /^\s{2,}\S/.test(line) && !FENCE.test(line)) {
      items[items.length - 1].text += '\n' + line.trim()
      i++
      continue
    }
    break
  }
  return { items, next: i }
}

// Build one <ul>/<ol> from items[pos] onward; deeper-indented runs nest under the previous item.
function buildList(items, pos, indent, kp) {
  const { ordered, num } = items[pos]
  const lis = []
  while (pos < items.length) {
    const it = items[pos]
    if (it.indent > indent) {
      const sub = buildList(items, pos, it.indent, `${kp}.${pos}`)
      if (lis.length) lis[lis.length - 1].kids.push(sub.node)
      else lis.push({ text: '', kids: [sub.node] })
      pos = sub.next
      continue
    }
    if (it.indent < indent || it.ordered !== ordered) break
    lis.push({ text: it.text, kids: [] })
    pos++
  }
  const Tag = ordered ? 'ol' : 'ul'
  const node = (
    <Tag key={kp} className={ordered ? 'md-ol' : 'md-ul'} start={ordered && num !== 1 ? num : undefined}>
      {lis.map((li, j) => (
        <li key={j}>
          {renderInline(li.text, `${kp}-${j}`)}
          {li.kids}
        </li>
      ))}
    </Tag>
  )
  return { node, next: pos }
}

function parseBlocks(text) {
  const lines = String(text || '').split('\n')
  const blocks = []
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]

    // Code fence
    if (FENCE.test(line)) {
      const lang = line.trim().slice(3).trim() // language hint after the opening fence, if any
      const buf = []
      i++
      while (i < lines.length && !FENCE.test(lines[i])) {
        buf.push(lines[i])
        i++
      }
      i++ // closing fence (may be absent while streaming)
      blocks.push(<CodeBlock key={key++} code={buf.join('\n')} lang={lang} />)
      continue
    }

    // Blank line
    if (line.trim() === '') {
      i++
      continue
    }

    // Heading (# … ######) -> h3..h6; the level class drives the type scale.
    const h = HEADING.exec(line)
    if (h) {
      const level = h[1].length
      const Tag = `h${Math.min(level + 2, 6)}`
      blocks.push(
        <Tag key={key} className={`md-h md-h${Math.min(level, 4)}`}>
          {renderInline(h[2], `h${key++}`)}
        </Tag>
      )
      i++
      continue
    }

    // Horizontal rule (---, ***, ___). Checked before lists: "- - -" is a rule, not a bullet.
    if (RULE.test(line)) {
      blocks.push(<hr key={key++} className="md-hr" />)
      i++
      continue
    }

    // Blockquote: strip one ">" level and parse the inside as Markdown (quotes can hold lists).
    if (QUOTE.test(line)) {
      const buf = []
      while (i < lines.length && QUOTE.test(lines[i])) {
        buf.push(lines[i].replace(/^\s{0,3}> ?/, ''))
        i++
      }
      blocks.push(
        <blockquote key={key++} className="md-quote">
          {parseBlocks(buf.join('\n'))}
        </blockquote>
      )
      continue
    }

    // GitHub table
    if (isTableStart(lines, i)) {
      const t = renderTable(lines, i, key++)
      blocks.push(t.node)
      i = t.next
      continue
    }

    // Lists (unordered and ordered, nested by indentation)
    if (LIST_ITEM.test(line)) {
      const { items, next } = collectListItems(lines, i)
      let pos = 0
      while (pos < items.length) {
        const l = buildList(items, pos, items[pos].indent, `l${key++}`)
        blocks.push(l.node)
        pos = l.next
      }
      i = next
      continue
    }

    // Paragraph: gather consecutive plain lines
    const para = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !FENCE.test(lines[i]) &&
      !HEADING.test(lines[i]) &&
      !RULE.test(lines[i]) &&
      !QUOTE.test(lines[i]) &&
      !LIST_ITEM.test(lines[i]) &&
      !isTableStart(lines, i)
    ) {
      para.push(lines[i])
      i++
    }
    blocks.push(
      <p key={key} className="md-p">
        {renderInline(para.join('\n'), `p${key++}`)}
      </p>
    )
  }

  return blocks
}

export default function Markdown({ text }) {
  return <div className="md">{parseBlocks(text)}</div>
}

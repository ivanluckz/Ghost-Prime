// Minimal, safe Markdown -> React renderer (no raw HTML injection).
// Supports: code fences, inline `code`, **bold**, *italic*, [links](url),
// # headings, and -/* and 1. lists. Good enough for chat replies.

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

export default function Markdown({ text }) {
  const lines = String(text || '').split('\n')
  const blocks = []
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]

    // Code fence
    if (line.trim().startsWith('```')) {
      const lang = line.trim().slice(3).trim() // language hint after the opening fence, if any
      const buf = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        buf.push(lines[i])
        i++
      }
      i++ // closing fence (may be absent while streaming)
      blocks.push(<CodeBlock key={key++} code={buf.join('\n')} lang={lang} />)
      continue
    }

    // Heading (#, ##, ###)
    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    if (h) {
      const Tag = `h${h[1].length + 2}` // h3..h5
      blocks.push(
        <Tag key={key} className="md-h">
          {renderInline(h[2], `h${key++}`)}
        </Tag>
      )
      i++
      continue
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''))
        i++
      }
      blocks.push(
        <ul key={key} className="md-ul">
          {items.map((it, j) => (
            <li key={j}>{renderInline(it, `ul${key}-${j}`)}</li>
          ))}
        </ul>
      )
      key++
      continue
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''))
        i++
      }
      blocks.push(
        <ol key={key} className="md-ol">
          {items.map((it, j) => (
            <li key={j}>{renderInline(it, `ol${key}-${j}`)}</li>
          ))}
        </ol>
      )
      key++
      continue
    }

    // Blank line
    if (line.trim() === '') {
      i++
      continue
    }

    // Paragraph: gather consecutive plain lines
    const para = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].trim().startsWith('```') &&
      !/^(#{1,3})\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
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

  return <div className="md">{blocks}</div>
}

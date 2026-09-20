// ipc.js forBrain(): the per-turn brain payload keeps attachment content (image data URLs, inlined
// text files) only for the most recent user turns — older images collapse to a placeholder, older
// inlined files fall back to the display text — so a chat with a few drops doesn't re-send
// megabytes on every later turn. The DB keeps the full form; only the brain payload is capped.
// ipc.js pulls in electron modules the node stub doesn't cover (globalShortcut), so the pure
// forBrain block is lifted out of the source and evaluated here. No LLM, no cost.
// Run: node scripts/smoke-attachment-cap.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/main/ipc.js'), 'utf8')
const start = src.indexOf('const KEEP_IMAGE_TURNS')
const end = src.indexOf('\nexport function registerIpc')
if (start < 0 || end < 0) throw new Error('forBrain block not found in ipc.js')
const { forBrain, KEEP_IMAGE_TURNS, KEEP_FILE_TURNS } = new Function(
  src.slice(start, end).replace('export function forBrain', 'function forBrain') + '\nreturn { forBrain, KEEP_IMAGE_TURNS, KEEP_FILE_TURNS }'
)()

const failures = []
const check = (cond, what) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`)
  if (!cond) failures.push(what)
}

const img = (n) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(64)}${n}` } })
const txt = (t) => ({ type: 'text', text: t })
const userImg = (n) => ({ role: 'user', content: `look at this ${n} 📎 img${n}.png`, modelContent: [txt(`look at this ${n}`), img(n)] })
const userFile = (n) => ({ role: 'user', content: `read this ${n} 📎 f${n}.txt`, modelContent: `read this ${n}\n\n--- f${n}.txt ---\nFILE_BODY_${n}` })
const asst = (n) => ({ role: 'assistant', content: `reply ${n}` })
const plain = (n) => ({ role: 'user', content: `plain ${n}` })

// 1. Plain history passes through untouched; modelContent wins over content when present and fresh.
let out = forBrain([plain(1), asst(1), userFile(2)])
check(out.length === 3 && out[0].content === 'plain 1' && out[1].content === 'reply 1', 'plain turns pass through')
check(out[2].content.includes('FILE_BODY_2'), 'newest inlined file is sent to the brain')
check(forBrain(null).length === 0 && forBrain(undefined).length === 0, 'non-array history → empty')

// 2. Images: only the last KEEP_IMAGE_TURNS user turns keep their image parts.
const hist = []
for (let i = 1; i <= 5; i++) hist.push(userImg(i), asst(i))
out = forBrain(hist)
const imgTurns = out.filter((m) => m.role === 'user')
const hasImg = (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')
const hasPlaceholder = (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'text' && /attached earlier/.test(p.text))
check(imgTurns.slice(-KEEP_IMAGE_TURNS).every(hasImg), `last ${KEEP_IMAGE_TURNS} image turns keep their images`)
check(imgTurns.slice(0, -KEEP_IMAGE_TURNS).every((m) => !hasImg(m) && hasPlaceholder(m)), 'older image turns are replaced by a placeholder')
check(imgTurns[0].content[0].text === 'look at this 1', 'text part of an older image turn is kept')
check(hist[0].modelContent.some((p) => p.type === 'image_url'), 'input history is not mutated')
const bytes = JSON.stringify(out).length
check(bytes < JSON.stringify(hist.map((m) => ({ role: m.role, content: m.modelContent ?? m.content }))).length, `payload shrank (${bytes} chars)`)

// 3. Two images in one old turn collapse to ONE placeholder.
out = forBrain([{ role: 'user', content: 'two 📎', modelContent: [txt('two'), img(1), img(2)] }, asst(1), plain(2), asst(2), plain(3)])
check(out[0].content.filter(hasPlaceholderPart).length === 1, 'multiple images in an old turn → a single placeholder')
function hasPlaceholderPart(p) {
  return p.type === 'text' && /attached earlier/.test(p.text)
}

// 4. Inlined text files: kept for the last KEEP_FILE_TURNS user turns, then the display text is used.
const files = []
for (let i = 1; i <= KEEP_FILE_TURNS + 3; i++) files.push(userFile(i), asst(i))
out = forBrain(files)
const fileTurns = out.filter((m) => m.role === 'user')
check(fileTurns.slice(-KEEP_FILE_TURNS).every((m) => /FILE_BODY_/.test(m.content)), `last ${KEEP_FILE_TURNS} file turns keep the inlined file`)
check(fileTurns.slice(0, -KEEP_FILE_TURNS).every((m) => typeof m.content === 'string' && !/FILE_BODY_/.test(m.content) && /📎/.test(m.content)), 'older file turns fall back to the display text with the 📎 chip')

// 5. Rank counts USER turns only — assistant/tool rows in between don't eat the budget.
out = forBrain([userImg(1), asst(1), asst(2), asst(3), userImg(2)])
check(out.filter((m) => m.role === 'user').every(hasImg), 'assistant rows between user turns do not consume the image budget')

// 6. An old parts-array turn with an image AND an inlined file past the file cap → display text only.
const mixed = []
for (let i = 1; i <= KEEP_FILE_TURNS + 1; i++) mixed.push(i === 1 ? { role: 'user', content: 'mix 📎 a.txt 📎 b.png', modelContent: [txt('mix\n\n--- a.txt ---\nFILE_BODY_mix'), img(1)] } : plain(i), asst(i))
out = forBrain(mixed)
check(out[0].content === 'mix 📎 a.txt 📎 b.png', 'old mixed turn beyond the file cap sends the display text only')

console.log(failures.length ? `SMOKE_MISMATCH (${failures.length})` : 'SMOKE_OK')
process.exit(failures.length ? 2 : 0)

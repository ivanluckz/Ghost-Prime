// Stop in the chat window: after Stop (or Ctrl+N / another chat, which stop everything), events the
// stopped request still sends must not land in the chat. They used to: the late text appeared at the
// top of a fresh chat, a late tool card appeared, the "One sec." acknowledgement was spoken, and the
// orphan text was then sent to the AI as history for the next question.
// Needs the design server (`npm run design`). Run: node scripts/check-stop-ui.mjs [baseUrl]
import { chromium } from 'playwright'

const base = process.argv[2] || 'http://127.0.0.1:5199/?skipIntro=1&lateDone=1'
let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && extra ? `  → ${String(extra).slice(0, 300)}` : ''}`)
}
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
const page = async () => {
  const p = await browser.newPage({ viewport: { width: 1366, height: 768 } })
  p.on('pageerror', (e) => check(false, 'no page error', e.message))
  await p.addInitScript(() => {
    window.__spoken = []
    window.__sent = []
    window.__rids = []
  })
  await p.goto(base)
  await p.waitForSelector('.chat-input textarea', { timeout: 60000 })
  await p.evaluate(() => {
    const g = window.ghost
    const speak = g.voice?.speak
    if (g.voice) g.voice.speak = (t) => (window.__spoken.push(t), speak?.(t))
    const send = g.sendMessage
    g.sendMessage = (...a) => {
      window.__sent.push(a)
      const r = send.apply(g, a)
      Promise.resolve(r).then((id) => window.__rids.push(id))
      return r
    }
  })
  return p
}
const say = async (p, text) => {
  await p.locator('.chat-input textarea').fill(text)
  await p.keyboard.press('Enter')
}
try {
  // 1. Ctrl+N while a reply is streaming, then late events from the stopped request.
  let p = await page()
  await say(p, '/voice on')
  await say(p, "Remember that I'm in S4 and my favourite subject is chemistry.")
  await p.waitForTimeout(400)
  const rid = await p.evaluate(() => window.__rids.at(-1)) // the request that is still streaming
  await p.keyboard.press('Control+n') // new chat: stops everything
  await p.waitForTimeout(300)
  await p.evaluate((r) => {
    window.__ghostEmit('delta', { requestId: r, text: "Got it, I'll remember that." })
    window.__ghostEmit('tool', { requestId: r, kind: 'tool_use', id: 'late1', name: 'memory_save', input: { content: 'S4' } })
  }, rid)
  await p.waitForTimeout(400)
  await p.evaluate((r) => window.__ghostEmit('done', { requestId: r, aborted: true }), rid) // the run has wound down
  await p.waitForTimeout(200)
  const texts = await p.locator('.messages').innerText()
  check(!/remember that\./.test(texts) && !(await p.locator('.toolcard').count()), 'a fresh chat shows nothing from the stopped request', texts.slice(0, 200))
  check(!(await p.evaluate(() => window.__spoken.some((t) => /sec|moment|on it/i.test(t)))), 'no "One sec." is spoken for it', JSON.stringify(await p.evaluate(() => window.__spoken)))
  await say(p, 'What do you know about me?')
  await p.waitForTimeout(300)
  const hist = await p.evaluate(() => JSON.stringify(window.__sent.at(-1)))
  check(!/remember that\./.test(hist), 'the next question is not sent with the orphan text as history', hist.slice(0, 300))
  check(!!rid, 'test hook: the stopped request id was captured', rid)
  await p.close()
} catch (e) {
  check(false, 'no unexpected error', e?.stack || e)
} finally {
  await browser.close()
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

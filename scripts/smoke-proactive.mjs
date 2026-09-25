// Smoke for the proactive engine's morning-briefing bookkeeping (no LLM, no DB, no Electron).
// Verifies the briefing is counted as delivered ONLY once it actually reached the UI: an empty
// generation or a rejected push leaves the day open for a retry (bounded), and a delivered one
// closes it. db.js / provider.js are swapped for in-memory stubs via a loader hook.
// Run: node scripts/smoke-proactive.mjs
import { register } from 'node:module'

const stubs = {
  './memory/db.js': `
    export const memoryDigest = () => []
    export const allMemories = () => []
    export const getPref = (k) => globalThis.__prefs[k]
    export const setPref = (k, v) => { globalThis.__prefs[k] = v }`,
  './agent/provider.js': `export const generateShort = () => globalThis.__gen()`
}
register(
  'data:text/javascript,' +
    encodeURIComponent(`const stubs = ${JSON.stringify(stubs)}
      export async function resolve(spec, ctx, next) {
        if (stubs[spec] && ctx.parentURL?.endsWith('/src/main/proactive.js'))
          return { url: 'data:text/javascript,' + encodeURIComponent(stubs[spec]), shortCircuit: true }
        return next(spec, ctx)
      }`),
  import.meta.url
)

globalThis.__prefs = {}
globalThis.__gen = async () => ''
delete process.env.GHOST_PROACTIVE
const { initProactive, stopProactive, _briefingIfNewDay, _resetBriefingAttempts } = await import('../src/main/proactive.js')

const d = new Date()
const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const shown = []
let accept = true
initProactive({ onMessage: (text, meta) => (accept ? (shown.push({ text, meta }), true) : false) })
stopProactive() // we drive the briefing by hand; no timers

let fail = 0
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
  if (!ok) fail++
}

// 1. Empty generation (429 / no key) → not delivered, day stays open.
check('empty generation is not delivered', (await _briefingIfNewDay()) === false)
check('empty generation leaves the day open', globalThis.__prefs.lastBriefingDate === undefined)
check('nothing was pushed to the UI', shown.length === 0)

// 2. Text generated but the UI push was rejected (window gone) → still open.
globalThis.__gen = async () => '  Good morning, Jes.  '
accept = false
check('rejected push is not delivered', (await _briefingIfNewDay()) === false)
check('rejected push leaves the day open', globalThis.__prefs.lastBriefingDate === undefined)

// 3. Retry succeeds → delivered (trimmed), marked for today, and not repeated.
accept = true
check('accepted push is delivered', (await _briefingIfNewDay()) === true)
check('briefing text reached the UI trimmed', shown.length === 1 && shown[0].text === 'Good morning, Jes.' && shown[0].meta.kind === 'briefing')
check('day marked delivered', globalThis.__prefs.lastBriefingDate === today)
check('no second briefing the same day', (await _briefingIfNewDay()) === false && shown.length === 1)

// 4. Bounded retries: a day that keeps failing stops calling the model after the cap.
globalThis.__prefs = {}
_resetBriefingAttempts()
let calls = 0
globalThis.__gen = async () => (calls++, '')
for (let i = 0; i < 10; i++) await _briefingIfNewDay()
check('failed briefing retries are capped', calls === 4)
check('capped day is still unmarked', globalThis.__prefs.lastBriefingDate === undefined)

// 5. A callback that returns nothing (old fire-and-forget contract) still counts as delivered.
globalThis.__prefs = {}
_resetBriefingAttempts()
globalThis.__gen = async () => 'Hi.'
initProactive({ onMessage: () => {} })
stopProactive()
check('void callback counts as delivered', (await _briefingIfNewDay()) === true && globalThis.__prefs.lastBriefingDate === today)

// 6. The idle check-in is dropped when the model says it has nothing to say, however it phrases
//    SKIP (it used to post "SKIP." as a chat message and read it aloud).
const mod = await import('../src/main/proactive.js')
check('isSkip is exported', typeof mod.isSkip === 'function')
if (typeof mod.isSkip === 'function') {
  for (const t of ['SKIP', 'SKIP.', '"SKIP"', 'Skip.', ' skip ', 'SKIP — nothing useful to add'])
    check(`"${t}" is a skip`, mod.isSkip(t) === true)
  for (const t of ['Want me to make a revision plan for chemistry?', 'Skipping lunch again? Remember to eat.', 'Skip the snacks and drink some water!'])
    check(`"${t}" is a real check-in`, mod.isSkip(t) === false)
}

console.log(fail ? `smoke-proactive: ${fail} failure(s)` : 'smoke-proactive: all passed')
process.exit(fail ? 1 : 0)

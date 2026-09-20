// The global agent-run slot (provider.js withRunSlot): every run — desktop chat:send and each
// Discord channel — shares one browser / one set of terminals, so runs are serialized FIFO across
// surfaces (queued, never rejected). Verifies: ordering, the 'queued' notice (including a burst
// started in the same tick), the run context reminders/notify_user read, and that Stop while
// waiting throws without ever taking the slot. No LLM, no cost.
// Run: node --import ./scripts/lib/register-electron-stub.mjs scripts/smoke-run-slot.mjs
const { withRunSlot, currentRun, runQueueDepth, abortCurrentRun } = await import('../src/main/agent/provider.js')
const { getRunContext } = await import('../src/main/memory/db.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const failures = []
const check = (cond, what) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`)
  if (!cond) failures.push(what)
}

const log = []
const events = {}
const run = (name, ctx, body, opts = {}) =>
  withRunSlot(
    { ...opts, onEvent: (ev) => (events[name] ||= []).push(ev) },
    ctx,
    async () => {
      log.push(`${name}:start`)
      check(getRunContext()?.origin === ctx.origin, `${name} sees its own run context while holding the slot`)
      check(currentRun()?.surface === ctx.surface, `${name} is the current run while holding the slot`)
      await body?.()
      log.push(`${name}:end`)
      return name
    }
  )

// 1. Desktop run holds the slot; a Discord message arrives mid-run → queued behind 'desktop', runs after.
const A = run('desktop-A', { surface: 'desktop', origin: null }, () => sleep(60))
await sleep(5)
check(runQueueDepth() === 1 && currentRun()?.surface === 'desktop', 'desktop-A holds the slot')
const B = run('discord-B', { surface: 'discord', origin: 'discord:111' }, () => sleep(20))
// 2. Same-tick burst: C enters before anyone has yielded — still told it is queued.
const C = run('discord-C', { surface: 'discord', origin: 'discord:222' })
check(runQueueDepth() === 3, 'three runs holding/waiting')
check(events['discord-B']?.[0]?.kind === 'queued' && events['discord-B'][0].behind === 'desktop', 'B is told it is queued behind the desktop')
check(events['discord-C']?.[0]?.kind === 'queued' && events['discord-C'][0].behind === 'desktop', 'C (same tick) is told it is queued')
check(!events['desktop-A'], 'A (slot was idle) got no queued notice')

// 3. Stop while waiting: D aborts before its turn → rejects, never starts, does not block E.
const acD = new AbortController()
const D = run('discord-D', { surface: 'discord', origin: 'discord:333' }, null, { signal: acD.signal }).then(
  () => 'ran',
  (e) => `rejected:${e.message}`
)
const E = run('desktop-E', { surface: 'desktop', origin: null })
await sleep(10)
acD.abort()

const results = await Promise.all([A, B, C, D, E])
check(results[3] === 'rejected:Request aborted', `D rejected while queued (${results[3]})`)
check(!log.includes('discord-D:start'), 'D never took the slot')
check(
  log.join(',') === 'desktop-A:start,desktop-A:end,discord-B:start,discord-B:end,discord-C:start,discord-C:end,desktop-E:start,desktop-E:end',
  `FIFO, never interleaved: ${log.join(',')}`
)
check(getRunContext() === null && currentRun() === null && runQueueDepth() === 0, 'slot idle and context cleared after the last run')

// 4. A run that throws still releases the slot.
await withRunSlot({}, { surface: 'desktop', origin: null }, async () => {
  throw new Error('boom')
}).catch(() => {})
const F = await run('desktop-F', { surface: 'desktop', origin: null })
check(F === 'desktop-F' && runQueueDepth() === 0, 'slot released after a throwing run')

// 5. Cross-surface escape hatch: a stuck desktop run can be cancelled by whoever is waiting
//    (Discord `!stop all`) via abortCurrentRun(), which fires the holder's own abort hook.
check(abortCurrentRun() === null, 'abortCurrentRun is a no-op when the slot is idle')
const acG = new AbortController()
const G = run(
  'desktop-G',
  { surface: 'desktop', origin: null },
  () => new Promise((_, reject) => acG.signal.addEventListener('abort', () => reject(new Error('Request aborted')), { once: true })), // "hangs" until aborted
  { signal: acG.signal, abort: () => acG.abort() }
).then(
  () => 'ran',
  (e) => `rejected:${e.message}`
)
const H = run('discord-H', { surface: 'discord', origin: 'discord:444' })
await sleep(10)
check(currentRun()?.surface === 'desktop' && typeof currentRun().abort === 'function', 'stuck desktop run holds the slot with an abort hook')
const who = abortCurrentRun()
check(who?.surface === 'desktop', `abortCurrentRun reports the holder (${JSON.stringify(who)})`)
check(acG.signal.aborted, "the holder's own controller was aborted")
const [gRes, hRes] = await Promise.all([G, H])
check(gRes === 'rejected:Request aborted' && hRes === 'discord-H', `holder rejected, waiter then ran (${gRes}, ${hRes})`)
// A holder without an abort hook can't be cancelled from elsewhere — reported as null, not thrown.
const I = run('desktop-I', { surface: 'desktop', origin: null }, () => sleep(20))
await sleep(5)
check(abortCurrentRun() === null, 'holder without an abort hook → null')
await I
check(currentRun() === null && runQueueDepth() === 0, 'slot idle after the escape-hatch scenario')

console.log(failures.length ? `SMOKE_MISMATCH (${failures.length})` : 'SMOKE_OK')
process.exit(failures.length ? 2 : 0)

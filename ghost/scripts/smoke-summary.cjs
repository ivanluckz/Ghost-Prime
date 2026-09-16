// Smoke for the session auto-summary DB layer (no LLM, no cost). Runs the REAL db.js bundle under
// Electron against a throwaway userData dir. Verifies: migration adds the new columns, summary
// state/marking works, and saveMemory attributes a memory to an explicit (non-active) session.
//   build: npx esbuild src/main/memory/db.js --bundle --platform=node --format=cjs \
//            --external:better-sqlite3 --external:electron --outfile=scripts/_db_bundle.cjs
//   run:   ./node_modules/electron/dist/electron scripts/smoke-summary.cjs
const { app } = require('electron')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { mkdtempSync } = require('node:fs')

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

app
  .whenReady()
  .then(() => {
    app.setPath('userData', mkdtempSync(join(tmpdir(), 'ghost-sum-')))
    const db = require('./_db_bundle.cjs')
    db.initDb(process.cwd())

    const A = db.startSession()
    db.saveMessage('user', 'I am Jes, I run Chrome OS and love teal.')
    db.saveMessage('assistant', 'Noted!')
    db.saveMessage('user', 'My ongoing project is Ghost-Prime.')
    db.saveMessage('assistant', 'Got it.')

    // Switch to a NEW active session, then attribute a summary memory back to A.
    const B = db.newSession()
    db.saveMemory('User is building Ghost-Prime', 'session-summary', 5, { tags: ['session-summary'], sessionId: A })

    const state = db.sessionSummaryState(A)
    const known = db.sessionSummaryMemories(A)
    const knownForB = db.sessionSummaryMemories(B)
    db.markSessionSummarized(A, state.messageCount)
    const state2 = db.sessionSummaryState(A)

    console.log('STATE_A:', JSON.stringify(state)) // messageCount 4, summarizedAt null
    console.log('KNOWN_A:', JSON.stringify(known)) // the fact, attributed to A
    console.log('KNOWN_B:', JSON.stringify(knownForB)) // empty — not attributed to active session
    console.log('STATE_A_AFTER_MARK:', JSON.stringify(state2)) // summarizedAt set, summaryCount 4

    const ok =
      state.messageCount === 4 &&
      state.summarizedAt === null &&
      known.length === 1 &&
      known[0] === 'User is building Ghost-Prime' &&
      knownForB.length === 0 &&
      state2.summarizedAt !== null &&
      state2.summaryCount === 4

    console.log(ok ? 'SMOKE_OK' : 'SMOKE_FAIL')
    app.exit(ok ? 0 : 1)
  })
  .catch((e) => {
    console.error('SMOKE_ERROR:', e?.message || e)
    app.exit(1)
  })

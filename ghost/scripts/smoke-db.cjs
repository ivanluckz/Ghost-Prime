// Integration smoke for the persistence + memory layer. Runs the REAL db.js
// (bundled to CJS by esbuild -> scripts/_db_bundle.cjs) under real Electron, against a
// throwaway temp userData dir. Never touches the real ghost.db. No LLM, no cost.
//   build: npx esbuild src/main/memory/db.js --bundle --platform=node --format=cjs \
//            --external:better-sqlite3 --external:electron --outfile=scripts/_db_bundle.cjs
//   run:   ./node_modules/electron/dist/electron scripts/smoke-db.cjs
const { app } = require('electron')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { mkdtempSync } = require('node:fs')

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

app
  .whenReady()
  .then(() => {
    app.setPath('userData', mkdtempSync(join(tmpdir(), 'ghost-smoke-')))
    const db = require('./_db_bundle.cjs')
    db.initDb(process.cwd()) // app.getAppPath() points at scripts/ for a loose script; use cwd

    const s1 = db.startSession()
    db.saveMessage('user', 'hello there')
    db.saveMessage('assistant', 'hi! how can I help?')
    db.saveMemory('User prefers teal accents', 'preference', 8)
    db.saveMemory('User is on Chrome OS / Crostini', 'fact', 6)

    db.newSession()
    db.saveMessage('user', 'second session question')

    console.log('S1_MSGS:', JSON.stringify(db.sessionMessages(s1)))
    console.log('SESSIONS:', JSON.stringify(db.recentSessions()))
    console.log('RECALL_teal:', JSON.stringify(db.recallMemories('teal')))
    console.log('DIGEST:', JSON.stringify(db.memoryDigest()))

    const ok =
      db.sessionMessages(s1).length === 2 &&
      db.recentSessions().length === 2 &&
      db.recallMemories('teal').length === 1 &&
      db.memoryDigest().length === 2
    console.log(ok ? 'SMOKE_OK' : 'SMOKE_MISMATCH')
    app.exit(ok ? 0 : 2)
  })
  .catch((e) => {
    console.error('SMOKE_FAIL', e)
    app.exit(1)
  })

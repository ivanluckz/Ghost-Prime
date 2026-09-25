// Test-only stand-in for better-sqlite3, backed by Node's built-in node:sqlite (Node 22.5+). The
// repo's better-sqlite3 is built for Electron, so plain-Node tests can't load it. Foreign keys are
// on by default, like better-sqlite3's build. Only what src/main/memory/db.js uses.
import { DatabaseSync } from 'node:sqlite'
export default class Database {
  constructor(p) {
    this.d = new DatabaseSync(p)
    this.d.exec('PRAGMA foreign_keys = ON')
  }
  pragma(s) {
    return this.d.prepare('PRAGMA ' + s).all()
  }
  exec(s) {
    this.d.exec(s)
    return this
  }
  prepare(s) {
    const st = this.d.prepare(s)
    return { run: (...a) => st.run(...a), get: (...a) => st.get(...a), all: (...a) => st.all(...a) }
  }
  transaction(fn) {
    return (...a) => {
      this.d.exec('BEGIN')
      try {
        const r = fn(...a)
        this.d.exec('COMMIT')
        return r
      } catch (e) {
        this.d.exec('ROLLBACK')
        throw e
      }
    }
  }
  close() {
    this.d.close()
  }
}

// Minimal stand-in for the `electron` module so main-process code (provider.js, tools/index.js)
// can be smoke-tested under plain Node — the real APIs are only there inside Electron.
// Use via:  node --import ./scripts/lib/register-electron-stub.mjs scripts/<smoke>.mjs
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dataDir = process.env.GHOST_STUB_DATA_DIR || join(tmpdir(), 'ghost-prime-stub') // a test can use its own
mkdirSync(dataDir, { recursive: true })

export const app = { getPath: () => dataDir, getAppPath: () => process.cwd(), isPackaged: false, on() {} }
export class BrowserWindow {
  static getAllWindows() {
    return []
  }
}
export class Notification {
  show() {}
  static isSupported() {
    return false
  }
}
export const clipboard = { readText: () => '', writeText: () => {} }
export default { app, BrowserWindow, Notification, clipboard }

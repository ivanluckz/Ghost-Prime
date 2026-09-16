// Copy the extension into a Chrome OS ↔ Linux SHARED folder so your main Chrome can load it from
// a path that survives restarts (a container path like ~/Projects/... disappears for the host
// browser when Crostini isn't running, so the unpacked extension gets disabled on reboot).
//
// Usage:  GHOST_EXT_DEPLOY=/mnt/chromeos/MyFiles/Downloads/ghost-prime-extension npm run ext:deploy
// (Share Downloads with Linux first: Files app → Downloads → "Share with Linux".)
import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

dotenv.config() // so `npm run ext:deploy` picks up GHOST_EXT_DEPLOY straight from .env
const dest = process.env.GHOST_EXT_DEPLOY
if (!dest) {
  console.error('Set GHOST_EXT_DEPLOY to the target folder, e.g.\n  /mnt/chromeos/MyFiles/Downloads/ghost-prime-extension')
  process.exit(1)
}
const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension')
try {
  mkdirSync(dest, { recursive: true })
  cpSync(src, dest, { recursive: true })
  console.log(`Copied extension → ${dest}\nNow Load unpacked from there in chrome://extensions (once); it'll persist across restarts.`)
} catch (e) {
  console.error(`Could not copy to ${dest}: ${e.message}`)
  console.error('Is that a real shared path? Share Downloads with Linux, or point GHOST_EXT_DEPLOY at a folder you can write.')
  process.exit(1)
}

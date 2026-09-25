// Node loader hook for offline tests of main-process code under plain Node: electron,
// better-sqlite3 (→ node:sqlite), discord.js and the Claude Agent SDK are all replaced by the stubs
// in this folder. No network, no Electron, no keys.
//   node --import ./scripts/lib/register-offline-stubs.mjs scripts/<smoke>.mjs
import { register } from 'node:module'

const here = (f) => new URL(f, import.meta.url).href
const map = {
  electron: here('./electron-stub.mjs'),
  'better-sqlite3': here('./sqlite-shim.mjs'),
  'discord.js': here('./discord-stub.mjs'),
  '@anthropic-ai/claude-agent-sdk': here('./claude-sdk-stub.mjs')
}
register(
  'data:text/javascript,' +
    encodeURIComponent(`const map = ${JSON.stringify(map)}
    export async function resolve(spec, ctx, next) {
      if (map[spec]) return { url: map[spec], shortCircuit: true }
      return next(spec, ctx)
    }`),
  import.meta.url
)

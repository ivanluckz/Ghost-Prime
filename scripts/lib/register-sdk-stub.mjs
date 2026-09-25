// Node loader hook: `electron` → electron-stub.mjs and the Claude Agent SDK → claude-sdk-stub.mjs,
// so the Claude brain's wiring can be tested offline (see scripts/smoke-plan-mode.mjs).
import { register } from 'node:module'

const map = {
  electron: new URL('./electron-stub.mjs', import.meta.url).href,
  '@anthropic-ai/claude-agent-sdk': new URL('./claude-sdk-stub.mjs', import.meta.url).href
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

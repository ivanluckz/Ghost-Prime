// Boolean env flags all parse through envBool() (src/main/env.js): 0/false/off/no disable,
// 1/true/on/yes (any other value) enable, unset/blank → the flag's default.
// Run: node --import ./scripts/lib/register-electron-stub.mjs scripts/smoke-env-bool.mjs
import assert from 'node:assert/strict'
const { envBool, parseBool } = await import('../src/main/env.js')

const FLAG = 'GHOST_SMOKE_FLAG'
const cases = [
  [undefined, true, true],
  [undefined, false, false],
  ['', true, true],
  ['  ', false, false],
  ['0', true, false],
  ['false', true, false],
  ['FALSE', true, false],
  ['off', true, false],
  ['no', true, false],
  [' Off ', true, false],
  ['1', false, true],
  ['true', false, true],
  ['on', false, true],
  ['yes', false, true],
  ['TRUE', false, true],
  ['anything-else', false, true]
]
let n = 0
for (const [value, def, want] of cases) {
  if (value === undefined) delete process.env[FLAG]
  else process.env[FLAG] = value
  assert.equal(envBool(FLAG, def), want, `envBool(${JSON.stringify(value)}, ${def})`)
  assert.equal(parseBool(value, def), want, `parseBool(${JSON.stringify(value)}, ${def})`)
  n++
}
delete process.env[FLAG]

// The real flags keep their documented defaults + honour every spelling (read at call time).
delete process.env.GHOST_SCREEN_TOOLS
const tools = await import('../src/main/tools/index.js')
const names = () => tools.getToolSpecs().map((t) => t.function.name)
assert.ok(!names().includes('screen_screenshot'), 'GHOST_SCREEN_TOOLS defaults off')
process.env.GHOST_SCREEN_TOOLS = 'yes'
assert.ok(names().includes('screen_screenshot'), 'GHOST_SCREEN_TOOLS=yes enables')
process.env.GHOST_SCREEN_TOOLS = 'off'
assert.ok(!names().includes('screen_screenshot'), 'GHOST_SCREEN_TOOLS=off disables')
delete process.env.GHOST_SCREEN_TOOLS
n += 3

console.log(`smoke-env-bool: ${n} checks passed`)

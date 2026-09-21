import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Drop a bridge-config.json next to the DEPLOYED extension copy so it connects with zero typing:
// the extension reads it as its defaults (host / port / token) until the user overrides them in
// its options page. Never written into extension/ itself (the token would end up in git).
// Host: the Chrome OS host browser reaches Crostini as penguin.linux.test, but only when the
// bridge listens beyond loopback (GHOST_BRIDGE_HOST=0.0.0.0); otherwise 127.0.0.1.
export function bridgeConfigForExtension(env = process.env) {
  const bindHost = (env.GHOST_BRIDGE_HOST || '127.0.0.1').trim()
  const token = (env.GHOST_BRIDGE_TOKEN || 'ghost-local').trim()
  const offLoopback = bindHost === '0.0.0.0' && token !== 'ghost-local'
  return {
    host: offLoopback ? 'penguin.linux.test' : '127.0.0.1',
    port: Number(env.GHOST_BRIDGE_PORT) || 8731,
    token
  }
}

export function writeBridgeConfig(deployDir, env = process.env) {
  const file = join(deployDir, 'bridge-config.json')
  writeFileSync(file, JSON.stringify(bridgeConfigForExtension(env), null, 2))
  return file
}

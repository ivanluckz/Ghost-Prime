// Test-only stand-in for discord.js: login() resolves after globalThis.__discordLoginMs (default
// 300 ms) and then emits 'clientReady'; channel.send() records into globalThis.__discordSent.
import { EventEmitter } from 'node:events'
globalThis.__discordSent = globalThis.__discordSent || []
export const GatewayIntentBits = { Guilds: 1, GuildMessages: 2, DirectMessages: 4, MessageContent: 8 }
export const Partials = { Channel: 1, Message: 2 }
export const ActivityType = { Listening: 2 }
export const DiscordjsErrorCodes = { TokenInvalid: 'TokenInvalid', DisallowedIntents: 'DisallowedIntents' }
export class AttachmentBuilder {
  constructor(data, opts) {
    Object.assign(this, { data, ...opts })
  }
}
export class Client extends EventEmitter {
  constructor(opts) {
    super()
    this.opts = opts
    this.ready = false
    this.user = { tag: 'ghost-test#0001', setActivity() {} }
    const channel = (id) => ({ id, send: async (x) => globalThis.__discordSent.push({ id, content: typeof x === 'string' ? x : x?.content, at: Date.now() }) })
    this.channels = { cache: { get: (id) => channel(id) }, fetch: async (id) => channel(id) }
  }
  isReady() {
    return this.ready
  }
  async login() {
    await new Promise((r) => setTimeout(r, globalThis.__discordLoginMs ?? 300))
    this.ready = true
    this.emit('clientReady', this)
    return 'token'
  }
  destroy() {
    this.ready = false
  }
}
export default { Client, GatewayIntentBits, Partials, ActivityType, DiscordjsErrorCodes, AttachmentBuilder }

import { ipcMain } from 'electron'
import { pairingInfo } from './tools/pairing.js'
import { streamChat } from './agent/provider.js'
import {
  recentSessions,
  sessionMessages,
  newSession,
  setActiveSession,
  getSessionId,
  saveMessage,
  deleteSession,
  deleteAllSessions,
  clearAllMemory,
  allMemories,
  deleteMemory
} from './memory/db.js'
import { noteActivity } from './proactive.js'
import * as voice from './voice/index.js'
import { getActiveTabMode, setActiveTabMode } from './tools/browser.js'
import { getPolicy, setPolicy } from './tools/site-policy.js'
import { setChatState } from './tools/browser-bridge.js'
import { getHotkey, setHotkey } from './hotkey.js'
import * as shell from './tools/shell-sessions.js'
import { maybeSummarizeSession } from './memory/auto-summary.js'

// requestId -> AbortController, so the renderer can cancel an in-flight stream.
const controllers = new Map()

// A user message may be rich content (text + image parts) when files are dropped in. The DB's
// display column stores plain text, so flatten it — keep the text, note any images.
function contentToText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = content.map((p) => (p?.type === 'text' ? p.text : p?.type === 'image_url' ? '[image]' : ''))
    return parts.filter(Boolean).join(' ')
  }
  return String(content ?? '')
}

// The renderer sends each turn as { role, content, modelContent? }: `content` is what the chat
// shows (text + "📎 name" chips), `modelContent` the richer form the brain should see (inlined
// files, image parts). The brain gets the model form; the DB keeps both so a reload and every
// follow-up turn still carry the attachment.
//
// Replay is capped, though: dropped images are multi-MB data URLs and inlined files up to ~120 KB,
// and every later turn re-sends the whole history. Only the last KEEP_IMAGE_TURNS user turns keep
// their image parts (older ones become a short placeholder) and only the last KEEP_FILE_TURNS keep
// their inlined files (older ones fall back to the display text with the 📎 chips) — otherwise
// request size / token cost grow without bound and eventually trip the provider's request limit.
// The DB still holds the full form; this trims only the per-turn brain payload.
const KEEP_IMAGE_TURNS = 2
const KEEP_FILE_TURNS = 6
const IMAGE_PLACEHOLDER = { type: 'text', text: '[image attached earlier — ask the user to re-send if needed]' }
export function forBrain(messages) {
  const list = Array.isArray(messages) ? messages : []
  // Rank user turns from the end: 0 = the newest user turn, 1 = the one before, …
  let fromEnd = 0
  const rank = new Array(list.length)
  for (let i = list.length - 1; i >= 0; i--) if (list[i]?.role === 'user') rank[i] = fromEnd++
  return list.map(({ role, content, modelContent }, i) => {
    if (modelContent == null || role !== 'user') return { role, content: modelContent ?? content }
    const n = rank[i]
    if (Array.isArray(modelContent)) {
      const hasImage = modelContent.some((p) => p?.type === 'image_url')
      if (hasImage && n >= KEEP_IMAGE_TURNS) {
        // Collapse every image part to one placeholder; keep the text parts (they may hold an
        // inlined file, which is subject to the file cap below).
        let noted = false
        const parts = []
        for (const p of modelContent) {
          if (p?.type === 'image_url') {
            if (!noted) parts.push(IMAGE_PLACEHOLDER)
            noted = true
          } else parts.push(p)
        }
        modelContent = parts
      }
      if (n >= KEEP_FILE_TURNS) return { role, content } // old turn: display text + chips only
      return { role, content: modelContent }
    }
    // A string modelContent is an inlined text file (no images) — cap it the same way.
    return { role, content: n >= KEEP_FILE_TURNS ? content : modelContent }
  })
}

export function registerIpc() {
  ipcMain.handle('chat:send', async (event, { requestId, messages, mode, settings }) => {
    const controller = new AbortController()
    controllers.set(requestId, controller)
    const wc = event.sender
    const send = (channel, payload) => {
      if (!wc.isDestroyed()) wc.send(channel, payload)
    }

    // Everything — persistence included — runs inside one try so a throw anywhere (SQLITE_BUSY,
    // a malformed payload) still ends the request with chat:error; otherwise the invoke rejection
    // is swallowed in preload and the UI stays on "working…" forever.
    let partial = '' // streamed text so far — persisted on Stop / error so the session on disk keeps it
    // The chat this turn belongs to, fixed NOW: the reply lands later, and by then the user may have
    // switched chats or hit New chat (stopAll + set-active/new-session) — the reply, partial or
    // final, must still go to this session, never the one that happens to be active on completion.
    const sessionId = getSessionId()
    try {
      // Persist the new user message (the last item in the history).
      const lastUser = messages[messages.length - 1]
      if (lastUser?.role === 'user') {
        saveMessage('user', contentToText(lastUser.content), { modelContent: lastUser.modelContent, sessionId })
      }
      noteActivity() // reset the proactive-idle timer — the user is here

      const full = await streamChat({
        messages: forBrain(messages),
        mode,
        model: settings?.model,
        effort: settings?.effort,
        thinking: settings?.thinking,
        brain: settings?.brain, // 'gemini' | 'claude' | 'auto' — router override from /brain
        surface: 'desktop',
        signal: controller.signal,
        abort: () => controller.abort(), // lets another surface (Discord `!stop all`) cancel a stuck desktop run
        onDelta: (text) => {
          partial += text
          send('chat:delta', { requestId, text })
        },
        onEvent: (ev) => send('chat:tool', { requestId, ...ev })
      })
      if (full) saveMessage('assistant', full, { sessionId })
      send('chat:done', { requestId })
    } catch (err) {
      const aborted = controller.signal.aborted
      // Keep whatever was answered before the Stop / failure: the user turn is already on disk, and
      // a reload (or the next turn's context) should show the partial reply, not a dangling question.
      if (partial.trim()) {
        try {
          saveMessage('assistant', partial + (aborted ? '\n\n*[stopped]*' : `\n\n⚠️ ${err?.message || err}`), { sessionId })
        } catch {}
      }
      if (aborted) send('chat:done', { requestId, aborted: true })
      else send('chat:error', { requestId, message: err?.message || String(err) })
    } finally {
      controllers.delete(requestId)
    }
  })

  ipcMain.on('chat:abort', (_event, { requestId }) => {
    controllers.get(requestId)?.abort()
  })

  ipcMain.handle('db:recent-sessions', () => recentSessions())
  ipcMain.handle('db:session-messages', (_event, sessionId) => sessionMessages(sessionId))
  ipcMain.handle('db:new-session', (_event, parentId) => {
    const prev = getSessionId()
    const id = newSession(parentId || null)
    if (prev && prev !== id) maybeSummarizeSession(prev) // distill the chat you just left
    return id
  })
  ipcMain.handle('db:set-active-session', (_event, sessionId) => {
    const prev = getSessionId()
    const id = setActiveSession(sessionId)
    if (prev && prev !== id) maybeSummarizeSession(prev) // distill the chat you just left
    return id
  })
  ipcMain.handle('db:active-session', () => getSessionId())
  ipcMain.handle('db:delete-session', (_event, sessionId) => deleteSession(sessionId))
  ipcMain.handle('db:delete-all-sessions', () => deleteAllSessions())
  ipcMain.handle('db:memory-count', () => allMemories(100000).length)
  ipcMain.handle('db:all-memories', () => allMemories(500))
  ipcMain.handle('db:delete-memory', (_event, id) => deleteMemory(id))
  ipcMain.handle('db:clear-memory', () => clearAllMemory())

  // --- Voice ---
  ipcMain.on('voice:listen-start', () => voice.startRecording())
  ipcMain.handle('voice:listen-stop', async () => {
    try {
      return { text: await voice.stopRecordingAndTranscribe() }
    } catch (err) {
      return { error: err?.message || String(err) }
    }
  })
  ipcMain.handle('voice:tts-available', () => voice.ttsAvailable())
  ipcMain.on('voice:speak', (_event, { text }) => voice.speak(text))
  ipcMain.on('voice:stop-speaking', () => voice.stopSpeaking())

  // --- Browser: which tab to act on (own tab vs. the tab you're looking at) ---
  ipcMain.handle('browser:get-target', () => (getActiveTabMode() ? 'active' : 'group'))
  ipcMain.handle('browser:set-target', (_event, target) => {
    setActiveTabMode(target === 'active')
    return getActiveTabMode() ? 'active' : 'group'
  })

  // --- Per-site permissions ---
  ipcMain.handle('phone:pair-info', (_event, host) => pairingInfo({ host }))
  ipcMain.handle('sites:get', () => getPolicy())
  ipcMain.handle('sites:set', (_event, policy) => setPolicy(policy || {}))

  // --- Chat mirror to the Chrome side panel (only when the user turns it on) ---
  ipcMain.on('chat:mirror', (_event, { messages, mirroring }) => setChatState(messages, mirroring))

  // --- Wake-up shortcut (recordable global hotkey) ---
  ipcMain.handle('hotkey:get', () => getHotkey())
  ipcMain.handle('hotkey:set', (_event, accelerator) => setHotkey(accelerator))

  // --- Live terminals (node-pty); data/sessions are pushed to the renderer as events ---
  ipcMain.handle('shell:list', () => shell.listSessions())
  ipcMain.handle('shell:open', (_event, opts) => shell.createSession(opts || {}))
  ipcMain.handle('shell:kill', (_event, id) => shell.killSession(id))
  ipcMain.handle('shell:scrollback', (_event, id) => shell.getScrollback(id))
  ipcMain.on('shell:write', (_event, { id, data }) => shell.writeToSession(id, data))
  ipcMain.on('shell:resize', (_event, { id, cols, rows }) => shell.resizeSession(id, cols, rows))
}

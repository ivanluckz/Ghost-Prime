import { ipcMain } from 'electron'
import { streamChat } from './agent/provider.js'
import {
  recentSessions,
  sessionMessages,
  newSession,
  setActiveSession,
  getSessionId,
  saveMessage,
  deleteSession
} from './memory/db.js'
import * as voice from './voice/index.js'
import { getActiveTabMode, setActiveTabMode } from './tools/browser.js'
import { getPolicy, setPolicy } from './tools/site-policy.js'
import { setChatState } from './tools/browser-bridge.js'
import { getHotkey, setHotkey } from './hotkey.js'

// requestId -> AbortController, so the renderer can cancel an in-flight stream.
const controllers = new Map()

export function registerIpc() {
  ipcMain.handle('chat:send', async (event, { requestId, messages, mode, settings }) => {
    const controller = new AbortController()
    controllers.set(requestId, controller)
    const wc = event.sender

    // Persist the new user message (the last item in the history).
    const lastUser = messages[messages.length - 1]
    if (lastUser?.role === 'user') saveMessage('user', lastUser.content)

    try {
      const full = await streamChat({
        messages,
        mode,
        model: settings?.model,
        effort: settings?.effort,
        thinking: settings?.thinking,
        signal: controller.signal,
        onDelta: (text) => {
          if (!wc.isDestroyed()) wc.send('chat:delta', { requestId, text })
        },
        onEvent: (ev) => {
          if (!wc.isDestroyed()) wc.send('chat:tool', { requestId, ...ev })
        }
      })
      if (full) saveMessage('assistant', full)
      if (!wc.isDestroyed()) wc.send('chat:done', { requestId })
    } catch (err) {
      if (wc.isDestroyed()) return
      if (controller.signal.aborted) {
        wc.send('chat:done', { requestId, aborted: true })
      } else {
        wc.send('chat:error', { requestId, message: err?.message || String(err) })
      }
    } finally {
      controllers.delete(requestId)
    }
  })

  ipcMain.on('chat:abort', (_event, { requestId }) => {
    controllers.get(requestId)?.abort()
  })

  ipcMain.handle('db:recent-sessions', () => recentSessions())
  ipcMain.handle('db:session-messages', (_event, sessionId) => sessionMessages(sessionId))
  ipcMain.handle('db:new-session', () => newSession())
  ipcMain.handle('db:set-active-session', (_event, sessionId) => setActiveSession(sessionId))
  ipcMain.handle('db:active-session', () => getSessionId())
  ipcMain.handle('db:delete-session', (_event, sessionId) => deleteSession(sessionId))

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
  ipcMain.handle('sites:get', () => getPolicy())
  ipcMain.handle('sites:set', (_event, policy) => setPolicy(policy || {}))

  // --- Chat mirror to the Chrome side panel (only when the user turns it on) ---
  ipcMain.on('chat:mirror', (_event, { messages, mirroring }) => setChatState(messages, mirroring))

  // --- Wake-up shortcut (recordable global hotkey) ---
  ipcMain.handle('hotkey:get', () => getHotkey())
  ipcMain.handle('hotkey:set', (_event, accelerator) => setHotkey(accelerator))
}

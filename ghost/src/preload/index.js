import { contextBridge, ipcRenderer } from 'electron'

let reqCounter = 0

// The only bridge between renderer and main. No node, no remote — typed wrappers only.
contextBridge.exposeInMainWorld('ghost', {
  platform: {
    isLinux: process.platform === 'linux',
    nativeFrame: process.platform === 'linux' && process.env.GHOST_NATIVE_FRAME === '1'
  },
  sendMessage(messages, mode, settings) {
    const requestId = `req_${Date.now()}_${reqCounter++}`
    // Driven via events (chat:delta/done/error); ignore the invoke promise.
    ipcRenderer.invoke('chat:send', { requestId, messages, mode, settings }).catch(() => {})
    return requestId
  },
  abort(requestId) {
    ipcRenderer.send('chat:abort', { requestId })
  },
  onDelta(cb) {
    const listener = (_e, payload) => cb(payload)
    ipcRenderer.on('chat:delta', listener)
    return () => ipcRenderer.removeListener('chat:delta', listener)
  },
  onTool(cb) {
    const listener = (_e, payload) => cb(payload)
    ipcRenderer.on('chat:tool', listener)
    return () => ipcRenderer.removeListener('chat:tool', listener)
  },
  onDone(cb) {
    const listener = (_e, payload) => cb(payload)
    ipcRenderer.on('chat:done', listener)
    return () => ipcRenderer.removeListener('chat:done', listener)
  },
  onError(cb) {
    const listener = (_e, payload) => cb(payload)
    ipcRenderer.on('chat:error', listener)
    return () => ipcRenderer.removeListener('chat:error', listener)
  },
  recentSessions() {
    return ipcRenderer.invoke('db:recent-sessions')
  },
  sessionMessages(sessionId) {
    return ipcRenderer.invoke('db:session-messages', sessionId)
  },
  newSession(parentId) {
    return ipcRenderer.invoke('db:new-session', parentId || null)
  },
  setActiveSession(sessionId) {
    return ipcRenderer.invoke('db:set-active-session', sessionId)
  },
  activeSession() {
    return ipcRenderer.invoke('db:active-session')
  },
  deleteSession(sessionId) {
    return ipcRenderer.invoke('db:delete-session', sessionId)
  },
  deleteAllSessions() {
    return ipcRenderer.invoke('db:delete-all-sessions')
  },
  memoryCount() {
    return ipcRenderer.invoke('db:memory-count')
  },
  clearMemory() {
    return ipcRenderer.invoke('db:clear-memory')
  },
  onFocusInput(cb) {
    const listener = () => cb()
    ipcRenderer.on('focus-input', listener)
    return () => ipcRenderer.removeListener('focus-input', listener)
  },
  onExternalTask(cb) {
    const listener = (_e, payload) => cb(payload)
    ipcRenderer.on('external-task', listener)
    return () => ipcRenderer.removeListener('external-task', listener)
  },
  windowControls: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close')
  },
  // Which tab the browser tools act on: 'group' (Ghost's own tab) or 'active' (your focused tab).
  browserTarget: {
    get() {
      return ipcRenderer.invoke('browser:get-target')
    },
    set(target) {
      return ipcRenderer.invoke('browser:set-target', target)
    }
  },
  // Per-site permissions (allow/block lists + strict mode).
  sites: {
    get() {
      return ipcRenderer.invoke('sites:get')
    },
    set(policy) {
      return ipcRenderer.invoke('sites:set', policy)
    }
  },
  // Push the current transcript to the Chrome side panel (mirroring=false tells it the mirror's off).
  mirrorChat(messages, mirroring) {
    ipcRenderer.send('chat:mirror', { messages, mirroring })
  },
  // Recordable global wake-up shortcut. get() -> { accelerator, default };
  // set(accelerator) -> { ok, accelerator, default, error? } and re-registers it live.
  hotkey: {
    get() {
      return ipcRenderer.invoke('hotkey:get')
    },
    set(accelerator) {
      return ipcRenderer.invoke('hotkey:set', accelerator)
    }
  },
  // Live multi-session terminals (node-pty), shared with the agent. data/sessions arrive as events.
  shell: {
    list() {
      return ipcRenderer.invoke('shell:list')
    },
    open(opts) {
      return ipcRenderer.invoke('shell:open', opts || {})
    },
    kill(id) {
      return ipcRenderer.invoke('shell:kill', id)
    },
    scrollback(id) {
      return ipcRenderer.invoke('shell:scrollback', id)
    },
    write(id, data) {
      ipcRenderer.send('shell:write', { id, data })
    },
    resize(id, cols, rows) {
      ipcRenderer.send('shell:resize', { id, cols, rows })
    },
    onData(cb) {
      const listener = (_e, payload) => cb(payload)
      ipcRenderer.on('shell:data', listener)
      return () => ipcRenderer.removeListener('shell:data', listener)
    },
    onSessions(cb) {
      const listener = (_e, payload) => cb(payload)
      ipcRenderer.on('shell:sessions', listener)
      return () => ipcRenderer.removeListener('shell:sessions', listener)
    }
  },
  voice: {
    listenStart() {
      ipcRenderer.send('voice:listen-start')
    },
    listenStop() {
      return ipcRenderer.invoke('voice:listen-stop')
    },
    ttsAvailable() {
      return ipcRenderer.invoke('voice:tts-available')
    },
    speak(text) {
      ipcRenderer.send('voice:speak', { text })
    },
    stopSpeaking() {
      ipcRenderer.send('voice:stop-speaking')
    }
  }
})

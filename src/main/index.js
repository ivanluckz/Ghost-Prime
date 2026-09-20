// Must be the very first import: loads .env before any module below reads process.env at top level.
import './env.js'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { app, BrowserWindow, ipcMain, globalShortcut, Notification, shell } from 'electron'
import { initDb, startSession, getSessionId } from './memory/db.js'
import { registerIpc } from './ipc.js'
import { maybeSummarizeSession } from './memory/auto-summary.js'
import { initReminders, stopReminders } from './tools/reminders.js'
import { initProactive, stopProactive } from './proactive.js'
import { startBridge, onBridgeTask, watchExtensionForReload } from './tools/browser-bridge.js'
import { initHotkey } from './hotkey.js'
import { killAll as killAllShells } from './tools/shell-sessions.js'
import { startDiscord, stopDiscord } from './discord/index.js'
import { shutdownVoice } from './voice/index.js'

// Crostini: keep rendering crisp regardless of host DPI scaling. Affects only our window.
app.commandLine.appendSwitch('force-device-scale-factor', '1')

// Keep working at full speed when the window isn't focused. Ghost spends most of its time in the
// BACKGROUND while you watch Chrome do the work — but Chromium throttles unfocused/occluded
// renderers (slows timers, pauses rAF), which made the chat feel stalled the moment you clicked
// away. These switches (plus webPreferences.backgroundThrottling:false below) keep it live.
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

// GPU acceleration. Crostini's GPU is reachable once "GPU support" is on in chrome://flags, but
// Chromium blocklists virtio-gpu and the Wayland/GBM path crash-loops (exit_code=8704). So we
// force-allow the GPU and run GL through ANGLE on the X11 path (set below) — that combo is stable
// on Crostini and makes the blur/glass/animations cheap (no more software-render lag). If the
// window ever black-screens or crash-loops on launch, set GHOST_GPU=off to fall back to software.
const GHOST_GPU = (process.env.GHOST_GPU || 'on').toLowerCase() !== 'off'
if (GHOST_GPU) {
  app.commandLine.appendSwitch('ignore-gpu-blocklist')
  app.commandLine.appendSwitch('enable-gpu-rasterization')
  app.commandLine.appendSwitch('enable-zero-copy')
  app.commandLine.appendSwitch('use-gl', 'angle')
  app.commandLine.appendSwitch('use-angle', 'gl')
} else {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
}

// Ozone backend (Linux). Default Wayland — crisper rendering and proper fractional scaling on
// Crostini. Caveat: frameless Electron can drop mouse clicks on some Wayland compositors. If that
// happens, you have two escapes: GHOST_OZONE=x11 (XWayland — the old behavior, frameless + clicks)
// or GHOST_NATIVE_FRAME=1 (stay on Wayland but use the OS title bar). GHOST_OZONE=auto lets Electron pick.
const USE_NATIVE_FRAME =
  process.platform === 'linux' && process.env.GHOST_NATIVE_FRAME === '1'
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', (process.env.GHOST_OZONE || 'wayland').toLowerCase())
}

let mainWindow = null

// Pushes from main (reminders, proactive lines, external tasks) are only received once Main.jsx has
// mounted and subscribed — which happens after the Intro screen, well after app-ready. webContents.send
// with no listener is silently dropped, so buffer until the renderer says 'ui:ready', then flush.
let uiReady = false
const pending = []
function sendToUi(channel, payload) {
  if (uiReady && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
  else pending.push([channel, payload])
}
ipcMain.on('ui:ready', () => {
  uiReady = true
  const q = pending.splice(0)
  if (!mainWindow || mainWindow.isDestroyed()) return
  for (const [ch, p] of q) mainWindow.webContents.send(ch, p)
})

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 760,
    minHeight: 580,
    backgroundColor: '#04060e',
    icon: join(app.getAppPath(), 'assets', 'icon-256.png'),
    show: false,
    frame: USE_NATIVE_FRAME,
    transparent: false,
    acceptFirstMouse: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false, // keep streaming/animations live while you're over in Chrome
      autoplayPolicy: 'no-user-gesture-required', // let the intro sting + sfx play on launch
      // The preload can't see .env (renderer env), so main passes the frame decision down.
      additionalArguments: [`--ghost-native-frame=${USE_NATIVE_FRAME ? 1 : 0}`]
    }
  })

  // Reveal robustly: Crostini's software renderer can skip 'ready-to-show', which would
  // leave the process running with no visible window. Show on the first signal that arrives.
  let shown = false
  const reveal = () => {
    if (shown || !mainWindow || mainWindow.isDestroyed()) return
    shown = true
    mainWindow.show()
    mainWindow.focus()
    mainWindow.webContents.focus() // ensure the page receives keyboard/mouse input on Wayland
    console.log('[ghost] window shown')
  }
  mainWindow.once('ready-to-show', reveal)
  setTimeout(reveal, 2500)

  // Load diagnostics — surfaced in the terminal so headless verification can confirm boot.
  const wc = mainWindow.webContents
  // A committed reload/navigation re-arms push buffering until Main.jsx re-subscribes and says
  // ui:ready again. did-navigate (not did-start-loading) so a navigation we cancel below doesn't
  // strand pushes in `pending` with nobody left to re-send ui:ready.
  wc.on('did-navigate', () => {
    uiReady = false
  })

  // Reply links / window.open → the user's real browser, never a new Electron window.
  const isExternal = (u) => /^(https?:\/\/|mailto:)/i.test(u)
  wc.setWindowOpenHandler(({ url }) => {
    if (isExternal(url)) shell.openExternal(url).catch(() => {})
    return { action: 'deny' }
  })
  // Never let the main window (which carries the ghost preload/bridge) leave our own UI — e.g. a URL
  // dragged onto the window would otherwise navigate it there. loadURL/loadFile don't emit
  // will-navigate, so anything arriving here is a click/drop/location change.
  const isOwnUrl = (u) =>
    process.env.ELECTRON_RENDERER_URL
      ? u.startsWith(process.env.ELECTRON_RENDERER_URL)
      : u.startsWith('file://') && u.includes('/renderer/index.html')
  wc.on('will-navigate', (e, url) => {
    if (isOwnUrl(url)) return
    e.preventDefault()
    if (isExternal(url)) shell.openExternal(url).catch(() => {})
  })
  wc.on('will-frame-navigate', (e) => {
    if (e.isMainFrame && !isOwnUrl(e.url)) e.preventDefault()
  })
  wc.on('did-finish-load', () => {
    console.log('[ghost] renderer loaded')
    wc.executeJavaScript(
      `document.documentElement.classList.toggle('native-frame', ${USE_NATIVE_FRAME})`,
      true
    )
    reveal()
  })
  wc.on('did-fail-load', (_e, code, desc, url) =>
    console.error('[ghost] renderer failed to load:', code, desc, url)
  )
  wc.on('render-process-gone', (_e, details) =>
    console.error('[ghost] renderer process gone:', details.reason)
  )

  // Dev aid: screenshot the rendered UI to a PNG then quit. Gated by env — no effect normally.
  if (process.env.GHOST_CAPTURE) {
    wc.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await wc.capturePage()
          writeFileSync(process.env.GHOST_CAPTURE, img.toPNG())
          console.log('[ghost] captured UI ->', process.env.GHOST_CAPTURE)
        } catch (e) {
          console.error('[ghost] capture failed:', e?.message || e)
        }
        app.quit()
      }, 2200)
    })
  }

  // electron-vite sets ELECTRON_RENDERER_URL in dev (vite server); falls back to the built file.
  const skip = process.env.GHOST_CAPTURE ? '?skipIntro=1' : ''
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL + skip)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'), skip ? { search: skip } : undefined)
  }
}

// The lock is keyed on userData, which the installed launcher, `npm run dev` and the GHOST_CAPTURE
// headless-verification flow all share — so a capture run, or GHOST_SINGLE_INSTANCE=0, skips it
// rather than exiting because the everyday app is already open.
const singleInstance = !process.env.GHOST_CAPTURE && process.env.GHOST_SINGLE_INSTANCE !== '0'
const gotLock = singleInstance ? app.requestSingleInstanceLock() : true
if (!gotLock) {
  // Another Ghost-Prime already owns the Discord bot / bridge port / hotkey — hand off to it.
  console.log('[ghost] another instance is running — summoning it and exiting')
  app.quit()
} else {
  // A second launch (launcher double-click, `ghost-prime` while running) just summons the live window.
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    mainWindow.webContents.send('focus-input')
  })

  app.whenReady().then(() => {
    try {
      initDb()
      startSession()
      console.log('[ghost] sqlite ready')
    } catch (err) {
      console.error('[ghost] sqlite init failed:', err?.message || err)
    }
    registerIpc()
    startBridge() // local HTTP bridge for the Chrome extension (drives your real browser)
    startDiscord() // Discord relay — only live while Ghost-Prime runs; no-op unless DISCORD_BOT_TOKEN is set

    // Reminders: fire a desktop notification + tell the renderer (which speaks it if voice is on).
    initReminders({
      onFire: (r) => {
        try {
          if (Notification.isSupported()) new Notification({ title: 'Ghost-Prime · Reminder', body: r.text }).show()
        } catch {}
        sendToUi('reminder-fired', { text: r.text })
        if (mainWindow?.isMinimized()) mainWindow.restore()
      }
    })
    // Proactive: morning briefing + idle check-ins pushed into the chat as assistant lines.
    initProactive({
      onMessage: (text, meta) => sendToUi('proactive-message', { text, ...(meta || {}) })
    })
    // Tasks pushed up from the extension (right-click "Ask Ghost about this") or the wake daemon /
    // run-task CLI → summon now, run once the renderer is listening (cold launches arrive during Intro).
    onBridgeTask((prompt) => {
      if (!mainWindow) return
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
      sendToUi('external-task', { prompt })
    })
    // Dev: live-reload the loaded extension when its source changes (GHOST_EXT_AUTORELOAD=1).
    if (process.env.GHOST_EXT_AUTORELOAD === '1')
      watchExtensionForReload(join(app.getAppPath(), 'extension'), process.env.GHOST_EXT_DEPLOY || null)
    createWindow()

    // Custom window controls (frameless) → drive the real window.
    ipcMain.on('window:minimize', () => mainWindow?.minimize())
    ipcMain.on('window:maximize', () => {
      if (!mainWindow) return
      if (mainWindow.isMaximized()) mainWindow.unmaximize()
      else mainWindow.maximize()
    })
    ipcMain.on('window:close', () => mainWindow?.close())

    // Global wake-up shortcut — summon Ghost-Prime from anywhere and focus the input. The accelerator
    // is recordable in Settings (persisted, re-registered live) and falls back to GHOST_HOTKEY or
    // Ctrl/Cmd+Shift+G. See src/main/hotkey.js.
    initHotkey(() => {
      if (!mainWindow) return
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
      mainWindow.webContents.send('focus-input')
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

// Distill the chat you're leaving into memory on graceful quit — time-capped (3.5s) so a slow or
// unavailable model can never hang shutdown. Defers quit exactly once, then lets it proceed.
let quitSummaryDone = false
app.on('before-quit', (e) => {
  if (quitSummaryDone) return
  const sid = getSessionId()
  if (!sid) return
  quitSummaryDone = true
  e.preventDefault()
  Promise.race([maybeSummarizeSession(sid), new Promise((r) => setTimeout(r, 3500))]).finally(() => app.quit())
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  killAllShells() // terminate any live PTY shells so they don't orphan
  stopDiscord() // take the bot offline with the app
  stopReminders()
  stopProactive()
  shutdownVoice() // kill any live arecord / aplay / piper / espeak so they don't outlive the app
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

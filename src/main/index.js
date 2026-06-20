import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { app, BrowserWindow, ipcMain, globalShortcut } from 'electron'
import dotenv from 'dotenv'
import { initDb, startSession } from './memory/db.js'
import { registerIpc } from './ipc.js'
import { startBridge, onBridgeTask, watchExtensionForReload } from './tools/browser-bridge.js'
import { initHotkey } from './hotkey.js'

// Load .env from the project root. Under electron-vite dev, getAppPath() === project root.
dotenv.config({ path: join(app.getAppPath(), '.env') })

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
      autoplayPolicy: 'no-user-gesture-required' // let the intro sting + sfx play on launch
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
  // Tasks pushed up from the extension (right-click "Ask Ghost about this") → summon + run.
  onBridgeTask((prompt) => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    mainWindow.webContents.send('external-task', { prompt })
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

app.on('will-quit', () => globalShortcut.unregisterAll())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

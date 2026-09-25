// Must be the very first import: loads .env before any module below reads process.env at top level.
import { envBool } from './env.js'
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

// Ozone backend (Linux). Default x11 — the backend the GPU path below is stable on under Crostini
// (see the GPU notes). Wayland is opt-in (GHOST_OZONE=wayland): crisper fractional scaling, but
// Chromium's Wayland/GBM path can't allocate scanout buffers on virtio-gpu, so it runs software-
// rendered, and frameless Electron can drop mouse clicks on some Wayland compositors —
// GHOST_NATIVE_FRAME=1 (OS title bar) is the escape for that. GHOST_OZONE=auto lets Electron pick.
//
// GHOST_OZONE (.env) is the single source of truth. Electron resolves the backend from
// ELECTRON_OZONE_PLATFORM_HINT / --ozone-platform-hint during pre-early init — BEFORE this script
// runs — so `app.commandLine.appendSwitch('ozone-platform-hint', …)` here would be inert (verified:
// it only adds the hint switch; --ozone-platform stays whatever the env decided). The launchers
// (bin/ghost-prime, ghost-prime.sh) therefore export the hint from GHOST_OZONE up front. When the
// app is started some other way (`npx electron .`, a stray .desktop entry) with GHOST_OZONE set but
// no hint in the environment, relaunch once with the hint exported so the .env value still wins.
// Not under electron-vite dev though: the dev server exits with the first instance
// (`ps.on('close', process.exit)`), so a relaunch there would load a dead ELECTRON_RENDERER_URL —
// the `dev` script sets the hint itself instead.
const USE_NATIVE_FRAME =
  process.platform === 'linux' && envBool('GHOST_NATIVE_FRAME', false)
// Presenter ("showcase") mode: big type for a projector. bin/ghost-showcase exports
// GHOST_SHOWCASE=1; the renderer can't read env, so it rides along like the frame flag below.
const SHOWCASE = envBool('GHOST_SHOWCASE', false)
const OZONE_HINT = process.env.ELECTRON_OZONE_PLATFORM_HINT || ''
const OZONE_WANT = (process.env.GHOST_OZONE || '').trim().toLowerCase()
const OZONE_VALID = ['wayland', 'x11', 'auto']
const IS_VITE_DEV = !!process.env.ELECTRON_RENDERER_URL
// What Electron actually picked (empty switch = Chromium's default, x11).
const ozoneEffective = () => app.commandLine.getSwitchValue('ozone-platform') || 'x11'
let ozoneRelaunch = false
if (process.platform === 'linux' && OZONE_WANT) {
  if (!OZONE_VALID.includes(OZONE_WANT)) {
    console.warn(`[ghost] ignoring GHOST_OZONE='${OZONE_WANT}' (expected ${OZONE_VALID.join(' | ')})`)
  } else if (
    !OZONE_HINT && // a launcher (or the user) already decided — respect it
    !app.commandLine.hasSwitch('ozone-platform') && // explicit CLI override — respect it
    !envBool('GHOST_OZONE_RELAUNCHED', false) && // never loop, even if the env somehow isn't inherited
    OZONE_WANT !== ozoneEffective() // already what we want (x11 is the default) → nothing to do
  ) {
    if (IS_VITE_DEV) {
      console.log(
        `[ghost] ozone: not relaunching under electron-vite dev (GHOST_OZONE=${OZONE_WANT}) — set ELECTRON_OZONE_PLATFORM_HINT in the dev script`
      )
    } else {
      process.env.ELECTRON_OZONE_PLATFORM_HINT = OZONE_WANT
      process.env.GHOST_OZONE_RELAUNCHED = '1'
      console.log(`[ghost] ozone: relaunching with ELECTRON_OZONE_PLATFORM_HINT=${OZONE_WANT} (from GHOST_OZONE)`)
      app.relaunch()
      app.exit(0)
      ozoneRelaunch = true
    }
  }
}
if (process.platform === 'linux' && !ozoneRelaunch) {
  const src = OZONE_HINT ? `hint=${OZONE_HINT}` : 'no hint'
  console.log(`[ghost] ozone: ${ozoneEffective()} (${src}${OZONE_WANT ? `, GHOST_OZONE=${OZONE_WANT}` : ''})`)
}

// GPU acceleration. Crostini's GPU is reachable once "GPU support" is on in chrome://flags, but
// Chromium blocklists virtio-gpu and the Wayland/GBM path crash-loops (gbm_pixmap_wayland "Cannot
// create bo … usage=SCANOUT" → "GPU process exited unexpectedly: exit_code=8704", three times,
// before Chromium gives up and falls back to software anyway). So we force-allow the GPU and run
// GL through ANGLE ONLY on the X11 backend — that combo is stable on Crostini and makes the
// blur/glass/animations cheap (no more software-render lag). On Wayland (or auto, which resolves
// to Wayland where a compositor is present) we go straight to software rendering instead of
// crash-looping our way there. If the window ever black-screens or crash-loops on launch, set
// GHOST_GPU=0 to force software.
const GHOST_GPU = envBool('GHOST_GPU', true)
const GPU_SAFE_BACKEND = process.platform !== 'linux' || (!ozoneRelaunch && ozoneEffective() === 'x11')
if (GHOST_GPU && GPU_SAFE_BACKEND) {
  app.commandLine.appendSwitch('ignore-gpu-blocklist')
  app.commandLine.appendSwitch('enable-gpu-rasterization')
  app.commandLine.appendSwitch('enable-zero-copy')
  app.commandLine.appendSwitch('use-gl', 'angle')
  app.commandLine.appendSwitch('use-angle', 'gl')
} else {
  if (GHOST_GPU && !ozoneRelaunch) {
    console.log(`[ghost] gpu: software rendering — hardware GL is only stable on ozone=x11 (running ${ozoneEffective()})`)
  }
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
}

let mainWindow = null

// Pushes from main (reminders, proactive lines, external tasks) are only received once Main.jsx has
// mounted and subscribed — which happens after the Intro screen, well after app-ready. webContents.send
// with no listener is silently dropped, so buffer until the renderer says 'ui:ready', then flush.
let uiReady = false
let rendererCrashes = [] // times of recent renderer crashes (reload limit)
const pending = []
// Returns true when the push was sent or queued for the flush (i.e. it WILL be shown), false once the
// window is gone for good — callers like the morning briefing use that to decide whether to count
// a message as delivered.
function sendToUi(channel, payload) {
  if (mainWindow?.isDestroyed()) return false
  if (uiReady && mainWindow) mainWindow.webContents.send(channel, payload)
  else pending.push([channel, payload])
  return true
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
      // The preload can't see .env (renderer env), so main passes the frame decision (and the
      // presenter flag) down.
      additionalArguments: [`--ghost-native-frame=${USE_NATIVE_FRAME ? 1 : 0}`, `--ghost-showcase=${SHOWCASE ? 1 : 0}`]
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
  // The renderer can die (out of memory on the 4 GB Chromebook while Chrome and the Claude CLI also
  // run). It used to stay a blank window until a restart, and reminders due meanwhile were sent into
  // the dead page and lost. Now pushes queue again (uiReady=false, flushed on the next ui:ready) and
  // the window reloads, at most 3 times a minute so a crash loop can't spin.
  wc.on('render-process-gone', (_e, details) => {
    console.error('[ghost] renderer process gone:', details.reason)
    uiReady = false
    if (details.reason === 'clean-exit') return
    const now = Date.now()
    rendererCrashes = rendererCrashes.filter((t) => now - t < 60_000)
    if (rendererCrashes.length >= 3) {
      console.error('[ghost] the window keeps crashing: not reloading again (restart Ghost-Prime)')
      return
    }
    rendererCrashes.push(now)
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      console.log('[ghost] reloading the window after a renderer crash')
      mainWindow.webContents.reload()
    }, 500)
  })

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
const singleInstance = !ozoneRelaunch && !process.env.GHOST_CAPTURE && envBool('GHOST_SINGLE_INSTANCE', true)
const gotLock = singleInstance ? app.requestSingleInstanceLock() : true
if (ozoneRelaunch) {
  // Exiting so the relaunched instance (with the Ozone hint exported) can take over — don't grab
  // the single-instance lock or wire anything up on the way out.
} else if (!gotLock) {
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
    if (envBool('GHOST_EXT_AUTORELOAD', false))
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

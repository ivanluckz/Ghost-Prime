import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// EXPERIMENTAL desktop control for native Linux apps (e.g. the Discord desktop app) — screenshot +
// keyboard/mouse, beyond the browser. Off unless GHOST_SCREEN_TOOLS=1.
//
// Crostini caveats (be realistic): the Linux container can't capture the Chrome OS screen, and the
// Wayland tools (grim / ydotool) usually don't work on Sommelier. What CAN work is driving
// X11/XWayland app windows with xdotool and grabbing them with ImageMagick's `import` / scrot.
// Each function picks the first available tool and returns a clear "install X" error otherwise.

function has(cmd) {
  try {
    return spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: ['ignore', 'pipe', 'ignore'] }).status === 0
  } catch {
    return false
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `${cmd} exited ${code}`))))
  })
}

function inputTool() {
  if (has('xdotool')) return 'xdotool' // X11/XWayland — most likely to work on Crostini
  if (has('ydotool')) return 'ydotool' // Wayland uinput — needs /dev/uinput (often blocked on Crostini)
  return null
}

const noInput =
  'No input tool available. Install one: `sudo apt install -y xdotool` (drives X11/XWayland app ' +
  'windows — best on Crostini) or `ydotool` (Wayland; needs /dev/uinput).'

export async function screenScreenshot() {
  const out = join(tmpdir(), `ghost-screen-${Date.now()}.png`)
  try {
    if (has('grim')) await run('grim', [out])
    else if (has('import')) await run('import', ['-window', 'root', out])
    else if (has('scrot')) await run('scrot', ['-o', out])
    else
      throw new Error(
        'No screenshot tool. Install one: `sudo apt install -y imagemagick` (gives `import`), or grim/scrot. ' +
          'Note: on Crostini you can capture X11/Linux app windows, not the whole Chrome OS screen.'
      )
    return { base64: readFileSync(out).toString('base64') }
  } finally {
    try {
      rmSync(out, { force: true })
    } catch {}
  }
}

export async function screenType({ text } = {}) {
  const t = inputTool()
  if (!t) throw new Error(noInput)
  await run(t, ['type', '--', String(text ?? '')])
  return { ok: true }
}

export async function screenKey({ keys } = {}) {
  const t = inputTool()
  if (!t) throw new Error(noInput)
  // xdotool uses key names (Return, ctrl+c, alt+Tab). ydotool uses keycodes and may differ.
  await run(t, ['key', '--', String(keys || '')])
  return { ok: true }
}

export async function screenClick({ x, y } = {}) {
  const t = inputTool()
  if (!t) throw new Error(noInput)
  const btn = t === 'xdotool' ? '1' : '0xC0'
  if (x != null && y != null) {
    if (t === 'xdotool') await run('xdotool', ['mousemove', String(Math.round(x)), String(Math.round(y))])
    else await run('ydotool', ['mousemove', '-a', String(Math.round(x)), String(Math.round(y))])
  }
  await run(t, ['click', btn])
  return { ok: true }
}

// Launch any installed Linux app (works regardless of the above — just a process spawn).
export async function launchApp({ command } = {}) {
  if (!command || !String(command).trim()) throw new Error('launch_app needs a command, e.g. "discord" or "gtk-launch discord"')
  spawn('sh', ['-c', String(command)], { detached: true, stdio: 'ignore' }).unref()
  return { ok: true, launched: String(command) }
}

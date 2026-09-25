import { exec, execFile, spawn } from 'node:child_process'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import electron from 'electron'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)
// app.getAppPath() inside Electron; cwd fallback keeps non-Electron smoke scripts working.
const APP_ROOT = electron?.app?.getAppPath?.() || process.cwd()
const JARVIS_DIR = join(APP_ROOT, 'jarvis')
// Interpreter: JARVIS_PYTHON env → jarvis/.venv (created by `npm run jarvis:setup`) → system python3
// A failed `python3 -m venv` (no ensurepip) still leaves bin/python behind, so require bin/pip too.
const VENV_PY = join(JARVIS_DIR, '.venv', 'bin', 'python')
const VENV_PIP = join(JARVIS_DIR, '.venv', 'bin', 'pip')
const PYTHON = process.env.JARVIS_PYTHON || (existsSync(VENV_PY) && existsSync(VENV_PIP) ? VENV_PY : 'python3')
const SETUP_HINT = 'Run: npm run jarvis:setup'


// ---------------------------------------------------------------------------
// 1. Audio / Volume Control (via pactl / PulseAudio on Crostini / Linux)
// ---------------------------------------------------------------------------
// Step for up/down: positive number clamped to 100, else the 5% default (never NaN into pactl).
function volumeStep(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.min(100, Math.round(n)) : 5
}

export async function systemVolume({ action = 'get', value = null } = {}) {
  try {
    switch (action) {
      case 'get': {
        const { stdout } = await execAsync('pactl get-sink-volume @DEFAULT_SINK@')
        const match = stdout.match(/(\d+)%/)
        const muteRes = await execAsync('pactl get-sink-mute @DEFAULT_SINK@').catch(() => ({ stdout: '' }))
        const muted = /yes/i.test(muteRes.stdout)
        return {
          volume: match ? parseInt(match[1], 10) : null,
          muted,
          raw: stdout.trim()
        }
      }
      case 'set': {
        const n = value === null || value === undefined || value === '' ? NaN : Number(value)
        if (!Number.isFinite(n)) return { error: 'system_volume set requires a numeric value (0-100).' }
        const pct = Math.max(0, Math.min(100, Math.round(n)))
        await execAsync(`pactl set-sink-volume @DEFAULT_SINK@ ${pct}%`)
        return { success: true, message: `Volume set to ${pct}%` }
      }
      case 'up':
      case 'down': {
        // Work out the new level and set it: a relative "+N%" lets PulseAudio go past 100% (up to
        // 150%, painfully loud on a projector's speakers).
        const step = volumeStep(value)
        const { stdout } = await execAsync('pactl get-sink-volume @DEFAULT_SINK@')
        const m = stdout.match(/(\d+)%/)
        const cur = m ? parseInt(m[1], 10) : 50
        const pct = Math.max(0, Math.min(100, action === 'up' ? Math.min(cur, 100) + step : cur - step))
        await execAsync(`pactl set-sink-volume @DEFAULT_SINK@ ${pct}%`)
        return { success: true, volume: pct, message: `Volume ${action === 'up' ? 'up' : 'down'} to ${pct}% (was ${cur}%)` }
      }
      case 'mute': {
        await execAsync('pactl set-sink-mute @DEFAULT_SINK@ 1')
        return { success: true, message: 'Audio muted' }
      }
      case 'unmute': {
        await execAsync('pactl set-sink-mute @DEFAULT_SINK@ 0')
        return { success: true, message: 'Audio unmuted' }
      }
      case 'toggle_mute': {
        await execAsync('pactl set-sink-mute @DEFAULT_SINK@ toggle')
        return { success: true, message: 'Mute toggled' }
      }
      default:
        return { error: `Unknown volume action: ${action}. Use get, set, up, down, mute, unmute.` }
    }
  } catch (err) {
    return { error: `Audio control error: ${err.message}` }
  }
}

// ---------------------------------------------------------------------------
// 2. Brightness Control
// ---------------------------------------------------------------------------
export async function systemBrightness({ action = 'get', value = null } = {}) {
  try {
    const hasBrightnessctl = await execAsync('which brightnessctl').then(() => true).catch(() => false)
    if (hasBrightnessctl) {
      if (action === 'get') {
        const { stdout } = await execAsync('brightnessctl -m')
        // Format: device,class,curr,curr%,max
        const parts = stdout.trim().split(',')
        return { brightness: parts[3] ? parseInt(parts[3], 10) : null }
      } else if (action === 'set' && value != null) {
        const pct = Math.max(5, Math.min(100, Math.round(Number(value))))
        await execAsync(`brightnessctl set ${pct}%`)
        return { success: true, message: `Brightness set to ${pct}%` }
      } else if (action === 'up') {
        await execAsync('brightnessctl set +10%')
        return { success: true, message: 'Brightness increased by 10%' }
      } else if (action === 'down') {
        await execAsync('brightnessctl set 10%-')
        return { success: true, message: 'Brightness decreased by 10%' }
      }
    }

    // Fallback: /sys/class/backlight
    const backlightDir = '/sys/class/backlight'
    if (existsSync(backlightDir)) {
      const devices = readdirSync(backlightDir)
      if (devices.length > 0) {
        const dev = devices[0]
        const max = parseInt(readFileSync(join(backlightDir, dev, 'max_brightness'), 'utf8').trim(), 10)
        const cur = parseInt(readFileSync(join(backlightDir, dev, 'brightness'), 'utf8').trim(), 10)
        const currentPct = Math.round((cur / max) * 100)
        return {
          brightness: currentPct,
          device: dev,
          note: 'Controlled via Chrome OS host display settings for hardware brightness'
        }
      }
    }

    return { note: 'Brightness is managed by Chrome OS host system keys (brightness up/down on top row).' }
  } catch (err) {
    return { error: `Brightness error: ${err.message}` }
  }
}

// ---------------------------------------------------------------------------
// 3. System Power & Battery Status (Chromebook / Crostini)
// ---------------------------------------------------------------------------
export async function systemPower({ action = 'battery' } = {}) {
  try {
    if (action === 'battery') {
      const powerDir = '/sys/class/power_supply'
      if (existsSync(powerDir)) {
        const supplies = readdirSync(powerDir)
        let batteryInfo = null
        for (const s of supplies) {
          const ueventPath = join(powerDir, s, 'uevent')
          if (existsSync(ueventPath)) {
            const raw = readFileSync(ueventPath, 'utf8')
            const lines = raw.split('\n')
            const data = {}
            for (const l of lines) {
              const [k, v] = l.split('=')
              if (k && v) data[k.trim()] = v.trim()
            }
            if (data.POWER_SUPPLY_TYPE === 'Battery' || /BAT/i.test(s)) {
              batteryInfo = {
                capacity: data.POWER_SUPPLY_CAPACITY ? parseInt(data.POWER_SUPPLY_CAPACITY, 10) : null,
                status: data.POWER_SUPPLY_STATUS || 'Unknown',
                health: data.POWER_SUPPLY_HEALTH || 'Good',
                technology: data.POWER_SUPPLY_TECHNOLOGY || 'Li-ion'
              }
              break
            }
          }
        }
        if (batteryInfo) return batteryInfo
      }
      return { status: 'AC Connected', note: 'No discrete battery reported in container' }
    }

    // Inside the Crostini container loginctl/systemctl cannot reach the Chrome OS session,
    // so be honest instead of pretending; elsewhere let command failures reach the outer catch.
    const inCrostini = existsSync('/opt/google/cros-containers') || existsSync('/dev/.cros_milestone')

    if (action === 'lock') {
      if (inCrostini) {
        return {
          success: false,
          error: 'Cannot lock the Chrome OS screen from inside the Linux container',
          note: 'Use the Chrome OS lock key (Search+L) or the power menu.'
        }
      }
      await execAsync('loginctl lock-session')
      return { success: true, message: 'Screen locked' }
    }

    if (action === 'sleep') {
      if (inCrostini) {
        return {
          success: false,
          error: 'Cannot suspend the Chromebook from inside the Linux container',
          note: 'Close the lid or use the Chrome OS power button.'
        }
      }
      await execAsync('systemctl suspend')
      return { success: true, message: 'System suspended' }
    }

    return { error: `Unknown power action: ${action}` }
  } catch (err) {
    return { error: `Power action error: ${err.message}` }
  }
}

// ---------------------------------------------------------------------------
// 4. System Telemetry (CPU, RAM, Disk, Load)
// ---------------------------------------------------------------------------
function readCpuTimes() {
  const firstLine = readFileSync('/proc/stat', 'utf8').split('\n')[0]
  const times = firstLine.replace(/^cpu\s+/, '').split(/\s+/).map(Number)
  return { idle: times[3] + (times[4] || 0), total: times.reduce((a, b) => a + b, 0) }
}

export async function systemTelemetry() {
  try {
    // 1. RAM (from /proc/meminfo)
    const meminfo = readFileSync('/proc/meminfo', 'utf8')
    const getMemKb = (key) => {
      const m = meminfo.match(new RegExp(`${key}:\\s+(\\d+)`))
      return m ? parseInt(m[1], 10) : 0
    }
    const totalKb = getMemKb('MemTotal')
    const availKb = getMemKb('MemAvailable')
    const usedKb = totalKb - availKb
    const ramPct = totalKb > 0 ? Math.round((usedKb / totalKb) * 100) : 0

    // 2. CPU % (two /proc/stat samples 250 ms apart, so the first call already has a value)
    let cpuPct = null
    try {
      const a = readCpuTimes()
      await new Promise((r) => setTimeout(r, 250))
      const b = readCpuTimes()
      const idleDelta = b.idle - a.idle
      const totalDelta = b.total - a.total
      if (totalDelta > 0) {
        cpuPct = Math.max(0, Math.min(100, Math.round(100 * (1 - idleDelta / totalDelta))))
      }
    } catch {}

    // 3. Load average
    const loadAvg = readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/).slice(0, 3).join(', ')

    // 4. Disk space
    let disk = null
    try {
      const { stdout } = await execAsync('df -h /')
      const lines = stdout.trim().split('\n')
      if (lines.length > 1) {
        const parts = lines[1].split(/\s+/)
        disk = { size: parts[1], used: parts[2], available: parts[3], percent: parts[4] }
      }
    } catch {}

    // 5. Battery
    const bat = await systemPower({ action: 'battery' })

    return {
      cpu_usage_percent: cpuPct != null ? `${cpuPct}%` : 'Calculating…',
      ram_used: `${Math.round(usedKb / 1024)} MB / ${Math.round(totalKb / 1024)} MB (${ramPct}%)`,
      load_average: loadAvg,
      disk,
      battery: bat.capacity != null ? `${bat.capacity}% (${bat.status})` : bat.status || 'N/A',
      timestamp: new Date().toLocaleTimeString()
    }
  } catch (err) {
    return { error: `Telemetry error: ${err.message}` }
  }
}

// ---------------------------------------------------------------------------
// 5. Weather Information (wttr.in JSON)
// ---------------------------------------------------------------------------
export async function weatherGet({ location = '', units = 'metric' } = {}) {
  try {
    const loc = encodeURIComponent(String(location ?? '').trim())
    const url = `https://wttr.in/${loc}?format=j1`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'curl/7.88.1' },
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) throw new Error(`Weather service returned ${res.status}${res.status >= 500 ? ' (busy or unavailable, try again shortly)' : ''}`)
    // wttr.in answers some failures (unknown place, overload) with plain text, even with a 200.
    const body = await res.text()
    let data
    try {
      data = JSON.parse(body)
    } catch {
      const hint = body.trim().split('\n')[0].slice(0, 120)
      return { error: `The weather service didn't return a forecast for "${location || 'your location'}"${hint ? ` (it said: ${hint})` : ''}.` }
    }

    const cur = data.current_condition?.[0]
    // No current conditions (e.g. a place wttr.in doesn't know): an error, never "undefined°C".
    if (!cur || cur.temp_C == null) {
      return { error: `No weather found for "${location || 'your location'}". Try a nearby city name, e.g. "Kigali".` }
    }
    const area = data.nearest_area?.[0] || {}
    const cityName = area.areaName?.[0]?.value || location || 'Current Location'
    const region = area.region?.[0]?.value || ''
    const country = area.country?.[0]?.value || ''

    const u = String(units || 'metric').trim().toLowerCase()
    const isImperial = ['imperial', 'fahrenheit', 'f', 'us'].includes(u)
    const temp = isImperial ? `${cur.temp_F}°F` : `${cur.temp_C}°C`
    const feelsLike = isImperial ? `${cur.FeelsLikeF}°F` : `${cur.FeelsLikeC}°C`

    const forecast = (data.weather || []).slice(0, 3).map((w) => ({
      date: w.date,
      max_temp: isImperial ? `${w.maxtempF}°F` : `${w.maxtempC}°C`,
      min_temp: isImperial ? `${w.mintempF}°F` : `${w.mintempC}°C`,
      condition: w.hourly?.[4]?.weatherDesc?.[0]?.value || 'Clear'
    }))

    return {
      location: `${cityName}${region ? `, ${region}` : ''}${country ? `, ${country}` : ''}`,
      temperature: temp,
      feels_like: feelsLike,
      condition: cur.weatherDesc?.[0]?.value || 'Clear',
      humidity: `${cur.humidity}%`,
      wind: isImperial ? `${cur.windspeedMiles} mph` : `${cur.windspeedKmph} km/h`,
      uv_index: cur.uvIndex,
      forecast
    }
  } catch (err) {
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      return { error: 'Weather service timed out (no answer in 10 s). Check the internet connection.' }
    }
    if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONN|network/i.test(`${err?.message} ${err?.cause?.code || ''}`)) {
      return { error: "Couldn't reach the weather service (wttr.in). Check the internet connection." }
    }
    return { error: `Weather lookup failed: ${err.message}` }
  }
}

// ---------------------------------------------------------------------------
// 6. YouTube & Media Control
// ---------------------------------------------------------------------------
export async function youtubePlay({ query, url } = {}) {
  try {
    let targetUrl = url
    if (!targetUrl && query) {
      // encodeURIComponent leaves ' as is, which the check below refuses: "Don't Stop Me Now".
      targetUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query).replace(/'/g, '%27')}`
    }
    if (!targetUrl) return { error: 'Provide a search query or YouTube URL.' }

    // Only ever open real YouTube http(s) links — the url comes straight from the model.
    // Whitespace, quotes and control chars never appear in a genuine YouTube link.
    if (typeof targetUrl !== 'string' || /[\s"'`<>\\\x00-\x1f]/.test(targetUrl)) {
      return { error: `Invalid URL: ${targetUrl}` }
    }
    let parsed
    try {
      parsed = new URL(targetUrl)
    } catch {
      return { error: `Invalid URL: ${targetUrl}` }
    }
    // Suffix match allows music./m./www. subdomains but still rejects youtube.com.evil.com.
    const h = parsed.hostname.toLowerCase()
    const isYouTube = h === 'youtu.be' || h === 'youtube.com' || h.endsWith('.youtube.com')
      || h === 'youtube-nocookie.com' || h.endsWith('.youtube-nocookie.com')
    if (!/^https?:$/.test(parsed.protocol) || !isYouTube) {
      return { error: `Refusing to open non-YouTube URL: ${targetUrl}` }
    }

    // shell.openExternal never goes through a shell (it calls xdg-open itself on Linux).
    // Fall back to execFile('xdg-open') when electron.shell is unavailable (stub / smoke scripts).
    if (typeof electron?.shell?.openExternal === 'function') {
      await electron.shell.openExternal(parsed.href)
    } else {
      // xdg-open may block while the browser runs, so only wait for a spawn failure / early exit.
      await new Promise((resolve, reject) => {
        const child = spawn('xdg-open', [parsed.href], { detached: true, stdio: 'ignore' })
        const t = setTimeout(() => { child.unref(); resolve() }, 1000)
        child.once('error', (e) => { clearTimeout(t); reject(e) })
        child.once('exit', (code) => {
          clearTimeout(t)
          code === 0 ? resolve() : reject(new Error(`xdg-open exited with code ${code}`))
        })
      })
    }
    return { success: true, message: `Opened YouTube: ${parsed.href}` }
  } catch (err) {
    return { error: `YouTube playback error: ${err.message}` }
  }
}

// ---------------------------------------------------------------------------
// 7. Jarvis Python Action Runner Bridge
// Executes any Python tool or plugin inside jarvis/actions/*.py
// ---------------------------------------------------------------------------
export async function jarvisActionRun({ action, args = {} } = {}) {
  if (typeof action !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(action)) {
    return { error: 'Invalid action name.' }
  }
  // Some models send args as a JSON string; the Python side needs a dict either way.
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { return { error: 'args must be a JSON object' } }
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) args = {}
  try {
    const actionFile = join(JARVIS_DIR, 'actions', `${action}.py`)
    const pluginFile = join(JARVIS_DIR, 'plugins', `${action}.py`)
    const target = existsSync(actionFile) ? actionFile : existsSync(pluginFile) ? pluginFile : null

    if (!target) {
      return { error: `Action or plugin "${action}" not found in jarvis/actions or jarvis/plugins.` }
    }
    const pkg = target === actionFile ? 'actions' : 'plugins'

    // Mirrors jarvis/core/action_loader.py: load the file as `actions.<name>` / `plugins.<name>`
    // with JARVIS_DIR on sys.path so `from core import …` / `from config import …` resolve.
    // Args travel over stdin (never inlined), and every handler takes a single `parameters` dict.
    const runnerScript = `
import sys, json, importlib.util
sys.path.insert(0, ${JSON.stringify(JARVIS_DIR)})
spec = importlib.util.spec_from_file_location(${JSON.stringify(`${pkg}.${action}`)}, ${JSON.stringify(target)})
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)

args = json.load(sys.stdin)
result = None
if hasattr(mod, 'run'):
    result = mod.run(parameters=args)
elif hasattr(mod, 'TOOL') and 'handler' in mod.TOOL:
    result = mod.TOOL['handler'](parameters=args)
else:
    result = {"error": "No run() or TOOL handler found in ${action}"}

print("__JARVIS_OUT__" + json.dumps(result, default=str))
`
    // execFile: no shell, so quotes/newlines/$VAR/backticks in args are never interpreted.
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      const child = execFile(
        PYTHON,
        ['-c', runnerScript],
        { cwd: JARVIS_DIR, timeout: 30000, maxBuffer: 10 * 1024 * 1024 },
        (err, out, errOut) => (err ? reject(Object.assign(err, { stderr: errOut })) : resolve({ stdout: out, stderr: errOut }))
      )
      child.stdin.on('error', () => {})
      child.stdin.end(JSON.stringify(args))
    })

    if (stdout.includes('__JARVIS_OUT__')) {
      const raw = stdout.split('__JARVIS_OUT__')[1].trim()
      const parsed = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null) return parsed
      // Bundled handlers return plain strings; wrap so callers always get an object.
      if (typeof parsed === 'string' && /^Tool '.*' failed/.test(parsed)) return { error: parsed }
      return { result: parsed }
    }

    return { stdout: stdout.trim(), stderr: stderr.trim() }
  } catch (err) {
    if (err.killed || err.signal === 'SIGTERM') return { error: `Jarvis action "${action}" timed out after 30 s.` }
    // Only the first line of err.message: the rest is "Command failed: python -c <runner source>".
    const text = String(err.stderr || '').trim() || String(err.message || '').split('\n')[0]
    const m = /ModuleNotFoundError: No module named '([^']+)'/.exec(text)
    if (m) return { error: `Python module "${m[1]}" is not installed for ${PYTHON}. ${SETUP_HINT}` }
    return { error: `Jarvis action error: ${text.trim().split('\n').slice(-3).join('\n')}` }
  }
}

// ---------------------------------------------------------------------------
// 8. Jarvis Mobile Phone Remote Dashboard Server
// ---------------------------------------------------------------------------
let dashboardProcess = null

export async function startDashboardServer() {
  if (dashboardProcess) {
    return { status: 'already_running', port: 8000, message: 'Dashboard is already active on http://localhost:8000' }
  }

  const serverPy = join(JARVIS_DIR, 'dashboard', 'server.py')
  if (!existsSync(serverPy)) {
    return { error: 'Dashboard server script not found in jarvis/dashboard/server.py' }
  }

  // Pre-check the deps so a missing uvicorn gives an actionable error instead of a silent death.
  try {
    await execFileAsync(PYTHON, ['-c', 'import uvicorn, fastapi'], { cwd: JARVIS_DIR, timeout: 15000 })
  } catch {
    return { error: `uvicorn/fastapi are not installed for ${PYTHON}. ${SETUP_HINT}` }
  }

  try {
    const child = spawn(PYTHON, ['-m', 'uvicorn', 'dashboard.server:app', '--host', '0.0.0.0', '--port', '8000'], {
      cwd: JARVIS_DIR,
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let errBuf = ''
    child.stderr.on('data', (d) => { errBuf = (errBuf + d).slice(-4000) })
    child.on('exit', () => { if (dashboardProcess === child) dashboardProcess = null })

    // Reject if the server dies within ~1 s (bad port, import error, …) instead of reporting "started".
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, 1000)
      child.once('exit', (code) => {
        clearTimeout(t)
        reject(new Error(`uvicorn exited with code ${code}: ${errBuf.trim().split('\n').slice(-3).join('\n')}`))
      })
      child.once('error', (e) => { clearTimeout(t); reject(e) })
    })
    // Past the startup window the pipe is only a leak (and a broken pipe once Electron exits).
    child.stderr.removeAllListeners('data')
    child.stderr.destroy()
    child.unref()
    dashboardProcess = child

    return {
      status: 'started',
      port: 8000,
      url: 'http://penguin.linux.test:8000 or http://<your-chromebook-ip>:8000',
      message: 'Dashboard server running on port 8000. Open in phone browser or host Chrome.'
    }
  } catch (err) {
    return { error: `Failed to launch dashboard server: ${err.message}` }
  }
}

export function stopDashboardServer() {
  if (dashboardProcess) {
    try {
      dashboardProcess.kill()
    } catch {}
    dashboardProcess = null
    return { success: true, message: 'Dashboard server stopped.' }
  }
  return { message: 'Dashboard was not running.' }
}

import { exec, spawn } from 'node:child_process'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Notification } from 'electron'

const execAsync = promisify(exec)
const APP_ROOT = process.cwd()
const JARVIS_DIR = join(APP_ROOT, 'jarvis')



// ---------------------------------------------------------------------------
// 1. Audio / Volume Control (via pactl / PulseAudio on Crostini / Linux)
// ---------------------------------------------------------------------------
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
        const pct = Math.max(0, Math.min(100, Math.round(Number(value) || 50)))
        await execAsync(`pactl set-sink-volume @DEFAULT_SINK@ ${pct}%`)
        return { success: true, message: `Volume set to ${pct}%` }
      }
      case 'up': {
        const step = value ? Math.round(Number(value)) : 5
        await execAsync(`pactl set-sink-volume @DEFAULT_SINK@ +${step}%`)
        return { success: true, message: `Volume increased by ${step}%` }
      }
      case 'down': {
        const step = value ? Math.round(Number(value)) : 5
        await execAsync(`pactl set-sink-volume @DEFAULT_SINK@ -${step}%`)
        return { success: true, message: `Volume decreased by ${step}%` }
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

    if (action === 'lock') {
      await execAsync('loginctl lock-session').catch(() => {})
      return { success: true, message: 'Screen locked' }
    }

    if (action === 'sleep') {
      await execAsync('systemctl suspend').catch(() => {})
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
let lastCpuStat = null
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

    // 2. CPU % (from /proc/stat)
    let cpuPct = null
    try {
      const stat = readFileSync('/proc/stat', 'utf8')
      const firstLine = stat.split('\n')[0]
      const times = firstLine.replace(/^cpu\s+/, '').split(/\s+/).map(Number)
      const idle = times[3] + (times[4] || 0)
      const total = times.reduce((a, b) => a + b, 0)
      if (lastCpuStat) {
        const idleDelta = idle - lastCpuStat.idle
        const totalDelta = total - lastCpuStat.total
        if (totalDelta > 0) {
          cpuPct = Math.max(0, Math.min(100, Math.round(100 * (1 - idleDelta / totalDelta))))
        }
      }
      lastCpuStat = { idle, total }
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
    const loc = encodeURIComponent(location.trim() || '')
    const url = `https://wttr.in/${loc}?format=j1`
    const res = await fetch(url, { headers: { 'User-Agent': 'curl/7.88.1' } })
    if (!res.ok) throw new Error(`Weather service returned ${res.status}`)
    const data = await res.json()

    const cur = data.current_condition?.[0] || {}
    const area = data.nearest_area?.[0] || {}
    const cityName = area.areaName?.[0]?.value || location || 'Current Location'
    const region = area.region?.[0]?.value || ''
    const country = area.country?.[0]?.value || ''

    const isImperial = units === 'imperial' || /fahrenheit|imperial|us/i.test(units)
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
    return { error: `Weather lookup failed: ${err.message}` }
  }
}

// ---------------------------------------------------------------------------
// 6. Smart Reminders (In-memory scheduled timers + desktop notification)
// ---------------------------------------------------------------------------
const activeReminders = new Map()
let reminderSeq = 1

export function reminderSet({ text, delay_seconds, at_time } = {}) {
  let ms = 0
  if (delay_seconds && Number(delay_seconds) > 0) {
    ms = Number(delay_seconds) * 1000
  } else if (at_time) {
    const target = new Date(at_time).getTime()
    const now = Date.now()
    if (!isNaN(target) && target > now) ms = target - now
  }
  if (ms <= 0) ms = 60000 // default 1 min

  const id = `rem_${reminderSeq++}`
  const scheduledTime = new Date(Date.now() + ms).toLocaleTimeString()

  const timer = setTimeout(() => {
    activeReminders.delete(id)
    try {
      if (Notification.isSupported()) {
        new Notification({
          title: 'Jarvis Reminder',
          body: text,
          silent: false
        }).show()
      }
    } catch {}
  }, ms)

  activeReminders.set(id, { id, text, scheduledTime, timer, targetMs: Date.now() + ms })
  return {
    id,
    message: `Reminder set for ${scheduledTime}: "${text}"`,
    delay_minutes: (ms / 60000).toFixed(1)
  }
}

export function reminderList() {
  const list = []
  for (const [id, r] of activeReminders.entries()) {
    const leftSec = Math.max(0, Math.round((r.targetMs - Date.now()) / 1000))
    list.push({ id, text: r.text, scheduledTime: r.scheduledTime, secondsRemaining: leftSec })
  }
  return { reminders: list }
}

export function reminderCancel({ id } = {}) {
  const r = activeReminders.get(id)
  if (r) {
    clearTimeout(r.timer)
    activeReminders.delete(id)
    return { success: true, message: `Reminder "${r.text}" cancelled.` }
  }
  return { error: `No reminder found with ID: ${id}` }
}

// ---------------------------------------------------------------------------
// 7. YouTube & Media Control
// ---------------------------------------------------------------------------
export async function youtubePlay({ query, url } = {}) {
  try {
    let targetUrl = url
    if (!targetUrl && query) {
      targetUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
    }
    if (!targetUrl) return { error: 'Provide a search query or YouTube URL.' }

    // Use xdg-open to launch in Chrome OS browser or default browser
    exec(`xdg-open "${targetUrl}"`)
    return { success: true, message: `Opened YouTube: ${targetUrl}` }
  } catch (err) {
    return { error: `YouTube playback error: ${err.message}` }
  }
}

// ---------------------------------------------------------------------------
// 8. Jarvis Python Action Runner Bridge
// Executes any Python tool or plugin inside jarvis/actions/*.py
// ---------------------------------------------------------------------------
export async function jarvisActionRun({ action, args = {} } = {}) {
  try {
    const actionFile = join(JARVIS_DIR, 'actions', `${action}.py`)
    const pluginFile = join(JARVIS_DIR, 'plugins', `${action}.py`)
    const target = existsSync(actionFile) ? actionFile : existsSync(pluginFile) ? pluginFile : null

    if (!target) {
      return { error: `Action or plugin "${action}" not found in jarvis/actions or jarvis/plugins.` }
    }

    const runnerScript = `
import sys, json, os
sys.path.insert(0, '${JARVIS_DIR}')
import ${action} as mod

args = json.loads('''${JSON.stringify(args).replace(/'/g, "\\'")}''')
result = None
if hasattr(mod, 'run'):
    result = mod.run(**args)
elif hasattr(mod, 'TOOL') and 'handler' in mod.TOOL:
    result = mod.TOOL['handler'](**args)
else:
    result = {"error": "No run() or TOOL handler found in ${action}"}

print("__JARVIS_OUT__" + json.dumps(result, default=str))
`
    const { stdout, stderr } = await execAsync(`python3 -c "${runnerScript.replace(/"/g, '\\"')}"`, {
      cwd: JARVIS_DIR,
      timeout: 30000
    })

    if (stdout.includes('__JARVIS_OUT__')) {
      const raw = stdout.split('__JARVIS_OUT__')[1].trim()
      return JSON.parse(raw)
    }

    return { stdout: stdout.trim(), stderr: stderr.trim() }
  } catch (err) {
    return { error: `Jarvis action error: ${err.message}` }
  }
}

// ---------------------------------------------------------------------------
// 9. Jarvis Mobile Phone Remote Dashboard Server
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

  try {
    dashboardProcess = spawn('python3', ['-m', 'uvicorn', 'dashboard.server:app', '--host', '0.0.0.0', '--port', '8000'], {
      cwd: JARVIS_DIR,
      detached: true,
      stdio: 'ignore'
    })
    dashboardProcess.unref()

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

// Audio layer for Ghost-Prime — intro sting, activation swell, and a (future) ambient bed,
// all behind one master-mute toggle that persists across launches.
//
// Files live in /assets and are imported as Vite asset URLs:
//   suno.mp3       → cinematic intro sting (plays over the muted intro video)
//   eleverlabs.mp3 → activation swell (fires when a task starts / the Core goes "thinking")
//
// The ambient hum (Stable Audio) isn't generated yet. To enable the looping bed later:
//   1. drop the file at assets/ambient.mp3
//   2. uncomment the import below + the two lines inside startAmbient()
//   3. call startAmbient()/stopAmbient() from the Core's busy state in Main.jsx.

import introSting from '@assets/suno.mp3'
import activateSwell from '@assets/eleverlabs.mp3'
// import ambientHum from '@assets/ambient.mp3' // TODO: enable once the Stable Audio loop exists

const MUTE_KEY = 'ghost.audio.muted'

let muted = (() => {
  try {
    return localStorage.getItem(MUTE_KEY) === '1'
  } catch {
    return false
  }
})()

const listeners = new Set()
const emit = () => listeners.forEach((fn) => {
  try {
    fn(muted)
  } catch {}
})

// Lazily-created elements so importing this module never touches the audio device.
let introEl = null
let ambientEl = null

function make(src, { loop = false, volume = 1 } = {}) {
  const a = new Audio(src)
  a.loop = loop
  a.volume = volume
  a.preload = 'auto'
  return a
}

export function isMuted() {
  return muted
}

export function setMuted(next) {
  muted = !!next
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0')
  } catch {}
  if (introEl) introEl.muted = muted
  if (ambientEl) ambientEl.muted = muted
  emit()
}

export function toggleMuted() {
  setMuted(!muted)
  return muted
}

// Subscribe to mute changes (so a toggle button anywhere stays in sync). Returns an unsubscribe fn.
export function onMuteChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// One-shot activation swell. A fresh element per call so rapid task-starts overlap cleanly.
export function playActivate() {
  if (muted) return
  try {
    make(activateSwell, { volume: 0.5 }).play().catch(() => {})
  } catch {}
}

// Intro sting — plays alongside the (muted) intro video. Returns its stop fn for convenience.
export function playIntro() {
  try {
    introEl = make(introSting, { volume: 0.6 })
    introEl.muted = muted
    introEl.play().catch(() => {})
  } catch {}
  return stopIntro
}

export function stopIntro() {
  if (!introEl) return
  try {
    introEl.pause()
    introEl.currentTime = 0
  } catch {}
  introEl = null
}

// Ambient bed under the Core. No-op until assets/ambient.mp3 + its import are enabled.
export function startAmbient() {
  // if (ambientEl || muted) return
  // ambientEl = make(ambientHum, { loop: true, volume: 0.22 })
  // ambientEl.play().catch(() => {})
}

export function stopAmbient() {
  if (!ambientEl) return
  try {
    ambientEl.pause()
  } catch {}
  ambientEl = null
}

// Live accent theming. Recolours the HUD's accent (everything that keys off --accent / --cyan)
// from a single hue, persisted per-device. The 3D Core reads its palette at construction, so a
// hue change fully applies to it on the next launch; the rest of the UI updates instantly.
const KEY = 'ghost.accentHue'
export const DEFAULT_HUE = 188 // ≈ the stock cyan (#00e6ff)

export function getSavedHue() {
  try {
    const v = localStorage.getItem(KEY)
    return v == null ? null : Number(v)
  } catch {
    return null
  }
}

export function applyAccent(hue, { persist = true } = {}) {
  const h = (((Number(hue) || 0) % 360) + 360) % 360
  const s = document.documentElement.style
  const c = `hsl(${h}, 92%, 60%)`
  s.setProperty('--accent', c)
  s.setProperty('--cyan', c)
  s.setProperty('--glow-cyan', `0 0 22px hsla(${h}, 92%, 60%, 0.42)`)
  if (persist) {
    try {
      localStorage.setItem(KEY, String(h))
    } catch {}
  }
  return h
}

export function resetAccent() {
  const s = document.documentElement.style
  s.removeProperty('--accent')
  s.removeProperty('--cyan')
  s.removeProperty('--glow-cyan')
  try {
    localStorage.removeItem(KEY)
  } catch {}
}

// Apply the saved hue on launch (no-op if the user never customized it).
export function initAccent() {
  const h = getSavedHue()
  if (h != null && !Number.isNaN(h)) applyAccent(h, { persist: false })
}

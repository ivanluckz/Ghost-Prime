import { useEffect, useRef, useState } from 'react'
import { applyAccent, resetAccent, getSavedHue, DEFAULT_HUE } from '../theme.js'

// A few one-tap accent presets (hue degrees) alongside the free hue slider.
const HUE_SWATCHES = [188, 210, 260, 300, 330, 12, 45, 150]

// Turn a browser keydown into an Electron accelerator (e.g. "CommandOrControl+Shift+G").
function normalizeKey(e) {
  const k = e.key
  if (['Control', 'Shift', 'Alt', 'Meta', 'OS', 'AltGraph'].includes(k)) return null // bare modifier
  if (k === ' ' || e.code === 'Space') return 'Space'
  if (/^Arrow/.test(k)) return k.replace('Arrow', '') // Up/Down/Left/Right
  if (/^F\d{1,2}$/.test(k)) return k // F1–F24
  if (k.length === 1) return k.toUpperCase() // letters, digits, symbols
  const named = { Escape: 'Esc', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown' }
  return named[k] || null
}

function eventToAccelerator(e) {
  const mods = []
  if (e.ctrlKey) mods.push('CommandOrControl')
  if (e.metaKey) mods.push('Super')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  const key = normalizeKey(e)
  return { mods, key, accelerator: key ? [...mods, key].join('+') : null }
}

// Human-friendly rendering of an accelerator for the chip.
function prettyAccel(acc) {
  if (!acc) return '—'
  return acc
    .split('+')
    .map((p) => (p === 'CommandOrControl' ? 'Ctrl' : p))
    .join(' + ')
}

// Settings popover: the three "Claude-for-Chrome parity" controls in one place so the topbar stays
// clean — which tab Ghost drives, whether the chat mirrors into Chrome's side panel, and per-site
// access. Tab target and site policy live in the main process; we load + save them here. The
// mirror toggle is lifted to Main (it drives the push), so it comes in as a prop.
export default function SettingsPanel({ onClose, mirror, onMirrorChange, onChatsCleared }) {
  const [target, setTarget] = useState('active')

  const [policy, setPolicy] = useState({ mode: 'open', allow: [], block: [] })
  const [allowInput, setAllowInput] = useState('')
  const [blockInput, setBlockInput] = useState('')
  const [hotkey, setHotkey] = useState('')
  const [hkDefault, setHkDefault] = useState('')
  const [recording, setRecording] = useState(false)
  const [pending, setPending] = useState('')
  const [hkError, setHkError] = useState('')
  const [memCount, setMemCount] = useState(null)
  const [confirm, setConfirm] = useState('') // '' | 'chats' | 'memory' — two-step danger confirm
  const [hue, setHue] = useState(getSavedHue() ?? DEFAULT_HUE)
  const [memList, setMemList] = useState(null) // null = not loaded; [] = loaded, empty
  const ref = useRef(null)

  function changeHue(h) {
    setHue(h)
    applyAccent(h)
  }
  function resetHue() {
    resetAccent()
    setHue(DEFAULT_HUE)
  }

  function loadMemories() {
    window.ghost
      .allMemories?.()
      .then((rows) => setMemList(rows || []))
      .catch(() => setMemList([]))
  }
  function deleteOneMemory(id) {
    window.ghost.deleteMemory?.(id).then(() => {
      setMemList((prev) => (prev || []).filter((m) => m.id !== id))
      setMemCount((c) => (c == null ? c : Math.max(0, c - 1)))
    })
  }

  useEffect(() => {
    window.ghost.browserTarget?.get().then(setTarget).catch(() => {})
    window.ghost.sites?.get().then(setPolicy).catch(() => {})
    window.ghost.memoryCount?.().then(setMemCount).catch(() => {})
    window.ghost.hotkey
      ?.get()
      .then((h) => {
        if (!h) return
        setHotkey(h.accelerator || '')
        setHkDefault(h.default || '')
      })
      .catch(() => {})
  }, [])

  // While recording, capture the next chord and register it live. Capture-phase + stopPropagation
  // keeps Escape (cancel) from bubbling to the panel's close handler.
  useEffect(() => {
    if (!recording) return
    const onKey = (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(false)
        setPending('')
        setHkError('')
        return
      }
      const { mods, key, accelerator } = eventToAccelerator(e)
      if (!key) {
        setPending(mods.map((m) => (m === 'CommandOrControl' ? 'Ctrl' : m)).join(' + ') + (mods.length ? ' + …' : '…'))
        return
      }
      if (!mods.length) {
        setHkError('Add a modifier — Ctrl, Alt, or Super — so it won’t fire while you type.')
        setPending(prettyAccel(accelerator))
        return
      }
      setRecording(false)
      setPending('')
      setHkError('')
      window.ghost.hotkey
        ?.set(accelerator)
        .then((res) => {
          if (res?.ok) {
            setHotkey(res.accelerator)
          } else {
            setHotkey(res?.accelerator || hotkey)
            setHkError(res?.error ? `Couldn’t use that one (${res.error}). Try another.` : 'Couldn’t use that combo. Try another.')
          }
        })
        .catch(() => setHkError('Could not save the shortcut.'))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, hotkey])

  function resetHotkey() {
    if (!hkDefault) return
    window.ghost.hotkey
      ?.set(hkDefault)
      .then((res) => {
        setHotkey(res?.accelerator || hkDefault)
        setHkError('')
      })
      .catch(() => {})
  }

  // Two-step confirm for destructive actions: first click arms, second (within 3s) fires.
  function danger(key, fn) {
    if (confirm === key) {
      setConfirm('')
      fn()
    } else {
      setConfirm(key)
      setTimeout(() => setConfirm((c) => (c === key ? '' : c)), 3000)
    }
  }

  function doClearChats() {
    onChatsCleared?.() // Main wipes the DB chats, resets the visible chat, refreshes the list
    onClose()
  }

  function doClearMemory() {
    window.ghost.clearMemory?.().then(() => setMemCount(0)).catch(() => {})
  }

  // Close on outside-click or Escape.
  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    const onKey = (e) => e.key === 'Escape' && onClose()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  function changeTarget(t) {
    setTarget(t)
    window.ghost.browserTarget?.set(t).catch(() => {})
  }

  function savePolicy(next) {
    setPolicy(next)
    window.ghost.sites?.set(next).then(setPolicy).catch(() => {})
  }

  const clean = (d) =>
    d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '')

  function addDomain(list) {
    const input = list === 'allow' ? allowInput : blockInput
    const d = clean(input)
    if (!d) return
    savePolicy({ ...policy, [list]: [...new Set([...(policy[list] || []), d])] })
    list === 'allow' ? setAllowInput('') : setBlockInput('')
  }

  function removeDomain(list, d) {
    savePolicy({ ...policy, [list]: (policy[list] || []).filter((x) => x !== d) })
  }

  const DomainList = ({ list, value, onValue }) => (
    <div className="set-domains">
      <div className="set-chips">
        {(policy[list] || []).length === 0 && <span className="set-empty">none</span>}
        {(policy[list] || []).map((d) => (
          <span className="set-chip" key={d}>
            {d}
            <button onClick={() => removeDomain(list, d)} aria-label={`Remove ${d}`}>
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="set-add">
        <input
          value={value}
          onChange={(e) => onValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addDomain(list))}
          placeholder={list === 'allow' ? 'allow a domain, e.g. github.com' : 'block a domain, e.g. mybank.com'}
        />
        <button onClick={() => addDomain(list)}>Add</button>
      </div>
    </div>
  )

  return (
    <div className="settings-pop" ref={ref} role="dialog" aria-label="Settings">
      <div className="set-head">
        <span>Settings</span>
        <button className="set-close" onClick={onClose} aria-label="Close settings">
          ✕
        </button>
      </div>

      <section className="set-section">
        <div className="set-title">Browser acts on</div>
        <div className="set-seg">
          <button className={target !== 'active' ? 'on' : ''} onClick={() => changeTarget('group')}>
            Its own tab
          </button>
          <button className={target === 'active' ? 'on' : ''} onClick={() => changeTarget('active')}>
            The tab I'm on
          </button>
        </div>
        <p className="set-note">
          {target === 'active'
            ? 'Ghost drives whatever tab you’re looking at, and automatically sees it when you ask about “this page” — like Claude for Chrome.'
            : 'Ghost works in its own “Ghost-Prime” tab group, never touching your current tab.'}
        </p>
      </section>

      <section className="set-section">
        <label className="set-row">
          <span>
            <div className="set-title">Mirror chat to Chrome</div>
            <p className="set-note">Show this conversation in Chrome’s side panel (click the Ghost icon in Chrome).</p>
          </span>
          <input type="checkbox" className="set-switch" checked={!!mirror} onChange={(e) => onMirrorChange(e.target.checked)} />
        </label>
      </section>

      <section className="set-section">
        <div className="set-title">Accent colour</div>
        <p className="set-note">Recolour the HUD accent. The 3D core adopts a new colour on next launch.</p>
        <div className="set-swatches">
          {HUE_SWATCHES.map((h) => (
            <button
              key={h}
              className={`set-swatch${Math.round(hue) === h ? ' on' : ''}`}
              style={{ background: `hsl(${h}, 92%, 60%)` }}
              onClick={() => changeHue(h)}
              aria-label={`Accent hue ${h}`}
            />
          ))}
        </div>
        <input
          type="range"
          min="0"
          max="359"
          value={Math.round(hue)}
          className="set-hue"
          onChange={(e) => changeHue(Number(e.target.value))}
          style={{ accentColor: `hsl(${hue}, 92%, 60%)` }}
        />
        <div className="set-hotkey" style={{ marginTop: 6 }}>
          <kbd className="hk-combo" style={{ color: `hsl(${hue}, 92%, 66%)` }}>
            hue {Math.round(hue)}°
          </kbd>
          <button onClick={resetHue}>Reset</button>
        </div>
      </section>

      <section className="set-section">
        <div className="set-title">Wake-up shortcut</div>
        <p className="set-note">Press this from anywhere to summon Ghost-Prime and jump straight to the input.</p>
        <div className="set-hotkey">
          <kbd className="hk-combo">{recording ? pending || 'Press keys…' : prettyAccel(hotkey)}</kbd>
          <button
            className={recording ? 'on' : ''}
            onClick={() => {
              setHkError('')
              setPending('')
              setRecording((r) => !r)
            }}
          >
            {recording ? 'Cancel' : 'Record'}
          </button>
          {!recording && hkDefault && hotkey !== hkDefault && <button onClick={resetHotkey}>Reset</button>}
        </div>
        {hkError && <p className="set-note set-warn">{hkError}</p>}
      </section>

      <section className="set-section">
        <div className="set-title">Site access</div>
        <div className="set-seg">
          <button className={policy.mode !== 'strict' ? 'on' : ''} onClick={() => savePolicy({ ...policy, mode: 'open' })}>
            Open
          </button>
          <button className={policy.mode === 'strict' ? 'on' : ''} onClick={() => savePolicy({ ...policy, mode: 'strict' })}>
            Strict
          </button>
        </div>
        <p className="set-note">
          {policy.mode === 'strict'
            ? 'Ghost may only act on allow-listed sites (and never blocked ones).'
            : 'Ghost may act anywhere except blocked sites.'}
        </p>
        {policy.mode === 'strict' && (
          <>
            <div className="set-sub">Allowed sites</div>
            <DomainList list="allow" value={allowInput} onValue={setAllowInput} />
          </>
        )}
        <div className="set-sub">Blocked sites</div>
        <DomainList list="block" value={blockInput} onValue={setBlockInput} />
      </section>

      <section className="set-section">
        <div className="set-title">Memory{memCount ? ` (${memCount})` : ''}</div>
        <p className="set-note">Everything Ghost has remembered about you across chats. Delete anything you don’t want kept.</p>
        {memList === null ? (
          <button onClick={loadMemories}>Show what Ghost remembers</button>
        ) : memList.length === 0 ? (
          <p className="set-empty">Nothing remembered yet.</p>
        ) : (
          <div className="set-memlist">
            {memList.map((m) => (
              <div className="set-memrow" key={m.id}>
                <span className="set-memtype">{m.type}</span>
                <span className="set-memtext">{m.content}</span>
                <button className="set-memdel" onClick={() => deleteOneMemory(m.id)} aria-label="Delete this memory">
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="set-section set-danger">
        <div className="set-title">Reset</div>
        <p className="set-note">Permanent — these can’t be undone.</p>
        <div className="set-danger-row">
          <button
            className={`set-danger-btn${confirm === 'chats' ? ' armed' : ''}`}
            onClick={() => danger('chats', doClearChats)}
            title="Delete every saved chat and start fresh"
          >
            {confirm === 'chats' ? 'Click again to delete all chats' : 'Delete all chats'}
          </button>
          <button
            className={`set-danger-btn${confirm === 'memory' ? ' armed' : ''}`}
            onClick={() => danger('memory', doClearMemory)}
            title="Erase everything Ghost has remembered across sessions"
          >
            {confirm === 'memory'
              ? 'Click again to erase memory'
              : `Delete all memory${memCount ? ` (${memCount})` : ''}`}
          </button>
        </div>
      </section>
    </div>
  )
}

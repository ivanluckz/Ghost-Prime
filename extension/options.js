const DEFAULTS = { host: '127.0.0.1', port: 8731, token: 'ghost-local', glow: true, quietDebugger: false }
const $ = (id) => document.getElementById(id)

const vals = () => ({
  host: $('host').value.trim() || DEFAULTS.host,
  port: Number($('port').value) || DEFAULTS.port,
  token: $('token').value.trim() || DEFAULTS.token
})

// Warn while the bridge token is still the shipped default — anyone on this machine who knows that
// public string could drive the browser (the extension holds <all_urls> + debugger).
function updateTokenWarn() {
  const w = $('tokenWarn')
  const isDefault = vals().token === 'ghost-local'
  w.textContent = isDefault
    ? '⚠ Using the default token “ghost-local”. Set a private token here and as GHOST_BRIDGE_TOKEN in the app’s .env — anyone who knows this token could drive your browser.'
    : ''
  w.style.display = isDefault ? 'block' : 'none'
}

// Prefill from bridge-config.json (written by the app next to the deployed copy) when nothing is saved.
const fileDefaults = () =>
  fetch(chrome.runtime.getURL('bridge-config.json'))
    .then((r) => (r.ok ? r.json() : {}))
    .then((j) => ({ ...(j.host ? { host: j.host } : {}), ...(Number(j.port) ? { port: Number(j.port) } : {}), ...(j.token ? { token: j.token } : {}) }))
    .catch(() => ({}))
fileDefaults()
  .then((fd) => chrome.storage.sync.get({ ...DEFAULTS, ...fd }).then((c) => {
    for (const k of ['host', 'port', 'token']) if (fd[k] != null) c[k] = fd[k] // the app-written config is authoritative
    return c
  }))
  .then((c) => {
  $('host').value = c.host
  $('port').value = c.port
  $('token').value = c.token
  $('glow').checked = c.glow !== false
  $('quietDebugger').checked = !!c.quietDebugger
  updateTokenWarn()
})

$('token').addEventListener('input', updateTokenWarn)

$('reveal').addEventListener('click', () => {
  const t = $('token')
  const show = t.type === 'password'
  t.type = show ? 'text' : 'password'
  $('reveal').textContent = show ? 'hide' : 'show'
})

$('save').addEventListener('click', async () => {
  await chrome.storage.sync.set({
    ...vals(),
    glow: $('glow').checked,
    quietDebugger: $('quietDebugger').checked
  })
  const s = $('status')
  s.className = 'ok'
  s.textContent = 'saved ✓'
  setTimeout(() => (s.textContent = ''), 1500)
})

// Probe the bridge with the values currently in the form (before saving), so you can confirm
// host/port/token are right instead of finding out from the toolbar badge later.
$('test').addEventListener('click', async () => {
  const { host, port, token } = vals()
  const s = $('status')
  s.className = 'ok'
  s.textContent = 'testing…'
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), 4000)
  try {
    const r = await fetch(`http://${host}:${port}/ping?token=${encodeURIComponent(token)}`, { signal: ctrl.signal })
    if (r.status === 403) {
      s.className = 'bad'
      s.textContent = '✗ wrong token'
    } else if (!r.ok) {
      s.className = 'bad'
      s.textContent = `✗ HTTP ${r.status}`
    } else {
      const j = await r.json().catch(() => ({}))
      s.className = 'ok'
      s.textContent = j.connected ? '✓ connected — a browser is live' : '✓ bridge up (no browser yet)'
    }
  } catch {
    s.className = 'bad'
    s.textContent = ctrl.signal.aborted ? '✗ no response — is the Ghost-Prime app running?' : '✗ could not reach the bridge'
  } finally {
    clearTimeout(to)
  }
})

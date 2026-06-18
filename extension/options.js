const DEFAULTS = { host: '127.0.0.1', port: 8731, token: 'ghost-local', glow: true, quietDebugger: false }
const $ = (id) => document.getElementById(id)

chrome.storage.sync.get(DEFAULTS).then((c) => {
  $('host').value = c.host
  $('port').value = c.port
  $('token').value = c.token
  $('glow').checked = c.glow !== false
  $('quietDebugger').checked = !!c.quietDebugger
})

$('save').addEventListener('click', async () => {
  await chrome.storage.sync.set({
    host: $('host').value.trim() || DEFAULTS.host,
    port: Number($('port').value) || DEFAULTS.port,
    token: $('token').value.trim() || DEFAULTS.token,
    glow: $('glow').checked,
    quietDebugger: $('quietDebugger').checked
  })
  const s = $('status')
  s.textContent = 'saved ✓'
  setTimeout(() => (s.textContent = ''), 1500)
})

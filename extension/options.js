const DEFAULTS = { host: '127.0.0.1', port: 8731, token: 'ghost-local' }

chrome.storage.sync.get(DEFAULTS).then(({ host, port, token }) => {
  document.getElementById('host').value = host
  document.getElementById('port').value = port
  document.getElementById('token').value = token
})

document.getElementById('save').addEventListener('click', async () => {
  const host = document.getElementById('host').value.trim() || DEFAULTS.host
  const port = Number(document.getElementById('port').value) || DEFAULTS.port
  const token = document.getElementById('token').value.trim() || DEFAULTS.token
  await chrome.storage.sync.set({ host, port, token })
  const s = document.getElementById('status')
  s.textContent = 'saved ✓'
  setTimeout(() => (s.textContent = ''), 1500)
})

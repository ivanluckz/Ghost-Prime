// Ghost-Prime chat side panel. Long-polls the app's local bridge for the mirrored transcript and
// renders it; the input box sends messages up to the app via /task (same channel as right-click
// "Ask Ghost"). The app only mirrors when you turn it on (Settings → "Mirror chat to Chrome").

const DEFAULTS = { host: '127.0.0.1', port: 8731, token: 'ghost-local' }
let cfg = { ...DEFAULTS }
let seq = -1
let stopped = false
let localSent = false // user has sent from this panel while mirroring is off — keep their bubble

const base = () => `http://${cfg.host || '127.0.0.1'}:${cfg.port}`
const url = (path, params = '') => `${base()}${path}?token=${encodeURIComponent(cfg.token)}${params}`

const logEl = document.getElementById('log')
const emptyEl = document.getElementById('empty')
const emptyMsg = document.getElementById('emptyMsg')
const dotEl = document.getElementById('dot')
const hintEl = document.getElementById('hint')
const boxEl = document.getElementById('box')
const sendEl = document.getElementById('send')

async function loadCfg() {
  try {
    cfg = await chrome.storage.sync.get(DEFAULTS)
  } catch {
    cfg = { ...DEFAULTS }
  }
}

function setConnected(on) {
  dotEl.classList.toggle('live', !!on)
  dotEl.title = on ? 'connected to Ghost-Prime' : 'waiting for Ghost-Prime…'
}

// Render message text WITHOUT innerHTML (stays XSS-proof): plain text nodes, with http(s) URLs
// turned into real links. The trailing class excludes common sentence punctuation from the link.
const URL_RE = /https?:\/\/[^\s<>()]+[^\s<>().,!?:;'"]/g
function setBody(el, text) {
  el.textContent = ''
  const s = String(text)
  let last = 0
  for (const m of s.matchAll(URL_RE)) {
    if (m.index > last) el.appendChild(document.createTextNode(s.slice(last, m.index)))
    const a = document.createElement('a')
    a.href = m[0]
    a.textContent = m[0]
    a.target = '_blank'
    a.rel = 'noreferrer noopener'
    el.appendChild(a)
    last = m.index + m[0].length
  }
  if (last < s.length) el.appendChild(document.createTextNode(s.slice(last)))
}

function buildMsg(role, content) {
  const div = document.createElement('div')
  div.className = `msg ${role}`
  div.dataset.role = role
  div.dataset.content = content
  if (role !== 'system') {
    const who = document.createElement('div')
    who.className = 'who'
    who.textContent = role === 'user' ? 'you' : 'ghost'
    div.appendChild(who)
  }
  const body = document.createElement('div')
  body.className = 'body'
  setBody(body, content)
  div.appendChild(body)
  return div
}

// Reconcile the existing bubbles against the new transcript instead of rebuilding from scratch.
// Unchanged bubbles are left alone, a streaming bubble has only its body updated (no re-animation),
// and only genuinely new bubbles get created — so the panel no longer flickers/re-animates the
// whole conversation on every streamed token, and scroll position / text selection survive.
function renderMessages(messages) {
  const nodes = [...logEl.querySelectorAll('.msg')]
  let i = 0
  for (const m of messages) {
    if (!m || !m.content) continue
    const role = m.role === 'user' ? 'user' : m.role === 'system' ? 'system' : 'assistant'
    const content = m.content
    const node = nodes[i]
    if (node && node.dataset.role === role) {
      if (node.dataset.content !== content) {
        setBody(node.querySelector('.body'), content)
        node.dataset.content = content
      }
    } else {
      const fresh = buildMsg(role, content)
      node ? logEl.replaceChild(fresh, node) : logEl.appendChild(fresh)
    }
    i++
  }
  // Drop any leftover bubbles (history was reset / shrank).
  for (let j = nodes.length - 1; j >= i; j--) nodes[j].remove()
}

function render(state) {
  const messages = (state && state.messages) || []
  // Stick to the bottom only if the user is already there (don't yank them up while they scroll back).
  const nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 80
  const prevCount = logEl.querySelectorAll('.msg').length

  if (!messages.length) {
    // Mirroring is off but the user just sent from here: don't wipe their optimistic bubble. The
    // reply is happening in the app (not mirrored back), so keep what's on screen and explain.
    if (state && state.mirroring === false && localSent) {
      emptyEl.style.display = 'none'
      hintEl.textContent =
        'Mirroring is off — your message went to the Ghost-Prime app and the reply shows there. Turn on “Mirror chat to Chrome” to see replies here.'
      return
    }
    emptyEl.style.display = ''
    emptyMsg.textContent = state && state.mirroring === false
      ? 'Mirroring is off. Turn on “Mirror chat to Chrome” in the Ghost-Prime app to see the conversation here.'
      : 'No messages yet — say hello below.'
    ;[...logEl.querySelectorAll('.msg')].forEach((n) => n.remove())
    hintEl.textContent = ''
    return
  }
  emptyEl.style.display = 'none'
  renderMessages(messages)
  hintEl.textContent = state && state.mirroring === false ? 'Live mirror is off in the app.' : ''
  if (nearBottom || logEl.querySelectorAll('.msg').length > prevCount) logEl.scrollTop = logEl.scrollHeight
}

async function poll() {
  while (!stopped) {
    try {
      const r = await fetch(url('/chat', `&since=${seq}`))
      if (!r.ok) throw new Error('chat ' + r.status)
      const state = await r.json()
      setConnected(true)
      if (typeof state.seq === 'number') seq = state.seq
      render(state)
    } catch {
      setConnected(false)
      await new Promise((res) => setTimeout(res, 2000))
    }
  }
}

async function send() {
  const text = boxEl.value.trim()
  if (!text) return
  boxEl.value = ''
  autoGrow()
  localSent = true
  // Optimistic echo so it feels instant even before the app mirrors it back. Built the same way as
  // server bubbles so the reconcile in render() adopts it (no duplicate) once the app mirrors it.
  emptyEl.style.display = 'none'
  logEl.appendChild(buildMsg('user', text))
  logEl.scrollTop = logEl.scrollHeight
  try {
    await fetch(url('/task'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: text })
    })
  } catch {
    hintEl.textContent = "Couldn't reach the Ghost-Prime app — is it running?"
  }
}

function autoGrow() {
  boxEl.style.height = 'auto'
  boxEl.style.height = Math.min(boxEl.scrollHeight, 120) + 'px'
}

sendEl.addEventListener('click', send)
boxEl.addEventListener('input', autoGrow)
boxEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
})
chrome.storage.onChanged.addListener(() => loadCfg())

loadCfg().then(poll)

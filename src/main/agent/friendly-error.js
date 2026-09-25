// Turn a failed brain turn into words a person can act on. The raw error (SDK exit codes, "429
// Resource has been exhausted", getaddrinfo EAI_AGAIN, JSON bodies, stack frames) is kept only as a
// short "details" tail; the full error still goes to the terminal log. Shown in the desktop chat
// bubble and in Discord replies, so it must be safe to put on a projector: no paths, no stacks.
// Pure module: no project imports, easy to test (scripts/smoke-friendly-errors.mjs).

const MAX_DETAIL = 140

// One short line of the original error: IPC wrapper, "Error:" prefixes, stack frames, file paths
// and JSON bodies removed.
export function errorDetail(e) {
  let s = typeof e === 'string' ? e : e?.message || (e == null ? '' : String(e))
  s = s.replace(/^Error invoking remote method '[^']*':\s*/i, '')
  s = s.replace(/^(?:(?:Type|Range|Reference)?Error:\s*)+/i, '')
  // Keep only the first line that isn't a stack frame.
  const first = s.split('\n').map((l) => l.trim()).find((l) => l && !/^at\s/.test(l)) || ''
  s = first
  // A JSON body ("400 {"error":{"message":"…"}}") → just its message.
  const json = s.match(/\{[\s\S]*\}/)
  if (json) {
    let msg = ''
    try {
      const o = JSON.parse(json[0])
      msg = o?.error?.message || o?.message || ''
    } catch {
      msg = (json[0].match(/"message"\s*:\s*"([^"]{1,200})"/) || [])[1] || ''
    }
    s = (s.slice(0, json.index).trim() + (msg ? ` ${msg}` : '')).trim()
  }
  s = s.replace(/(?:\/[\w.@~-]+){2,}(?::\d+)*(?::\d+)?/g, '…') // absolute paths
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > MAX_DETAIL ? `${s.slice(0, MAX_DETAIL - 1)}…` : s
}

const RULES = [
  [/ENOENT|command not found|no such file/i, /claude/i, 'Claude Code is not installed or could not start on this Chromebook. Run `claude` in the terminal once to check, or type /brain gemini to use the free brain.'],
  [/api key not valid|pass a valid api key|api_key_invalid|api key expired/i, null, "Google Gemini didn't accept its API key (wrong, expired or replaced). Ask the owner to update it in the settings file, or type /brain claude."],
  [/please run \/login|not logged in|invalid api key|authentication|unauthori[sz]ed|\b401\b|oauth|token (?:expired|invalid)|please log ?in/i, null, 'Claude is not signed in on this Chromebook. Run `claude` in the terminal and log in, or type /brain gemini to use the free brain for now.'],
  [/usage limit|credit|billing|subscription/i, null, "Claude's usage allowance is used up for now. It pauses instead of charging extra. Try again later, or type /brain gemini to use the free brain."],
  [/\b429\b|quota|resource.?(?:has been )?exhausted|rate.?limit|too many requests/i, null, 'The free AI service is busy or has hit its limit for now. Wait a minute and ask again, or switch brain with /brain claude or /brain gemini.'],
  [/\b503\b|\b529\b|overloaded|temporarily unavailable|service unavailable/i, null, 'The AI service is overloaded right now. Please try again in a moment.'],
  [/(?:GEMINI|OPENROUTER|GOOGLE)[A-Z_]*_API_KEY is not set|api key not (?:set|found)/i, null, 'Google Gemini is not set up: its API key is missing from the settings file. Ask the owner to add it, or type /brain claude.'],
  [/timed? ?out|timeout|ETIMEDOUT/i, null, 'The AI took too long to answer. Check the internet connection and ask again.'],
  [/EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|fetch failed|connection error|network|socket hang up|offline/i, null, "I couldn't reach the AI over the internet. Check the Wi-Fi or hotspot, then ask again."]
]

export function friendlyError(e) {
  const detail = errorDetail(e)
  const hay = `${detail} ${typeof e === 'object' && e ? e.status || e.code || '' : ''}`
  for (const [re, also, text] of RULES) {
    if (re.test(hay) && (!also || also.test(hay))) return detail ? `${text} (Details: ${detail})` : text
  }
  return detail ? `Something went wrong: ${detail}` : 'Something went wrong. Please try again.'
}

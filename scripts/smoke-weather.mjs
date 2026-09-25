// weather_get (src/main/tools/jarvis.js, Demo 6 "What's the weather in Kigali right now?") against a
// mocked wttr.in: a normal reply, units, an unknown place, a non-JSON reply, an HTTP error, a
// timeout and no network. The tool must never hand the model "undefined°C" or a raw parser error.
// No network, no LLM. Run: node --import ./scripts/lib/register-electron-stub.mjs scripts/smoke-weather.mjs
const { weatherGet } = await import('../src/main/tools/jarvis.js')

let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && extra ? `  → ${String(extra).slice(0, 300)}` : ''}`)
}
const KIGALI = {
  current_condition: [{ temp_C: '24', temp_F: '75', FeelsLikeC: '25', FeelsLikeF: '77', humidity: '61', windspeedKmph: '9', windspeedMiles: '6', uvIndex: '6', weatherDesc: [{ value: 'Partly cloudy' }] }],
  nearest_area: [{ areaName: [{ value: 'Kigali' }], region: [{ value: 'Kigali' }], country: [{ value: 'Rwanda' }] }],
  weather: [0, 1, 2, 3].map((i) => ({ date: `2026-09-2${6 + i}`, maxtempC: '27', mintempC: '16', maxtempF: '81', mintempF: '61', hourly: Array(8).fill({ weatherDesc: [{ value: 'Light rain shower' }] }) }))
}
let lastUrl = ''
const mock = (impl) => {
  globalThis.fetch = async (url, opts) => {
    lastUrl = String(url)
    return impl(url, opts)
  }
}
const json = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

mock(() => json(KIGALI))
let r = await weatherGet({ location: 'Kigali' })
check(r.temperature === '24°C' && r.condition === 'Partly cloudy' && /Kigali.*Rwanda/.test(r.location), 'Kigali: temperature, condition and place', JSON.stringify(r))
check(r.forecast?.length === 3 && r.forecast[0].max_temp === '27°C', 'three-day forecast', JSON.stringify(r.forecast))
check(/wttr\.in\/Kigali\?format=j1/.test(lastUrl), 'asks wttr.in for JSON', lastUrl)
r = await weatherGet({ location: 'Kigali', units: 'imperial' })
check(r.temperature === '75°F' && /mph/.test(r.wind), 'imperial units', JSON.stringify(r))
await weatherGet({ location: 'New York' })
check(/wttr\.in\/New(%20|\+)York/.test(lastUrl), 'a place with a space is encoded', lastUrl)

// wttr.in answers an unknown place with JSON that has no current conditions.
mock(() => json({ nearest_area: [{ areaName: [{ value: 'Nowhere' }] }], weather: [] }))
r = await weatherGet({ location: 'Qqqzzzx' })
check(!!r.error && !/undefined/.test(JSON.stringify(r)), 'unknown place: a clear error, never "undefined°C"', JSON.stringify(r))

mock(() => new Response('Unknown location; please try ~Qqqzzzx', { status: 200, headers: { 'content-type': 'text/plain' } }))
r = await weatherGet({ location: 'Qqqzzzx' })
check(!!r.error && !/Unexpected token|JSON/.test(r.error), 'a non-JSON reply gives a plain error, not a parser message', JSON.stringify(r))

mock(() => new Response('busy', { status: 503 }))
r = await weatherGet({ location: 'Kigali' })
check(!!r.error && /503|busy|unavailable/i.test(r.error), 'HTTP 503 is reported', JSON.stringify(r))

mock(() => {
  const e = new Error('The operation was aborted due to timeout')
  e.name = 'TimeoutError'
  throw e
})
r = await weatherGet({ location: 'Kigali' })
check(/timed out/i.test(r.error || ''), 'a timeout is reported as a timeout', JSON.stringify(r))

mock(() => {
  throw new TypeError('fetch failed')
})
r = await weatherGet({ location: 'Kigali' })
check(!!r.error && /internet|reach|network|fetch failed/i.test(r.error), 'no network gives an error the model can pass on', JSON.stringify(r))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

// Two Jarvis tool bugs found 25 Sep, tested with fake `pactl` and `xdg-open` commands on PATH (no
// sound card or desktop needed):
//  1. youtube_play refused any search with an apostrophe ("Don't Stop Me Now"): the address it
//     built kept the ' and then failed its own safety check.
//  2. system_volume up/down passed "+N%" to PulseAudio, which goes past 100% (up to 150%, very
//     loud on a projector's speakers): "turn it up by 80" from 60% gave 140%.
// Run: node --import ./scripts/lib/register-electron-stub.mjs scripts/smoke-jarvis-fixes.mjs
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && extra ? `  → ${String(extra).slice(0, 300)}` : ''}`)
}
const bin = mkdtempSync(join(tmpdir(), 'ghost-jarvis-bin-'))
const vol = join(bin, 'vol')
const opened = join(bin, 'opened')
writeFileSync(vol, '60')
// Fake pactl: keeps the level in a file, clamps like PulseAudio (0..150), prints like pactl.
writeFileSync(
  join(bin, 'pactl'),
  `#!/bin/sh
f="${vol}"; v=$(cat "$f")
case "$1" in
  get-sink-volume) echo "Volume: front-left: 1 /  $v% / 0 dB,   front-right: 1 /  $v% / 0 dB";;
  get-sink-mute) echo "Mute: no";;
  set-sink-volume) a="\${3%\\%}"; case "$a" in +*) n=$((v + \${a#+}));; -*) n=$((v - \${a#-}));; *) n=$a;; esac
    [ "$n" -gt 150 ] && n=150; [ "$n" -lt 0 ] && n=0; echo "$n" > "$f";;
  set-sink-mute) ;;
esac
`
)
writeFileSync(join(bin, 'xdg-open'), `#!/bin/sh\necho "$1" > "${opened}"\n`)
chmodSync(join(bin, 'pactl'), 0o755)
chmodSync(join(bin, 'xdg-open'), 0o755)
process.env.PATH = `${bin}:${process.env.PATH}`
const level = () => Number(readFileSync(vol, 'utf8').trim())

const j = await import('../src/main/tools/jarvis.js')
// 1. YouTube
const y = await j.youtubePlay({ query: "Don't Stop Me Now Queen" })
check(y.success && existsSync(opened) && /Don%27t/.test(readFileSync(opened, 'utf8')), 'youtube_play works with an apostrophe in the song title', JSON.stringify(y))
check(!!(await j.youtubePlay({ url: 'https://www.youtube.com.evil.com/watch?v=x' })).error, 'a non-YouTube site is still refused')
check(!!(await j.youtubePlay({ url: "https://www.youtube.com/watch?v=x'onerror" })).error, 'a quote typed into a URL is still refused')

// 2. Volume
let r = await j.systemVolume({ action: 'up', value: 80 })
check(level() === 100, '"up by 80" from 60% stops at 100%, not 140%', `${level()}% ${JSON.stringify(r)}`)
check(/100%/.test(r.message || ''), 'the reply says the new level', JSON.stringify(r))
writeFileSync(vol, '60')
await j.systemVolume({ action: 'up' })
check(level() === 65, 'plain "up" still adds 5%', `${level()}%`)
await j.systemVolume({ action: 'down', value: 90 })
check(level() === 0, '"down by 90" from 65% stops at 0%', `${level()}%`)
writeFileSync(vol, '130') // already over 100 (set by something else)
await j.systemVolume({ action: 'up' })
check(level() <= 100, '"up" from an over-loud 130% never goes higher', `${level()}%`)
await j.systemVolume({ action: 'set', value: 150 })
check(level() === 100, '"set 150" is capped at 100%', `${level()}%`)
const g = await j.systemVolume({ action: 'get' })
check(g.volume === 100, 'get reads the level', JSON.stringify(g))

rmSync(bin, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

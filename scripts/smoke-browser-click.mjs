// Verify browser_click on the tricky real-world cases: clicks by visible text, ignores
// hidden/zero-size duplicates, reaches buttons inside iframes, accepts standard CSS, repairs a
// stray jQuery :contains(), and on a miss returns the page's clickable elements (not a bare
// timeout). Run: GHOST_BROWSER_HEADLESS=true GHOST_BROWSER_CHANNEL=chromium GHOST_BROWSER_PROFILE=isolated node scripts/smoke-browser-click.mjs
import * as browser from '../src/main/tools/browser.js'

const PAGE =
  'data:text/html,' +
  encodeURIComponent(`<!doctype html><html><body>
    <button style="width:0;height:0;padding:0;border:0;overflow:hidden" onclick="document.title='WRONG:hidden'">Log In</button>
    <h1>Sign in</h1>
    <button class="loginBtn" aria-label="Log In" onclick="document.title='CLICKED:button'">Log In</button>
    <a href="#" class="register" onclick="document.title='CLICKED:link';return false">  Create   an account  </a>
    <iframe srcdoc="<button onclick='parent.document.title=&quot;CLICKED:iframe&quot;'>Embedded Action</button>"></iframe>
    <label>Email <input name="email"></label>
  </body></html>`)

let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  console.log((ok ? '✅ ' : '❌ ') + name + (extra ? ` — ${extra}` : ''))
  ok ? pass++ : fail++
}
const reset = () => browser.browserNavigate({ url: PAGE })
const title = async () => (await browser.browserGetText()).title

try {
  // 1. Click by visible text — and prove the hidden zero-size duplicate did NOT win.
  await reset()
  await browser.browserClick({ text: 'Log In' })
  check('click by text "Log In" (skips hidden duplicate)', (await title()) === 'CLICKED:button')

  // 2. Stray jQuery :contains() is repaired to :has-text() and still clicks.
  await reset()
  await browser.browserClick({ selector: 'button:contains("Log In")' })
  check(':contains() selector auto-repaired', (await title()) === 'CLICKED:button')

  // 3. Standard CSS class selector.
  await reset()
  await browser.browserClick({ selector: '.loginBtn' })
  check('standard CSS class .loginBtn', (await title()) === 'CLICKED:button')

  // 4. Standard CSS attribute selector.
  await reset()
  await browser.browserClick({ selector: '[aria-label="Log In"]' })
  check('attribute [aria-label="Log In"]', (await title()) === 'CLICKED:button')

  // 5. Link by text, with messy whitespace in the markup (accessible name is normalized).
  await reset()
  await browser.browserClick({ text: 'Create an account' })
  check('click link by text (whitespace-normalized)', (await title()) === 'CLICKED:link')

  // 6. Button INSIDE an iframe — page.locator can't reach it; findClickable searches frames.
  await reset()
  await browser.browserClick({ text: 'Embedded Action' })
  check('click button inside an iframe', (await title()) === 'CLICKED:iframe')

  // 7. Invalid jQuery selector → clear, actionable error (no raw crash).
  await reset()
  let guided = false
  try {
    await browser.browserClick({ selector: 'button:eq(0)' })
  } catch (e) {
    guided = /jquery|standard css|text:/i.test(e.message)
  }
  check('invalid :eq() returns guidance', guided)

  // 8. A miss lists the page's actual clickable elements so the agent can self-correct.
  await reset()
  let listed = false
  try {
    await browser.browserClick({ text: 'Totally Not Here 9000' })
  } catch (e) {
    listed = /Log In/.test(e.message) && /clickable/i.test(e.message)
    console.log('   (error text:', JSON.stringify(e.message.slice(0, 120)) + '…)')
  }
  check('missed click lists clickable elements', listed)

  // 9. Fill a field by its label.
  await reset()
  await browser.browserFill({ label: 'Email', value: 'me@example.com' })
  check('fill by label', true) // no throw == pass

  // 10. Vision click: click at a viewport coordinate (what the agent does after a screenshot).
  await browser.browserNavigate({
    url:
      'data:text/html,' +
      encodeURIComponent(
        '<!doctype html><button style="position:fixed;inset:0;width:100%;height:100%" onclick="document.title=\'CLICKED:at\'">Hit anywhere</button>'
      )
  })
  await browser.browserClickAt({ x: 0.5, y: 0.5 })
  check('click at coordinate (vision-grounded)', (await title()) === 'CLICKED:at')

  // 11. Scroll a tall page down.
  await browser.browserNavigate({
    url: 'data:text/html,' + encodeURIComponent('<!doctype html><body style="height:6000px;margin:0">tall</body>')
  })
  const sc = await browser.browserScroll({ direction: 'down' })
  check('scroll down moves the page', sc.scrollY > 0)
} catch (e) {
  check('unexpected failure', false, e.message)
} finally {
  await browser.browserClose()
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

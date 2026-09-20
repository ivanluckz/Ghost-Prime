# Ghost-Prime Browser Bridge (Chrome extension)

Lets Ghost-Prime drive your **real, already-open Chrome** — the one inside the Crostini Linux
container — instead of launching a separate Playwright browser. No profile lock, full access to
your logged-in sessions, and you watch it work in your own tabs.

## How it fits together

```
Ghost-Prime app (Claude Agent SDK)
  browser_* tools ──▶ local HTTP bridge  127.0.0.1:8731   (src/main/tools/browser-bridge.js)
                                 ▲  long-poll  │ commands
                                 │             ▼
                       this extension (background.js) ──▶ active Chrome tab
```

Same Claude brain as the app — the extension is just its hands in your browser. The connection is
plain `127.0.0.1` (no external tunnel), gated by a shared token, bound to loopback unless you set a
private token (see step 4 below).

## Install (once)

Load it from a **Chrome OS ↔ Linux shared folder** so it survives restarts — a `~/Projects/...`
path vanishes for the host browser when Crostini isn't running, so Chrome disables the extension on
reboot.

1. Share Downloads with Linux: **Files app → Downloads → ⋮ → Share with Linux**.
2. Start the Ghost-Prime app with `GHOST_EXT_DEPLOY` set (default mirrors to
   `…/Downloads/ghost-prime-extension`). It copies the extension there on launch and keeps it synced.
   (Or one-shot it: `GHOST_EXT_DEPLOY=/mnt/chromeos/MyFiles/Downloads/ghost-prime-extension npm run ext:deploy`.)
3. `chrome://extensions` → **Developer mode** → **Load unpacked** → pick that
   `Downloads/ghost-prime-extension` folder (in the host browser: My files → Downloads).
4. Extension **Details → Extension options** → set Host / Port / Token to match the app's `.env`:
   - **Crostini Linux Chrome:** Host `127.0.0.1` (leave `GHOST_BRIDGE_HOST=127.0.0.1`).
   - **Chrome OS host browser:** Host `penguin.linux.test`, and set `GHOST_BRIDGE_HOST=0.0.0.0` in
     `.env` so the bridge is reachable from the host. **A private `GHOST_BRIDGE_TOKEN` is REQUIRED
     first** (set it in `.env` and the same value here in the options page): with the default
     `ghost-local` token the app refuses `0.0.0.0` and binds `127.0.0.1` instead, since anything that
     could reach the port would otherwise be able to run tasks through the agent.

After this, edits auto-reload while the app runs (`GHOST_EXT_AUTORELOAD=1`) — no manual reload, and
the synced copy means it stays put across restarts.

## Use

1. Start the Ghost-Prime app (it opens the bridge on launch).
2. Ask Ghost to do something in the browser. With the extension connected, `browser_*` tools run in
   **this** Chrome (the tab you have focused). If the extension isn't connected, the app falls back
   to Playwright automatically.

Force a backend with `GHOST_BROWSER_BACKEND=extension` or `=playwright` in `.env` (`auto` is the default).

### Several devices at once

The bridge accepts more than one client (two Chromes, a Brave, the Android connector app). Each
polls `/poll` with its own `id`, `name` and `kind` (`browser` for this extension, `phone` for the
connector) and gets its own command queue. Commands go to the **selected** device (the app's device
picker; the first live device is auto-selected).

The bridge API is **kind-aware**. On the app side, `bridgeConnected(id?, kind?)` /
`sendCommand(cmd, args, ms, id?, kind?)` take an optional kind, and the shorthands
`browserConnected()` / `sendBrowserCommand()` and `phoneConnected()` / `sendPhoneCommand()` pin it.
Callers that use the browser-kind forms only ever target a `kind=browser` device: a connected phone
never counts as "Chrome is connected" and never receives browser commands, and if the phone is the
selected device a browser command quietly uses the connected Chrome instead (and the same the other
way round, so phone commands never land in a browser). An explicit device id is all-or-nothing — if
that device is stale, unknown or the wrong kind the command is refused with a clear error rather
than rerouted to another device. `/poll` normalises `kind` to `browser` or `phone` (anything else is
treated as a browser). The extension live-reload (`GHOST_EXT_AUTORELOAD=1`) is sent to browsers
only, and `GET /ping` reports `connected`, `browser` and `phone` separately.

Note: `browser_*` tools in `src/main/tools/browser.js` still call the kind-less `bridgeConnected()`
/ `sendCommand()`, so until they are switched to `browserConnected()` / `sendBrowserCommand()` a
connected phone with no Chrome makes the app pick the extension backend rather than Playwright.

## Notes & limits (v1)

- Acts on your **active tab**. Click prefers visible text (e.g. "Log In") and searches iframes.
- Uses ordinary DOM events (`.click()`, input events). Works on the vast majority of sites; a few
  that demand OS-level "trusted" events may need the future `chrome.debugger` mode.
- It cannot be on the Web Store, so it loads unpacked (developer mode). That's expected.
- Security: anyone who can reach `127.0.0.1:<port>` **and** knows the token could drive your browser.
  Keep the token private; change it in both `.env` and the extension options if unsure.

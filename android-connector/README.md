# Ghost-Prime — Android connector app

The phone-side counterpart to the Chrome extension. It connects to the Ghost-Prime bridge over your
LAN and lets the agent **see and drive your Android phone** — no root, no adb, no laptop tether.

It speaks the exact same long-poll protocol the bridge proved with `scripts/fake-phone.mjs`
(`/poll` → run command → `/result`), and registers as a **named device** (`kind=phone`) so it shows
up next to Chrome/Brave in the app.

## What it can do
Backed by three sanctioned Android capabilities (granted once, revocable any time):

| Capability | Android API | Commands |
|---|---|---|
| **Accessibility service** | `AccessibilityService` | `uiDump` (live UI tree), `tap` (x,y or by text), `swipe`, `type`, `key` (back/home/recents) |
| **Screen capture** | `MediaProjection` | `screenshot` (real pixels, base64 PNG) |
| **App launch** | launch intents | `openApp` (by package or URL/deep-link) |

The combination of `uiDump` (structured elements) + `screenshot` (pixels) is the "fusion" that makes
taps reliable instead of pixel-guesswork.

## Build
Needs JDK 17+ and the Android SDK (platform-34, build-tools 34). From this folder:

```bash
# point to your SDK (this file is gitignored)
echo "sdk.dir=$HOME/Android/Sdk" > local.properties

./gradlew assembleDebug         # or: gradle assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk
```

(The CI/dev box here builds with `~/tools/gradle-8.9/bin/gradle assembleDebug`, `JAVA_HOME` →
the JDK 21 install, `ANDROID_HOME` → `~/Android/Sdk`.)

## Install + connect
1. **Sideload** `app-debug.apk` (enable "install unknown apps" for your file manager/browser).
2. Open **Ghost-Prime** on the phone and set **Bridge host** to your computer's LAN IP (same Wi-Fi),
   port `8731`, and the **private token** you set as `GHOST_BRIDGE_TOKEN` in the app's `.env` (the
   same value goes in the extension settings).
3. On the computer, run the app with the bridge reachable off-loopback: `GHOST_BRIDGE_HOST=0.0.0.0`.
   A private `GHOST_BRIDGE_TOKEN` is REQUIRED for this — with the default `ghost-local` token the
   app refuses `0.0.0.0` and binds `127.0.0.1` instead (the phone won't be able to connect), because
   anyone on the network who could reach the port would be able to run tasks through the agent.
4. In the app, tap through: **1 Enable Accessibility → 2 Grant screen capture → 3 Start connector**.
5. The phone now appears as a named device (e.g. *Pixel 8*) in Mission Control.

## Security
The Accessibility + screen-capture + notification permissions are powerful — that's why Android
guards them with explicit, scary-looking prompts. Only this app (talking to your own machine on your
own Wi-Fi, gated by the shared token) uses them. Turn off the Accessibility toggle to instantly
revoke all control.

## Status
v1 (`versionCode 1`). The accessibility actions (`uiDump`/`tap`/`type`/`key`) and `openApp` are
straightforward; `screenshot` (MediaProjection) is the piece most likely to want on-device tuning
across OEM skins. The agent-side `phone_*` tools that call these are the next step in the main app.

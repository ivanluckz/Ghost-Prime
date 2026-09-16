#!/usr/bin/env bash
# Ghost-Prime launcher — runs the built Electron app. Referenced by the .desktop entry
# so Ghost-Prime appears in the Chrome OS / Crostini app launcher.
cd /home/lol/Projects/Ghost-Prime || exit 1
export ELECTRON_OZONE_PLATFORM_HINT=auto
exec ./node_modules/electron/dist/electron . "$@"

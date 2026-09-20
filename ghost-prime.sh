#!/usr/bin/env bash
# Ghost-Prime launcher — runs the built Electron app. Referenced by the .desktop entry so
# Ghost-Prime appears in the Chrome OS / Crostini app launcher. Thin wrapper over bin/ghost-prime
# so the app-list icon and the terminal command share ONE launch path (checkout resolved from this
# file's location, first-run build, Ozone backend from GHOST_OZONE in .env — default x11).
exec "$(dirname "$(readlink -f "$0")")/bin/ghost-prime" -f "$@"

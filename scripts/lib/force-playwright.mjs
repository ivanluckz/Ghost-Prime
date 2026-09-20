// Import this FIRST in a smoke script (before ../src/main/tools/browser.js, which reads
// GHOST_BROWSER_BACKEND at module load) so the test never autolaunches the user's real Chrome
// and then fails waiting for the extension. Explicit env still wins.
process.env.GHOST_BROWSER_BACKEND ??= 'playwright'

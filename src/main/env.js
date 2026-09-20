import dotenv from 'dotenv'
import { app } from 'electron'
import { join } from 'node:path'

// Load .env from the project root. Under electron-vite dev, getAppPath() === project root.
// This module is imported FIRST by index.js and exists only for its side effect: ESM evaluates
// every imported module before the importer's body, so it must run before any module reads
// process.env at top level (hotkey, proactive, provider, browser).
dotenv.config({ path: join(app.getAppPath(), '.env') })

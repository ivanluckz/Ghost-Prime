import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
// Bundled type: Inter (with optical sizing) for the UI, JetBrains Mono for code + terminal — the
// Crostini container has neither installed, so without these everything fell back to DejaVu Sans.
import '@fontsource-variable/inter/opsz.css'
import '@fontsource-variable/jetbrains-mono/index.css'
import './styles.css'
// Per-area design layers, loaded after the base sheet so they refine it.
import './styles/shell.css'
import './styles/chat.css'
import './styles/tools.css'
import './styles/activity.css'
import './styles/panels.css'

// Defence in depth: never let Chromium's default drop action navigate the app window to a dropped
// URL/file (covers every screen, incl. Intro). Main.jsx's React onDragOver/onDrop still run first.
document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('drop', (e) => e.preventDefault())

// Design preview (`npm run design`): outside Electron there is no preload, so dev builds install
// a mock window.ghost with demo data. Dead code in production builds (import.meta.env.DEV is false).
const boot = import.meta.env.DEV && !window.ghost ? import('./dev/mock-ghost.js') : Promise.resolve()

boot.then(() =>
  createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
)

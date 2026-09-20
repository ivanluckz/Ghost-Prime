import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
// Bundled type: Inter (with optical sizing) for the UI, JetBrains Mono for code + terminal — the
// Crostini container has neither installed, so without these everything fell back to DejaVu Sans.
import '@fontsource-variable/inter/opsz.css'
import '@fontsource-variable/jetbrains-mono/index.css'
import './styles.css'

// Defence in depth: never let Chromium's default drop action navigate the app window to a dropped
// URL/file (covers every screen, incl. Intro). Main.jsx's React onDragOver/onDrop still run first.
document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('drop', (e) => e.preventDefault())

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

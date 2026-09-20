import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
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

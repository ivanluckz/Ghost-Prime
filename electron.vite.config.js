import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const root = process.cwd()

// Version + a fresh build stamp, injected into the renderer so the app can show exactly which build
// is running — makes it obvious when a reload actually picked up new code.
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const BUILD_STAMP = new Date().toLocaleString('en-GB', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit'
})
const versionDefine = {
  __GHOST_VERSION__: JSON.stringify(pkg.version),
  __GHOST_BUILD__: JSON.stringify(BUILD_STAMP)
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    define: versionDefine,
    plugins: [react()],
    resolve: {
      alias: {
        '@assets': resolve(root, 'assets')
      }
    },
    server: {
      fs: {
        // allow importing the generated intro.mp4 from the project-root assets/ dir
        allow: [root]
      }
    }
  }
})

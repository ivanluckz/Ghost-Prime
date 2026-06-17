import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const root = process.cwd()

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
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

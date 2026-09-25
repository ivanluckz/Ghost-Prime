// Design preview: the renderer alone in a plain browser, with a mock backend
// (src/renderer/dev/mock-ghost.js). `npm run design` → http://127.0.0.1:5199/?skipIntro=1
// Edits to CSS/JSX hot-reload; `npm run design:capture <outdir>` screenshots every UI state.
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const root = process.cwd()
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))

export default defineConfig({
  root: resolve(root, 'src/renderer'),
  plugins: [react()],
  define: {
    __GHOST_VERSION__: JSON.stringify(pkg.version),
    __GHOST_BUILD__: JSON.stringify('design preview')
  },
  resolve: { alias: { '@assets': resolve(root, 'assets') } },
  server: { host: '127.0.0.1', port: Number(process.env.DESIGN_PORT) || 5199, strictPort: true, fs: { allow: [root] } }
})

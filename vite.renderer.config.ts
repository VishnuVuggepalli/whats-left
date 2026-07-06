import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Renderer-only dev server (no Electron): serves the UI with MockApi demo
 * data for browser preview on headless boxes / design work.
 *   npm run dev:web  →  http://<host>:5173
 */
export default defineConfig({
  root: 'src/renderer',
  plugins: [react(), tailwindcss()],
  server: { host: true, port: 5173, strictPort: true },
})

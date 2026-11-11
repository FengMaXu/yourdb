import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

// Electron production builds load the renderer via file://,
// so packaged assets must use relative paths instead of /assets/...
export default defineConfig(({ command }) => ({
  base: command === 'serve' ? '/' : './',
  plugins: [react(), tailwindcss()],
  // `@/…` is how shadcn/ui components import each other.
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // The landing page's download panel shows the desktop version it links to.
  define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(version) },
}))

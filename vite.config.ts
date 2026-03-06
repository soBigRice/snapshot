import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const githubPagesBase = '/snapshot/'
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
) as { version: string }

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  base: command === 'serve' ? '/' : githubPagesBase,
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  plugins: [react()],
}))

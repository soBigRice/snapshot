import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const githubPagesBase = '/snapshot/'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  base: command === 'serve' ? '/' : githubPagesBase,
  plugins: [react()],
}))

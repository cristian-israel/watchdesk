import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 7130,
    strictPort: true,
    proxy: {
      '^/api/.*': { target: 'http://localhost:7030', changeOrigin: true },
      '^/whep/.*': { target: 'http://localhost:7030', changeOrigin: true },
      '^/whip/.*': { target: 'http://localhost:7030', changeOrigin: true },
    },
  },
})

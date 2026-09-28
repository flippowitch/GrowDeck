import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// During development the API runs on :8080 (docker) or :8088 (local uvicorn).
const target = process.env.GROWDECK_API || 'http://127.0.0.1:8088'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target, changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    chunkSizeWarningLimit: 900,
  },
})

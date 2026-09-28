// Builds the static live demo for GitHub Pages (npm run build:demo): dist-demo/index.html with
// normal asset files and relative paths, so it works under a sub-path such as
// https://user.github.io/growdeck/. The API is simulated in the browser (demo/mock.js).
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [
    react(),
    {
      // the page is built from demo.html; Pages serves index.html
      name: 'demo-index-html',
      enforce: 'post',
      generateBundle(_, bundle) {
        const page = bundle['demo.html']
        if (!page) return
        delete bundle['demo.html']
        this.emitFile({ type: 'asset', fileName: 'index.html', source: page.source })
      },
    },
  ],
  build: {
    outDir: 'dist-demo',
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: { input: 'demo.html' },
  },
})

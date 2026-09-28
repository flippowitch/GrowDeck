// Inlines the built demo (dist-demo) into one self-contained HTML file.
import { readFileSync, writeFileSync } from 'node:fs'

const dist = new URL('../dist-demo/', import.meta.url)
let html = readFileSync(new URL('demo.html', dist), 'utf8')
html = html.replace(/<script type="module" crossorigin src="([^"]+)"><\/script>/g, (_, src) =>
  `<script type="module">${readFileSync(new URL(src.replace(/^\//, ''), dist), 'utf8').replaceAll('</script', '<\\/script')}</script>`)
html = html.replace(/<link rel="stylesheet" crossorigin href="([^"]+)">/g, (_, href) =>
  `<style>${readFileSync(new URL(href.replace(/^\//, ''), dist), 'utf8')}</style>`)
if (html.includes('/assets/')) throw new Error('unresolved asset reference')
writeFileSync(new URL('growdeck-demo.html', dist), html)
console.log(`dist-demo/growdeck-demo.html: ${Math.round(html.length / 1024)} KB`)

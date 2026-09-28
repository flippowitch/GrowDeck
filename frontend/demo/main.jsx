// Entry of the static demo (GitHub Pages): decides the language, installs the in-browser API
// (mock.js), then starts the unchanged GrowDeck app. The app's modules translate their texts
// when they load, so the mock and the app are imported after initI18n(), like src/main.jsx.
import { createRoot } from 'react-dom/client'
import '@fontsource/barlow/400.css'
import '@fontsource/barlow/500.css'
import '@fontsource/barlow/600.css'
import '@fontsource/barlow-condensed/500.css'
import '@fontsource/barlow-condensed/600.css'
import '@fontsource/barlow-condensed/700.css'
import 'uplot/dist/uPlot.min.css'
import '../src/styles/app.css'
import { initI18n, t } from '../src/i18n.js'

try {
  const theme = localStorage.getItem('gd-theme')
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
} catch {
  /* storage unavailable */
}

// A photo opened "in a new tab" is a generated data: address, which browsers do not open as a
// page; the demo shows it above the page instead.
function showImage(src) {
  const layer = document.createElement('div')
  layer.setAttribute('role', 'dialog')
  layer.setAttribute('aria-label', t('Foto'))
  layer.tabIndex = -1
  layer.style.cssText = 'position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:16px;background:rgba(0,0,0,.82);cursor:zoom-out'
  const img = document.createElement('img')
  img.src = src
  img.alt = ''
  img.style.cssText = 'max-width:100%;max-height:100%;border-radius:8px;box-shadow:0 10px 40px rgba(0,0,0,.5)'
  layer.append(img)
  const close = () => {
    layer.remove()
    document.removeEventListener('keydown', onKey)
  }
  const onKey = (e) => e.key === 'Escape' && close()
  layer.addEventListener('click', close)
  document.addEventListener('keydown', onKey)
  document.body.append(layer)
  layer.focus()
}

// Links to /api/… (backups, CSV and JSON exports, videos) would leave the demo and end in a 404.
function watchLinks(toast) {
  const onClick = (e) => {
    if (e.defaultPrevented || (e.type === 'auxclick' && e.button !== 1)) return
    const link = e.target instanceof Element ? e.target.closest('a[href]') : null
    const href = link?.getAttribute('href') || ''
    if (href.startsWith('/api/')) {
      e.preventDefault()
      toast(t('In der Demo gibt es keine Dateien zum Herunterladen.'))
    } else if (href.startsWith('data:image/') && link.target === '_blank') {
      e.preventDefault()
      showImage(href)
    }
  }
  document.addEventListener('click', onClick)
  document.addEventListener('auxclick', onClick)
}

initI18n().then(async () => {
  await import('./mock.js')
  const [{ default: App }, { toast }] = await Promise.all([import('../src/App.jsx'), import('../src/store.js')])
  createRoot(document.getElementById('root')).render(<App />)
  watchLinks(toast)
  setTimeout(() => toast(t('Interaktive Demo: Alle Geräte sind simuliert. Änderungen gelten nur in diesem Tab.'), 'info', 9000), 1200)
})

import { createRoot } from 'react-dom/client'
import '@fontsource/barlow/400.css'
import '@fontsource/barlow/500.css'
import '@fontsource/barlow/600.css'
import '@fontsource/barlow-condensed/500.css'
import '@fontsource/barlow-condensed/600.css'
import '@fontsource/barlow-condensed/700.css'
import 'uplot/dist/uPlot.min.css'
import './styles/app.css'
import { initI18n } from './i18n.js'

try {
  const theme = localStorage.getItem('gd-theme')
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
} catch {
  /* storage unavailable */
}

// the language decides the texts of every module, so the app loads after it
initI18n().then(async () => {
  const { default: App } = await import('./App.jsx')
  createRoot(document.getElementById('root')).render(<App />)
})

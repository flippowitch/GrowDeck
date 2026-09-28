// Minimal hash router: #/devices/sf-1234 -> { page: 'devices', params: ['sf-1234'] }
import { useEffect, useState } from 'react'

function parse() {
  const hash = location.hash.replace(/^#\/?/, '')
  const [path, query = ''] = hash.split('?')
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent)
  return { page: parts[0] || 'overview', params: parts.slice(1), query: new URLSearchParams(query) }
}

export function useRoute() {
  const [route, setRoute] = useState(parse)
  useEffect(() => {
    const onChange = () => {
      setRoute(parse())
      window.scrollTo({ top: 0 })
    }
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}

export function go(path) {
  location.hash = path.startsWith('#') ? path : `#/${path.replace(/^\//, '')}`
}

export function href(path) {
  return `#/${path.replace(/^\//, '')}`
}

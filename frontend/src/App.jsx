import { useEffect, useState } from 'react'
import { checkAuth, login, useStore } from './store.js'
import { href, useRoute } from './router.js'
import Icon, { Logo } from './components/Icon.jsx'
import Overview from './pages/Overview.jsx'
import Growplan from './pages/Growplan.jsx'
import Devices from './pages/Devices.jsx'
import DeviceDetail from './pages/DeviceDetail.jsx'
import History from './pages/History.jsx'
import Rules from './pages/Rules.jsx'
import Alarms from './pages/Alarms.jsx'
import Options from './pages/Options.jsx'
import Camera from './pages/Camera.jsx'
import Archive from './pages/Archive.jsx'
import { t } from './i18n.js'

const NAV = [
  { page: 'overview', label: t('Übersicht'), icon: 'overview' },
  { page: 'growplan', label: 'Growplan', icon: 'growplan' }, // i18n-ignore (name)
  { page: 'devices', label: t('Geräte'), icon: 'devices' },
  { page: 'history', label: t('Verlauf'), icon: 'history' },
  { page: 'rules', label: t('Regeln'), icon: 'automation' },
  { page: 'alarms', label: t('Alarme'), icon: 'alarms' },
  { page: 'options', label: t('Optionen'), icon: 'settings' },
]

function Login() {
  const passwordGenerated = useStore((s) => s.passwordGenerated)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await login(password)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="login">
      <form onSubmit={submit}>
        <Logo size={44} />
        <h1>GrowDeck</h1>
        <p>{t('Spider Farmer, Vivosun und AC Infinity an einem Ort. Melde dich mit dem Passwort aus deiner Konfiguration an.')}</p>
        <label className="field">
          <span>{t('Passwort')}</span>
          <input className="input" type="password" autoComplete="current-password" value={password}
            onChange={(e) => setPassword(e.target.value)} autoFocus required />
        </label>
        {error ? <div className="notice alert" role="alert">{error}</div> : null}
        <button className="btn primary" type="submit" disabled={busy || !password}>
          {busy ? t('Anmelden …') : t('Anmelden')}
        </button>
        {passwordGenerated ? (
          <p className="small">
            {t('Es ist kein APP_PASSWORD gesetzt. Das erzeugte Passwort steht im Container-Protokoll und in der Datei {file} im Datenordner.', {
              file: <code>generated-password.txt</code>, // i18n-ignore (file name)
            })}
          </p>
        ) : null}
      </form>
    </div>
  )
}

function Toasts() {
  const toasts = useStore((s) => s.toasts)
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((item) => (
        <div key={item.id} className={`toast ${item.tone}`} role={item.tone === 'alert' ? 'alert' : 'status'}>{item.message}</div>
      ))}
    </div>
  )
}

function Page({ route }) {
  switch (route.page) {
    case 'devices':
      return route.params[0] ? <DeviceDetail id={route.params[0]} /> : <Devices />
    case 'growplan':
      return <Growplan id={route.params[0]} query={route.query} />
    case 'history':
      return <History query={route.query} />
    case 'rules':
      return <Rules />
    case 'alarms':
      return <Alarms />
    case 'options':
      return <Options query={route.query} />
    case 'kamera':
      return <Camera id={route.params[0]} />
    case 'archiv':
      return <Archive id={route.params[0]} query={route.query} />
    default:
      return <Overview />
  }
}

export default function App() {
  const auth = useStore((s) => s.auth)
  const connection = useStore((s) => s.connection)
  const unread = useStore((s) => s.unread)
  const version = useStore((s) => s.version)
  const route = useRoute()

  useEffect(() => {
    checkAuth()
  }, [])

  if (auth === 'unknown') return <div className="login"><Logo size={44} /></div>
  if (auth !== 'ok') {
    return (
      <>
        <Login />
        <Toasts />
      </>
    )
  }

  // pages outside the menu belong to a menu entry: the archive to Growplan, the camera gallery to Geräte
  const page = { archiv: 'growplan', kamera: 'devices' }[route.page] || route.page
  const current = page === 'overview' || !NAV.some((n) => n.page === page) ? 'overview' : page
  const connectionText = { live: t('Live verbunden'), connecting: t('Verbinde …'), offline: t('Keine Live-Verbindung') }[connection]

  return (
    <div className="shell">
      <nav className="rail" aria-label={t('Hauptnavigation')}>
        <a className="wordmark" href={href('overview')}>
          <Logo />
          <b>GrowDeck</b>
        </a>
        {NAV.map((n) => (
          <a key={n.page} className="nav-link" href={href(n.page)} aria-current={current === n.page ? 'page' : undefined}>
            <Icon name={n.icon} />
            {n.label}
            {n.page === 'alarms' && unread > 0 ? <span className="badge">{unread}</span> : null}
          </a>
        ))}
        <div className="rail-foot">
          <span><span className={`live-dot ${connection}`} />{connectionText}</span>
          <span>{t('Version {version}', { version })}</span>
        </div>
      </nav>
      <main className="content" id="main">
        {connection === 'offline' ? (
          <div className="notice" style={{ marginBottom: 18 }}>
            {t('Keine Live-Verbindung zu GrowDeck. Die Anzeige wird wieder aktuell, sobald die Verbindung steht.')}
          </div>
        ) : null}
        <Page route={route} />
      </main>
      <nav className="tabbar" aria-label={t('Navigation')}>
        {NAV.map((n) => (
          <a key={n.page} href={href(n.page)} aria-current={current === n.page ? 'page' : undefined}>
            <Icon name={n.icon} size={21} />
            <span>{n.label}</span>
            {n.page === 'alarms' && unread > 0 ? <span className="badge">{unread}</span> : null}
          </a>
        ))}
      </nav>
      <Toasts />
    </div>
  )
}

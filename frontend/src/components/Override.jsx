// Manual mode ("Handbetrieb"): one button pauses every rule and every tent control, so the
// outputs keep exactly what is set by hand. It ends by itself after the chosen time or
// with "Automatik wieder an"; then rules and tent controls take over again.
import { useEffect, useState } from 'react'
import Icon from './Icon.jsx'
import { Modal } from './ui.jsx'
import { setOverride, useStore } from '../store.js'
import { clock, duration } from '../format.js'
import { t } from '../i18n.js'

const DURATIONS = [
  { minutes: 30, label: t('30 Minuten') },
  { minutes: 60, label: t('1 Stunde') },
  { minutes: 240, label: t('4 Stunden') },
  { minutes: 1440, label: t('24 Stunden') },
  { minutes: null, label: t('Bis ich ihn beende') },
]

function useSeconds(active) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return undefined
    const id = setInterval(() => setNow(Date.now()), 15000)
    return () => clearInterval(id)
  }, [active])
  return now
}

function OverrideDialog({ onClose }) {
  const [busy, setBusy] = useState(false)
  const start = async (minutes) => {
    setBusy(true)
    try {
      await setOverride(true, minutes)
      onClose()
    } catch {
      /* toast shown */
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title={t('Handbetrieb')} onClose={onClose}
      actions={<button className="btn ghost" onClick={onClose}>{t('Abbrechen')}</button>}>
      <p className="muted" style={{ marginTop: 0 }}>
        {t('Im Handbetrieb schalten Regeln und Zeltsteuerung nichts mehr, auch nicht nach dem Growplan. Alle Ausgänge behalten, was du von Hand einstellst. Danach übernimmt die Automatik wieder.')}
      </p>
      <div className="override-choices">
        {DURATIONS.map((d) => (
          <button key={d.label} type="button" className="btn" disabled={busy} onClick={() => start(d.minutes)}>{d.label}</button>
        ))}
      </div>
    </Modal>
  )
}

// Button that starts manual mode, or ends it while it is active.
export function OverrideButton({ className = 'btn' }) {
  const override = useStore((s) => s.override)
  const [open, setOpen] = useState(false)
  if (override?.active) {
    return (
      <button type="button" className={`${className} override-on`} onClick={() => setOverride(false).catch(() => {})}>
        <Icon name="automation" size={18} /> {t('Automatik wieder an')}
      </button>
    )
  }
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}
        title={t('Regeln und Zeltsteuerung anhalten und alles von Hand steuern')}>
        <Icon name="hand" size={18} /> {t('Handbetrieb')}
      </button>
      {open ? <OverrideDialog onClose={() => setOpen(false)} /> : null}
    </>
  )
}

// Bar on every page while manual mode is active.
export function OverrideBar() {
  const override = useStore((s) => s.override)
  const offset = useStore((s) => s.serverOffset)
  const now = useSeconds(!!override?.active)
  const [busy, setBusy] = useState(false)
  if (!override?.active) return null
  const left = override.until ? override.until - (now + offset) / 1000 : null
  const act = async (fn) => {
    setBusy(true)
    try {
      await fn()
    } catch {
      /* toast shown */
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="override-bar" role="status">
      <Icon name="hand" size={20} />
      <div className="override-text">
        <b>{t('Handbetrieb aktiv')}</b>
        <span>
          {left != null
            ? t('Regeln und Zeltsteuerung schalten bis {time} nichts (noch {left}).', { time: clock(override.until), left: duration(left) })
            : t('Regeln und Zeltsteuerung schalten nichts, bis du den Handbetrieb beendest.')}
        </span>
      </div>
      <div className="row">
        {left != null ? (
          <button type="button" className="btn small" disabled={busy}
            onClick={() => act(() => setOverride(true, Math.max(1, left / 60) + 60))}>{t('+1 Stunde')}</button>
        ) : null}
        <button type="button" className="btn small primary" disabled={busy}
          onClick={() => act(() => setOverride(false))}>{t('Automatik wieder an')}</button>
      </div>
    </div>
  )
}

// Growplan additions around the tent: recognised waterings, watering reminders, the tent's
// camera, a photo for log entries, the Growplan alarm and closing a grow into the archive.
import { useEffect, useMemo, useState } from 'react'
import { api, toast, useStore } from '../store.js'
import { go, href } from '../router.js'
import { fmt, LOCALE } from '../format.js'
import Icon from '../components/Icon.jsx'
import { Field, Modal, Toggle } from '../components/ui.jsx'
import { photoDate, photoUrl, takePhoto, useCameras, usePhotos } from '../cameras.js'
import { activePlants, fmtDate, newEntry } from './engine.js'
import { Block } from './parts.jsx'
import { dec, t } from '../i18n.js'

// ------------------------------------------------------------------ cameras
// Cameras of the tent: assigned to its room, or without room when the plan stands for all devices.
export function useTentCameras(tent) {
  const [data] = useCameras()
  return useMemo(() => {
    if (!data) return { cameras: [], ffmpeg: false }
    const roomId = tent.room?.id || null
    const cameras = data.cameras.filter((c) => (roomId ? c.room_id === roomId : tent.implicit && !c.room_id))
    return { cameras, ffmpeg: data.ffmpeg }
  }, [data, tent.room?.id, tent.implicit])
}

export function CameraTile({ g }) {
  const { cameras, ffmpeg } = useTentCameras(g.tent)
  const camera = cameras[0]
  const photos = usePhotos({ cameraId: camera?.id, limit: 1 })
  const [busy, setBusy] = useState(false)
  if (!camera) return null
  const last = photos?.[0]
  return (
    <Block title={t('Kamera')} hint={camera.name}>
      <div className="panel gp-camera">
        {last ? (
          <a href={href(`kamera/${camera.id}`)} className="gp-camera-img">
            <img src={photoUrl(last.id, true)} alt={t('Letztes Foto von {name}', { name: camera.name })} />
          </a>
        ) : <div className="gp-pad muted small">{t('Noch kein Foto. Die Kamera fotografiert täglich um {times} Uhr.', { times: camera.times.join(', ') })}</div>}
        <div className="gp-pad spread">
          <span className="small muted">{last ? t('Letztes Foto {date}', { date: photoDate(last.ts) }) : ''}</span>
          <span className="row" style={{ gap: 6 }}>
            <a className="btn small ghost" href={href(`kamera/${camera.id}`)}>{t('Galerie')}</a>
            <button type="button" className="btn small" disabled={busy || !ffmpeg} onClick={async () => {
              setBusy(true)
              await takePhoto(camera)
              setBusy(false)
            }}>{busy ? t('Nimmt auf …') : t('Foto jetzt')}</button>
          </span>
        </div>
      </div>
    </Block>
  )
}

// Photo of a log entry: take one now or pick one of the latest of the tent's camera.
export function PhotoField({ tent, value, onChange }) {
  const { cameras, ffmpeg } = useTentCameras(tent)
  const camera = cameras[0]
  const photos = usePhotos({ cameraId: camera?.id, limit: 6 })
  const [busy, setBusy] = useState(false)
  if (!camera && !value) return null
  return (
    <div className="field">
      <span>{t('Foto (optional)')}</span>
      {value ? (
        <div className="row">
          <img className="gp-entry-photo" src={photoUrl(value, true)} alt={t('Foto dieses Eintrags')} />
          <button type="button" className="btn small ghost" onClick={() => onChange(null)}>{t('Foto entfernen')}</button>
        </div>
      ) : null}
      {camera ? (
        <div className="gp-photo-pick">
          <button type="button" className="btn small" disabled={busy || !ffmpeg} onClick={async () => {
            setBusy(true)
            const photo = await takePhoto(camera)
            setBusy(false)
            if (photo) onChange(photo.id)
          }}><Icon name="camera" size={16} /> {busy ? t('Nimmt auf …') : t('Jetzt fotografieren')}</button>
          {(photos || []).filter((p) => p.id !== value).slice(0, 5).map((p) => (
            <button type="button" key={p.id} className="gp-photo-choice" onClick={() => onChange(p.id)} aria-label={t('Foto vom {date} nehmen', { date: photoDate(p.ts) })}>
              <img src={photoUrl(p.id, true)} alt="" loading="lazy" />
              <span>{new Date(p.ts * 1000).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// ------------------------------------------------------------------ watering
export function WateringNotices({ g }) {
  const items = useStore((s) => s.watering?.suggestions?.[g.planId]) || []
  if (!items.length) return null
  const dismiss = async (s) => {
    try {
      await api(`/growplan/plans/${encodeURIComponent(g.planId)}/suggestions/${encodeURIComponent(s.id)}`, { method: 'DELETE' })
    } catch {
      /* toast shown */
    }
  }
  return (
    <div className="stack gp-gapb" style={{ gap: 8 }}>
      {items.slice().reverse().map((s) => (
        <div className="notice frost gp-suggest" key={s.id}>
          <span>
            {t('{label} {date} um {time} ist die Bodenfeuchte ({source}) von {before} % auf {after} % gestiegen.', {
              label: <b>{t('Gießung erkannt:')}</b>,
              date: fmtDate(s.date),
              time: s.time,
              source: [s.sensor && s.sensor.toLowerCase() !== 'bodenfeuchte' ? t(s.sensor) : null, s.device].filter(Boolean).join(', '),
              before: fmt(s.before, 0),
              after: fmt(s.after, 0),
            })}
          </span>
          <span className="row" style={{ gap: 6 }}>
            <button type="button" className="btn small primary" onClick={() => g.open({
              kind: 'entry', isNew: true, suggestion: s.id,
              entry: { ...newEntry(g.plan, g.lib, g.pos, g.today), date: s.date },
            })}>{t('Als Gießung eintragen')}</button>
            <button type="button" className="btn small ghost" onClick={() => dismiss(s)}>{t('Verwerfen')}</button>
          </span>
        </div>
      ))}
    </div>
  )
}

const DAY_CHOICES = [0, 1, 2, 3, 4, 5, 6, 7, 10, 14]

export function WateringSettings({ g }) {
  const stored = useStore((s) => s.watering?.settings?.[g.planId])
  const cfg = { days: 0, time: '09:00', soil_below: null, detect: true, ...(stored || {}) }
  const probes = g.tent.devices.flatMap((d) => d.sensors.filter((s) => s.kind === 'soil_moisture').map((s) => ({ d, s })))
  const single = probes.filter((p) => !p.s.key.includes('avg'))
  const shown = single.length ? single : probes
  const soilNow = shown.length ? shown.reduce((sum, p) => sum + (p.s.value ?? 0), 0) / shown.length : null
  const [soilText, setSoilText] = useState(cfg.soil_below != null ? dec(cfg.soil_below) : '')
  useEffect(() => setSoilText(cfg.soil_below != null ? dec(cfg.soil_below) : ''), [cfg.soil_below])
  const save = async (patch) => {
    try {
      await api(`/growplan/plans/${encodeURIComponent(g.planId)}/watering`, { method: 'PUT', body: { ...cfg, ...patch } })
    } catch {
      /* toast shown */
    }
  }
  return (
    <Block title={t('Erinnerungen')} hint={t('im Protokoll und per Telegram')}>
      <div className="panel gp-pad stack">
        <div className="gp-form2">
          <Field label={t('Erinnern nach Tagen ohne Gießung')}>
            <select className="input" value={cfg.days} onChange={(e) => save({ days: Number(e.target.value) })}>
              {DAY_CHOICES.map((d) => <option key={d} value={d}>{d === 0 ? t('Nicht erinnern') : d === 1 ? t('{n} Tag', { n: d }) : t('{n} Tagen', { n: d })}</option>)}
            </select>
          </Field>
          <Field label={t('Uhrzeit der Erinnerung')}>
            <input className="input" type="time" value={cfg.time} disabled={!cfg.days} onChange={(e) => e.target.value && save({ time: e.target.value })} />
          </Field>
        </div>
        {shown.length ? (
          <>
            <Field label={t('Erinnern, wenn die Bodenfeuchte fällt unter (%)')}
              hint={shown.length === 1
                ? t('Jetzt {value} % im Mittel von {n} Sonde. Leer lassen für keine Erinnerung.', { value: fmt(soilNow, 0), n: shown.length })
                : t('Jetzt {value} % im Mittel von {n} Sonden. Leer lassen für keine Erinnerung.', { value: fmt(soilNow, 0), n: shown.length })}>
              <input className="input" inputMode="decimal" placeholder={t('z. B. 30')} value={soilText}
                onChange={(e) => setSoilText(e.target.value)}
                onBlur={() => {
                  const text = soilText.trim().replace(',', '.')
                  const value = text === '' ? null : Number(text)
                  if (value !== null && !(value >= 1 && value <= 99)) {
                    toast(t('Bitte eine Zahl zwischen 1 und 99 eintragen'), 'warn')
                    return
                  }
                  if (value !== cfg.soil_below) save({ soil_below: value })
                }} />
            </Field>
            <div className="row" style={{ gap: 10 }}>
              <Toggle checked={cfg.detect} onChange={(detect) => save({ detect })} label={t('Gießungen an der Bodenfeuchte erkennen')} />
              <span className="small">{t('Gießungen an der Bodenfeuchte erkennen und zum Eintragen vorschlagen')}</span>
            </div>
          </>
        ) : (
          <p className="small muted" style={{ margin: 0 }}>
            {t('Mit einer Bodenfeuchte-Sonde im Zelt erinnert GrowDeck auch bei trockener Erde und erkennt Gießungen von selbst.')}
          </p>
        )}
      </div>
    </Block>
  )
}

// ------------------------------------------------------------------- alarm
export function PlanAlarmBlock({ g }) {
  const tick = useStore((s) => s.alarmStatus)
  const [alarms, setAlarms] = useState(null)
  const roomId = g.tent.room?.id || (g.tent.implicit ? 'alle' : null)
  const load = async () => {
    try {
      const data = await api('/alarms', { quiet: true })
      setAlarms(data.alarms)
    } catch {
      setAlarms([])
    }
  }
  useEffect(() => {
    load()
  }, [])
  if (!roomId || alarms == null) return null
  const alarm = alarms.find((a) => a.kind === 'growplan' && a.room_id === roomId)
  const status = tick?.[alarm?.id]
  const metricName = (k) => ({ temp: t('Temperatur'), humi: t('Luftfeuchte'), vpd: 'VPD' }[k])
  const firing = Object.entries(status?.metrics || {}).filter(([, m]) => m.firing).map(([k]) => metricName(k))
  const toggle = async (on) => {
    try {
      if (alarm) await api(`/alarms/${alarm.id}`, { method: 'PUT', body: { ...alarm, enabled: on } })
      else await api('/alarms', { method: 'POST', body: { kind: 'growplan', room_id: roomId, metrics: ['temp', 'humi', 'vpd'], delay_minutes: 30 } })
      toast(on ? t('Growplan-Alarm ist an.') : t('Growplan-Alarm ist aus.'))
      load()
    } catch {
      /* toast shown */
    }
  }
  const on = !!alarm && alarm.enabled !== false
  return (
    <Block title={t('Alarm bei Abweichung')}>
      <div className="panel gp-pad stack">
        <div className="row" style={{ gap: 10 }}>
          <Toggle checked={on} onChange={toggle} label={t('Alarm, wenn das Klima die Ziele dieser Woche verlässt')} />
          <span>{on ? t('Meldet, wenn das Klima die Ziele dieser Woche verlässt') : t('Kein Alarm eingerichtet')}</span>
        </div>
        {on ? (
          <p className="small" style={{ margin: 0 }}>
            {firing.length ? <b>{t('Gerade ausgelöst: {metrics}.', { metrics: firing.join(', ') })} </b> : `${t('Gerade alles im Ziel.')} `}
            {alarm.strict
              ? t('{metrics}, nach {min} min außerhalb.', { metrics: alarm.metrics.map(metricName).join(', '), min: fmt(alarm.delay_minutes, 0) })
              : t('{metrics}, nach {min} min außerhalb (mit Spielraum 1 °C, 5 %, 0,15 kPa).', { metrics: alarm.metrics.map(metricName).join(', '), min: fmt(alarm.delay_minutes, 0) })}
          </p>
        ) : null}
        <p className="small muted" style={{ margin: 0 }}>
          {t('Die Grenzen wandern mit dem Plan: Tag und Nacht, Woche für Woche. Einstellen unter {alarms}.', { alarms: <a href={href('alarms')}>{t('Alarme')}</a> })}
        </p>
      </div>
    </Block>
  )
}

// ---------------------------------------------------------------- archive
function defaultName(title, iso) {
  const month = new Date(`${iso}T12:00:00`).toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' })
  return t('{title} – Ernte {month}', { title, month })
}

export function CloseGrowDialog({ g, onClose }) {
  const strains = [...new Set(activePlants(g.plan).map((p) => p.strain).filter(Boolean))].join(', ')
  const [draft, setDraft] = useState(() => ({
    harvested: g.today, yield_g: '', name: defaultName(g.title, g.today), strain: strains, notes: '', reset: true,
  }))
  const [busy, setBusy] = useState(false)
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }))
  const submit = async () => {
    setBusy(true)
    try {
      await g.flush()
      const body = { ...draft, yield_g: draft.yield_g.trim() === '' ? null : draft.yield_g.replace(',', '.') }
      const res = await api(`/growplan/plans/${encodeURIComponent(g.planId)}/archive`, { method: 'POST', body })
      toast(draft.reset ? t('Grow im Archiv gespeichert, der Plan startet neu.') : t('Grow im Archiv gespeichert.'))
      onClose()
      go(`archiv/${res.grow.id}`)
    } catch {
      /* toast shown */
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title={t('Grow abschließen')} onClose={onClose}
      actions={<>
        <button type="button" className="btn ghost" onClick={onClose}>{t('Abbrechen')}</button>
        <button type="button" className="btn primary" disabled={busy} onClick={submit}>{busy ? t('Speichere …') : t('Ins Archiv')}</button>
      </>}>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>
          {g.log.length === 1
            ? t('GrowDeck hebt Plan, Gießprotokoll ({n} Eintrag), Klima der ganzen Zeit, Stromschätzung und Fotos im Archiv auf.', { n: g.log.length })
            : t('GrowDeck hebt Plan, Gießprotokoll ({n} Einträge), Klima der ganzen Zeit, Stromschätzung und Fotos im Archiv auf.', { n: g.log.length })}
        </p>
        <div className="gp-form2">
          <Field label={t('Erntedatum')}><input className="input" type="date" value={draft.harvested} max={g.today} onChange={(e) => set({ harvested: e.target.value })} /></Field>
          <Field label={t('Ertrag getrocknet (g)')} hint={t('Kann später im Archiv nachgetragen werden')}>
            <input className="input" inputMode="decimal" placeholder={t('z. B. 380')} value={draft.yield_g} onChange={(e) => set({ yield_g: e.target.value })} />
          </Field>
        </div>
        <Field label={t('Name')}><input className="input" maxLength={80} value={draft.name} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label={t('Sorte(n)')}><input className="input" maxLength={120} value={draft.strain} onChange={(e) => set({ strain: e.target.value })} /></Field>
        <Field label={t('Notizen')}>
          <textarea className="input gp-textarea" maxLength={4000} value={draft.notes} placeholder={t('Was lief gut, was machst du beim nächsten Mal anders?')}
            onChange={(e) => set({ notes: e.target.value })} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={draft.reset} onChange={(e) => set({ reset: e.target.checked })} />
          {t('Plan für den nächsten Grow neu starten: Protokoll leeren, Start- und Blütedatum zurücksetzen. Schema, Lampe, Zelt und Pflanzen bleiben.')}
        </label>
      </div>
    </Modal>
  )
}

export function ArchiveBlock({ g }) {
  const [open, setOpen] = useState(false)
  const tick = useStore((s) => s.growTick)
  const [count, setCount] = useState(null)
  useEffect(() => {
    api('/grows', { quiet: true }).then((d) => setCount(d.grows.length)).catch(() => setCount(0))
  }, [tick])
  return (
    <Block title={t('Ernte & Archiv')}>
      <div className="panel gp-pad stack">
        <p className="small" style={{ margin: 0 }}>
          {t('Nach der Ernte schließt du den Grow ab: Ertrag, Klima, Fotos und Gießprotokoll kommen ins Archiv, der Plan startet für den nächsten Durchgang neu.')}
        </p>
        <div className="row">
          <button type="button" className="btn small primary" onClick={() => setOpen(true)}>{t('Grow abschließen')}</button>
          <a className="btn small ghost" href={href('archiv')}>{t('Archiv')}{count ? ` (${count})` : ''}</a>
        </div>
      </div>
      {open ? <CloseGrowDialog g={g} onClose={() => setOpen(false)} /> : null}
    </Block>
  )
}

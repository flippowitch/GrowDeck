import { useEffect, useState } from 'react'
import { api, loadEvents, setState, toast, useStore } from '../store.js'
import { href } from '../router.js'
import { dateTime, fmt } from '../format.js'
import Icon from '../components/Icon.jsx'
import { Empty, Field, Modal, NumberInput, Segmented, Toggle } from '../components/ui.jsx'
import { findSensor, sensorLabel, SensorSelect } from '../components/pickers.jsx'
import { judge, rangeText } from '../targets.js'
import { t } from '../i18n.js'

const PLAN_METRICS = [
  { key: 'temp', label: t('Temperatur'), unit: '°C', digits: 1 },
  { key: 'humi', label: t('Luftfeuchte'), unit: '%', digits: 0 },
  { key: 'vpd', label: 'VPD', unit: 'kPa', digits: 2 },
]

// Tents a Growplan alarm can follow: the rooms, or all devices while there is no room.
function useTents() {
  const rooms = useStore((s) => s.rooms)
  const plans = useStore((s) => s.growplans)
  if (rooms.length) return rooms.map((r) => ({ id: r.id, name: r.name, plan: plans.find((p) => p.room_id === r.id) || null }))
  const loose = [...plans].filter((p) => !p.room_id).sort((a, b) => b.updated - a.updated)[0] || null
  return [{ id: 'alle', name: t('Alle Geräte'), plan: loose }]
}

function PlanAlarmEditor({ alarm, onClose, onSaved }) {
  const tents = useTents()
  const [draft, setDraft] = useState({ metrics: ['temp', 'humi', 'vpd'], delay_minutes: 30, strict: false, enabled: true,
    room_id: tents.find((x) => x.plan)?.id || tents[0]?.id || '', ...alarm, kind: 'growplan' })
  const tent = tents.find((x) => x.id === draft.room_id)
  const toggleMetric = (key) => setDraft((d) => ({ ...d, metrics: d.metrics.includes(key) ? d.metrics.filter((m) => m !== key) : [...d.metrics, key] }))
  const save = async () => {
    try {
      if (draft.id) await api(`/alarms/${draft.id}`, { method: 'PUT', body: draft })
      else await api('/alarms', { method: 'POST', body: draft })
      toast(t('Growplan-Alarm gespeichert.'))
      onSaved()
      onClose()
    } catch {
      /* toast shown */
    }
  }
  return (
    <Modal title={draft.id ? t('Growplan-Alarm bearbeiten') : t('Neuer Growplan-Alarm')} onClose={onClose}
      actions={<>
        <button className="btn ghost" onClick={onClose}>{t('Abbrechen')}</button>
        <button className="btn primary" onClick={save}>{t('Alarm speichern')}</button>
      </>}>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>
          {t('Vergleicht das Klima des Zelts mit den Zielbereichen der aktuellen Woche im Growplan, getrennt für Tag und Nacht. Die Grenzen wandern mit dem Plan, du musst nichts nachstellen.')}
        </p>
        <Field label={t('Zelt')}>
          <select className="input" value={draft.room_id} onChange={(e) => setDraft({ ...draft, room_id: e.target.value })}>
            {tents.map((x) => <option key={x.id} value={x.id}>{x.plan ? x.name : t('{name} (noch ohne Growplan)', { name: x.name })}</option>)}
          </select>
        </Field>
        {tent && !tent.plan ? <div className="notice small">{t('Dieses Zelt hat noch keinen Growplan. Der Alarm wartet, bis es einen gibt.')}</div> : null}
        <div className="field">
          <span>{t('Überwachen')}</span>
          <div className="row">
            {PLAN_METRICS.map((m) => (
              <label className="check" key={m.key}>
                <input type="checkbox" checked={draft.metrics.includes(m.key)} onChange={() => toggleMetric(m.key)} /> {m.label}
              </label>
            ))}
          </div>
        </div>
        <div className="form-grid">
          <Field label={t('Auslösen nach (Minuten)')} hint={t('So lange muss der Wert außerhalb liegen')}>
            <NumberInput min={0} max={1440} value={draft.delay_minutes} onChange={(delay_minutes) => setDraft({ ...draft, delay_minutes: delay_minutes ?? 0 })} />
          </Field>
        </div>
        <div className="field">
          <span>{t('Auslösen, wenn der Wert')}</span>
          <Segmented label={t('Spielraum')} value={draft.strict ? 'strict' : 'margin'} onChange={(v) => setDraft({ ...draft, strict: v === 'strict' })}
            options={[{ key: 'margin', label: t('deutlich außerhalb liegt') }, { key: 'strict', label: t('den Bereich verlässt') }]} />
          <span className="hint">{t('„Deutlich“ heißt: mehr als 1 °C, 5 % Luftfeuchte oder 0,15 kPa VPD neben dem Zielbereich.')}</span>
        </div>
        <label className="check">
          <input type="checkbox" checked={draft.enabled !== false} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
          {t('Alarm ist aktiv')}
        </label>
      </div>
    </Modal>
  )
}

function planStatusText(st) {
  const parts = []
  for (const m of PLAN_METRICS) {
    const ms = st?.metrics?.[m.key]
    if (!ms || ms.value == null || !ms.band) continue
    const j = judge(m.key, ms.value, ms.band)
    const word = ms.firing ? (j?.word ? t(j.word) : t('außerhalb')) : j && !j.inside ? t(j.word) : ''
    const vars = { label: m.label, value: `${fmt(ms.value, m.digits)} ${m.unit}`, range: rangeText(m.key, ms.band), word }
    if (ms.phase === 'night') {
      parts.push(word ? t('{label} {value} (Ziel Nacht {range}, {word})', vars) : t('{label} {value} (Ziel Nacht {range})', vars))
    } else {
      parts.push(word ? t('{label} {value} (Ziel {range}, {word})', vars) : t('{label} {value} (Ziel {range})', vars))
    }
  }
  return parts.join(' · ')
}

// One-click alarms for things that need one: tanks, water detectors, tents with a Growplan.
function useSuggestions(alarms, devices) {
  const tents = useTents()
  const list = []
  const covered = new Set(alarms.filter((a) => !a.kind).map((a) => `${a.device_id}|${a.sensor}`))
  for (const d of Object.values(devices)) {
    if (d.info?.hidden) continue
    for (const s of d.sensors) {
      if (covered.has(`${d.id}|${s.key}`)) continue
      if (s.kind === 'water') {
        list.push({ key: `${d.id}|${s.key}`, title: t('Wassertank von {name}', { name: d.name }), text: t('Meldet, wenn der Wasserstand unter 20 % fällt.'),
          alarm: { name: t('{name}: Tank fast leer', { name: d.name }), device_id: d.id, sensor: s.key, min: 20, max: null, delay_minutes: 5, enabled: true } })
      }
      if (s.kind === 'leak') {
        list.push({ key: `${d.id}|${s.key}`, title: t('{sensor} an {name}', { sensor: t(s.label), name: d.name }), text: t('Meldet sofort, wenn der Wassermelder nass wird.'),
          alarm: { name: t('{name}: Wasser erkannt', { name: d.name }), device_id: d.id, sensor: s.key, min: null, max: 0.5, delay_minutes: 0, enabled: true } })
      }
    }
  }
  for (const tent of tents) {
    if (!tent.plan || alarms.some((a) => a.kind === 'growplan' && a.room_id === tent.id)) continue
    list.push({ key: `gp-${tent.id}`, title: t('{name}: Klima nach Growplan überwachen', { name: tent.name }),
      text: t('Meldet, wenn Temperatur, Luftfeuchte oder VPD länger als 30 Minuten deutlich neben den Zielen der Woche liegen.'),
      alarm: { kind: 'growplan', room_id: tent.id, metrics: ['temp', 'humi', 'vpd'], delay_minutes: 30, enabled: true } })
  }
  return list
}

function AlarmEditor({ alarm, devices, onClose, onSaved }) {
  const [draft, setDraft] = useState({ ...alarm })
  const { device, sensor } = findSensor(devices, draft.device_id, draft.sensor)
  const save = async () => {
    const body = { ...draft }
    if (!body.name && device && sensor) body.name = `${device.name}: ${sensorLabel(sensor)}`
    try {
      if (draft.id) await api(`/alarms/${draft.id}`, { method: 'PUT', body })
      else await api('/alarms', { method: 'POST', body })
      toast(t('Alarm gespeichert.'))
      onSaved()
      onClose()
    } catch {
      /* toast shown */
    }
  }
  return (
    <Modal title={draft.id ? t('Alarm bearbeiten') : t('Neuer Alarm')} onClose={onClose}
      actions={<>
        <button className="btn ghost" onClick={onClose}>{t('Abbrechen')}</button>
        <button className="btn primary" onClick={save}>{t('Alarm speichern')}</button>
      </>}>
      <div className="stack">
        <Field label={t('Sensor')}>
          <SensorSelect devices={devices} value={draft.device_id ? `${draft.device_id}|${draft.sensor}` : ''}
            onChange={(v) => {
              const [device_id, key] = v.split('|')
              setDraft({ ...draft, device_id: device_id || '', sensor: key || '' })
            }} />
        </Field>
        <Field label={t('Name')} hint={t('Leer lassen für Gerät und Sensor als Namen')}>
          <input className="input" value={draft.name || ''} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </Field>
        <div className="form-grid">
          <Field label={sensor?.unit ? t('Untere Grenze ({unit})', { unit: sensor.unit }) : t('Untere Grenze')} hint={t('Leer = keine')}>
            <NumberInput step={0.1} value={draft.min} onChange={(min) => setDraft({ ...draft, min })} />
          </Field>
          <Field label={sensor?.unit ? t('Obere Grenze ({unit})', { unit: sensor.unit }) : t('Obere Grenze')} hint={t('Leer = keine')}>
            <NumberInput step={0.1} value={draft.max} onChange={(max) => setDraft({ ...draft, max })} />
          </Field>
          <Field label={t('Auslösen nach (Minuten)')} hint={t('So lange muss der Wert außerhalb liegen')}>
            <NumberInput min={0} value={draft.delay_minutes} onChange={(delay_minutes) => setDraft({ ...draft, delay_minutes: delay_minutes ?? 0 })} />
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={draft.enabled !== false} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
          {t('Alarm ist aktiv')}
        </label>
        <p className="muted small" style={{ margin: 0 }}>
          {t('Alarme erscheinen hier im Protokoll und, falls eingerichtet, als Benachrichtigung auf dem Handy. Die Benachrichtigungen richtest du unter {link} ein.', {
            link: <a href={href('options')}>{t('Optionen')}</a>,
          })}
        </p>
      </div>
    </Modal>
  )
}

const CATEGORIES = [
  { key: 'all', label: t('Alles') },
  { key: 'alarm', label: t('Alarme') },
  { key: 'water', label: t('Wasser') },
  { key: 'automation', label: t('Regeln') },
  { key: 'device', label: t('Geräte') },
  { key: 'integration', label: t('Verbindungen') },
]

export default function Alarms() {
  const devices = useStore((s) => s.devices)
  const status = useStore((s) => s.alarmStatus)
  const events = useStore((s) => s.events)
  const [alarms, setAlarms] = useState([])
  const [editing, setEditing] = useState(null)
  const [planEditing, setPlanEditing] = useState(null)
  const [category, setCategory] = useState('all')
  const suggestions = useSuggestions(alarms, devices)
  const [hidden, setHidden] = useState([])
  const shownSuggestions = suggestions.filter((x) => !hidden.includes(x.key))

  const load = async () => {
    try {
      const data = await api('/alarms', { quiet: true })
      setAlarms(data.alarms)
      setState({ alarmStatus: data.status })
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    load()
    loadEvents()
    const id = setInterval(load, 20000)
    return () => clearInterval(id)
  }, [])

  const toggleAlarm = async (alarm) => {
    await api(`/alarms/${alarm.id}`, { method: 'PUT', body: { ...alarm, enabled: alarm.enabled === false } }).catch(() => {})
    load()
  }
  const remove = async (alarm) => {
    if (!window.confirm(t('Alarm „{name}“ löschen?', { name: t(alarm.name) }))) return
    await api(`/alarms/${alarm.id}`, { method: 'DELETE' }).catch(() => {})
    load()
  }
  const ackAll = async () => {
    await api('/events/ack', { method: 'POST', body: {} }).catch(() => {})
    setState((s) => ({ unread: 0, events: s.events.map((e) => ({ ...e, acknowledged: 1 })) }))
  }

  const shown = events.filter((e) => category === 'all' || e.category === category)
  const unread = events.some((e) => !e.acknowledged && e.level !== 'info')

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('Alarme')}</h1>
          <p>{t('Lege Grenzen für Messwerte fest oder lass das Klima mit dem Growplan vergleichen. Bleibt ein Wert länger außerhalb, meldet GrowDeck das hier und auf Wunsch per Benachrichtigung.')}</p>
        </div>
        <div className="row page-tools">
          <button className="btn" onClick={() => setPlanEditing({})}>
            <Icon name="growplan" size={18} /> {t('Growplan-Alarm')}
          </button>
          <button className="btn primary" onClick={() => setEditing({ device_id: '', sensor: '', min: null, max: null, delay_minutes: 5, enabled: true })}>
            <Icon name="plus" size={18} /> {t('Neuer Alarm')}
          </button>
        </div>
      </div>

      {shownSuggestions.length ? (
        <section className="panel alarm-suggest" aria-labelledby="suggest-head">
          <h2 className="sub panel-pad" id="suggest-head" style={{ margin: 0, paddingBottom: 0 }}>{t('Vorschläge')}</h2>
          {shownSuggestions.map((x) => (
            <div className="list-row" key={x.key}>
              <div style={{ minWidth: 0 }}>
                <div className="title">{x.title}</div>
                <div className="meta">{x.text}</div>
              </div>
              <div className="row" style={{ gap: 4 }}>
                <button className="btn small" onClick={async () => {
                  try {
                    await api('/alarms', { method: 'POST', body: x.alarm })
                    toast(t('Alarm angelegt.'))
                    load()
                  } catch {
                    /* toast shown */
                  }
                }}>{t('Anlegen')}</button>
                <button className="btn small ghost" onClick={() => setHidden((h) => [...h, x.key])}>{t('Ausblenden')}</button>
              </div>
            </div>
          ))}
        </section>
      ) : null}

      <div className="panel">
        {!alarms.length ? (
          <Empty title={t('Noch keine Alarme')}>{t('Zum Beispiel: Meldung, wenn die Temperatur im Zelt länger als 5 Minuten über 30 °C liegt.')}</Empty>
        ) : null}
        {alarms.map((alarm) => {
          const st = status?.[alarm.id]
          if (alarm.kind === 'growplan') {
            const text = planStatusText(st)
            return (
              <div className="list-row" key={alarm.id}>
                <div style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <span className="title">{t(alarm.name)}</span>
                    <span className="chip leaf">Growplan</span>
                    {alarm.enabled === false ? <span className="chip">{t('Aus')}</span>
                      : st?.firing ? <span className="chip alert">{t('Ausgelöst')}</span>
                        : st?.message ? <span className="chip">{t('Wartet')}</span>
                          : <span className="chip leaf">{t('Im Bereich')}</span>}
                  </div>
                  <div className="meta">
                    {t('Folgt den Zielen der Woche')} · {alarm.metrics.map((m) => PLAN_METRICS.find((x) => x.key === m)?.label).join(', ')} ·{' '}
                    {alarm.strict ? t('nach {n} min, ohne Spielraum', { n: fmt(alarm.delay_minutes, 0) }) : t('nach {n} min', { n: fmt(alarm.delay_minutes, 0) })}
                  </div>
                  {st?.message ? <div className="meta">{t(st.message)}</div> : text ? <div className="meta num">{text}</div> : null}
                </div>
                <div className="row" style={{ gap: 4 }}>
                  <Toggle checked={alarm.enabled !== false} onChange={() => toggleAlarm(alarm)} label={t('{name} aktiv', { name: t(alarm.name) })} />
                  <button className="icon-btn" aria-label={t('Bearbeiten')} onClick={() => setPlanEditing(alarm)}><Icon name="edit" /></button>
                  <button className="icon-btn" aria-label={t('Löschen')} onClick={() => remove(alarm)}><Icon name="trash" /></button>
                </div>
              </div>
            )
          }
          const { sensor } = findSensor(devices, alarm.device_id, alarm.sensor)
          const unit = sensor?.unit ? ` ${sensor.unit}` : ''
          const limits = { min: `${fmt(alarm.min, 1)}${unit}`, max: `${fmt(alarm.max, 1)}${unit}`, n: fmt(alarm.delay_minutes, 0) }
          const reports = alarm.min != null && alarm.max != null ? t('Meldet unter {min} oder über {max}, nach {n} min.', limits)
            : alarm.min != null ? t('Meldet unter {min}, nach {n} min.', limits)
              : alarm.max != null ? t('Meldet über {max}, nach {n} min.', limits)
                : t('Meldet –, nach {n} min.', limits)
          return (
            <div className="list-row" key={alarm.id}>
              <div style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 8 }}>
                  <span className="title">{t(alarm.name)}</span>
                  {alarm.enabled === false ? <span className="chip">{t('Aus')}</span>
                    : st?.firing ? <span className="chip alert">{t('Ausgelöst')}</span>
                      : <span className="chip leaf">{t('Im Bereich')}</span>}
                  {st?.value != null ? <span className="small muted num">{t('aktuell {value}', { value: `${fmt(st.value, 1)}${unit}` })}</span> : null}
                </div>
                <div className="meta">{reports}</div>
              </div>
              <div className="row" style={{ gap: 4 }}>
                <Toggle checked={alarm.enabled !== false} onChange={() => toggleAlarm(alarm)} label={t('{name} aktiv', { name: t(alarm.name) })} />
                <button className="icon-btn" aria-label={t('Bearbeiten')} onClick={() => setEditing(alarm)}><Icon name="edit" /></button>
                <button className="icon-btn" aria-label={t('Löschen')} onClick={() => remove(alarm)}><Icon name="trash" /></button>
              </div>
            </div>
          )
        })}
      </div>

      <div className="spread">
        <h2 className="section">{t('Protokoll')}</h2>
        <div className="row">
          <Segmented label={t('Kategorie')} value={category} options={CATEGORIES} onChange={setCategory} />
          <button className="btn small" onClick={ackAll} disabled={!unread}>{t('Alle als gelesen markieren')}</button>
        </div>
      </div>
      <div className="panel">
        {!shown.length ? <p className="muted" style={{ padding: '14px 18px', margin: 0 }}>{t('Keine Einträge.')}</p> : null}
        {shown.slice(0, 150).map((e) => (
          <div key={e.id} className={`event ${e.level} ${!e.acknowledged && e.level !== 'info' ? 'unread' : ''}`}>
            <time dateTime={new Date(e.ts * 1000).toISOString()}>{dateTime(e.ts)}</time>
            <span className="msg">{t(e.message)}</span>
          </div>
        ))}
      </div>

      {editing ? <AlarmEditor alarm={editing} devices={devices} onClose={() => setEditing(null)} onSaved={load} /> : null}
      {planEditing ? <PlanAlarmEditor alarm={planEditing} onClose={() => setPlanEditing(null)} onSaved={load} /> : null}
    </>
  )
}

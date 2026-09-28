import { useEffect, useMemo, useState } from 'react'
import { api, useStore } from '../store.js'
import { DIGITS, SENSOR_TITLES } from '../format.js'
import HistoryChart from '../components/HistoryChart.jsx'
import { Empty, Segmented } from '../components/ui.jsx'
import { climateSource } from './Overview.jsx'
import { LOCALE, t } from '../i18n.js'

const RANGES = [
  { key: '6', label: t('{n} Std.', { n: 6 }) },
  { key: '24', label: t('{n} Std.', { n: 24 }) },
  { key: '168', label: t('{n} Tage', { n: 7 }) },
  { key: '720', label: t('{n} Tage', { n: 30 }) },
]
const STORAGE_KEY = 'gd-history-series'
// sensor groups of the tent itself (group names from the server, compared untranslated)
const TENT_GROUPS = ['Zelt', 'Box'] // i18n-ignore

function defaultSelection(devices, rooms) {
  for (const room of rooms) {
    const src = climateSource(room, devices, Object.values(devices).filter((d) => d.info?.room_id === room.id))
    if (src.device) return ['temp', 'humi', 'vpd'].filter((k) => src[k]).map((k) => `${src.device.id}|${src[k].key}`)
  }
  const first = Object.values(devices).find((d) => d.sensors.some((s) => s.kind === 'temp'))
  return first ? first.sensors.filter((s) => ['temp', 'humi', 'vpd'].includes(s.kind)).slice(0, 3).map((s) => `${first.id}|${s.key}`) : []
}

export default function History({ query }) {
  const devices = useStore((s) => s.devices)
  const rooms = useStore((s) => s.rooms)
  const [range, setRange] = useState('24')
  const [selected, setSelected] = useState(() => {
    const fromUrl = query?.get('series')
    if (fromUrl) return fromUrl.split(',')
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
      if (Array.isArray(stored) && stored.length) return stored
    } catch {
      /* ignore */
    }
    return null
  })
  const [data, setData] = useState({})
  const [loading, setLoading] = useState(false)

  const selection = selected ?? defaultSelection(devices, rooms)

  useEffect(() => {
    if (selected) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(selected))
      } catch {
        /* ignore */
      }
    }
  }, [selected])

  const selectionKey = selection.join(',')
  useEffect(() => {
    if (!selection.length) return undefined
    let alive = true
    setLoading(true)
    Promise.all(
      selection.map((key) => {
        const [deviceId, metric] = key.split('|')
        return api(`/history?device_id=${encodeURIComponent(deviceId)}&metric=${encodeURIComponent(metric)}&hours=${range}&points=500`, { quiet: true })
          .then((r) => [key, r])
          .catch(() => [key, null])
      }),
    ).then((results) => {
      if (!alive) return
      setData(Object.fromEntries(results))
      setLoading(false)
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey, range])

  const charts = useMemo(() => {
    const byKind = {}
    for (const key of selection) {
      const [deviceId, metric] = key.split('|')
      const device = devices[deviceId]
      const sensor = device?.sensors.find((s) => s.key === metric)
      const result = data[key]
      if (!result || !result.t.length) continue
      const kind = sensor?.kind || 'other'
      const unit = sensor?.unit || ''
      const bucket = (byKind[`${kind}|${unit}`] ||= { kind, unit, series: [] })
      bucket.series.push({
        label: `${device?.name || deviceId}: ${sensor ? t(sensor.label) : metric}${sensor?.group && !TENT_GROUPS.includes(sensor.group) ? ` (${t(sensor.group)})` : ''}`,
        t: result.t,
        v: result.avg,
      })
    }
    return Object.values(byKind)
  }, [selection, data, devices])

  const toggle = (key) => {
    const next = selection.includes(key) ? selection.filter((k) => k !== key) : [...selection, key]
    setSelected(next)
  }

  const deviceList = Object.values(devices)
    .filter((d) => d.sensors.length)
    .sort((a, b) => a.name.localeCompare(b.name, LOCALE))

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('Verlauf')}</h1>
          <p>{t('Messwerte werden jede Minute gespeichert. Wähle unten die Werte aus, die du vergleichen möchtest.')}</p>
        </div>
        <Segmented label={t('Zeitraum')} value={range} options={RANGES} onChange={setRange} />
      </div>

      {!deviceList.length ? (
        <div className="panel"><Empty title={t('Noch keine Messwerte')}>{t('Sobald Geräte Daten senden, entsteht hier der Verlauf.')}</Empty></div>
      ) : null}

      <div className="stack">
        {charts.map((c) => (
          <div className="panel chart-box" key={`${c.kind}|${c.unit}`}>
            <h3>{SENSOR_TITLES[c.kind] || t('Messwerte')}{c.unit ? ` in ${c.unit}` : ''}</h3>
            <HistoryChart series={c.series} unit={c.unit} digits={DIGITS[c.kind] ?? 1} />
          </div>
        ))}
        {selection.length && !charts.length && !loading ? (
          <div className="panel"><Empty title={t('Für diesen Zeitraum liegen keine Daten vor')}>{t('Der Verlauf füllt sich ab dem Start von GrowDeck.')}</Empty></div>
        ) : null}
      </div>

      {deviceList.length ? (
        <>
          <h2 className="section">{t('Werte auswählen')}</h2>
          <div className="panel panel-pad metric-picker">
            {deviceList.map((d) => (
              <fieldset key={d.id}>
                <legend>{d.name}</legend>
                <div className="opts">
                  {d.sensors.map((s) => {
                    const key = `${d.id}|${s.key}`
                    return (
                      <button key={key} type="button" className="pill-toggle" aria-pressed={selection.includes(key)} onClick={() => toggle(key)}>
                        {t(s.label)}{s.group && !TENT_GROUPS.includes(s.group) ? ` (${t(s.group)})` : ''}
                      </button>
                    )
                  })}
                </div>
              </fieldset>
            ))}
          </div>
        </>
      ) : null}
    </>
  )
}

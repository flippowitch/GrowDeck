import { useState } from 'react'
import { useStore } from '../store.js'
import { href } from '../router.js'
import { fmt, timeAgo, VENDORS } from '../format.js'
import { Empty, Segmented } from '../components/ui.jsx'
import { useNow } from './Overview.jsx'
import { LOCALE, t } from '../i18n.js'

const FILTERS = [
  { key: 'all', label: t('Alle') },
  { key: 'spiderfarmer', label: VENDORS.spiderfarmer },
  { key: 'vivosun', label: VENDORS.vivosun },
  { key: 'acinfinity', label: VENDORS.acinfinity },
  { key: 'offline', label: t('Offline') },
]

function snippet(device) {
  const temp = device.sensors.find((s) => s.key === 'temp')
  const humi = device.sensors.find((s) => s.key === 'humi')
  const parts = []
  if (temp) parts.push(`${fmt(temp.value, 1)} °C`)
  if (humi) parts.push(`${fmt(humi.value, 0)} %`)
  const active = device.controls.filter((c) => c.on).length
  if (device.controls.length) parts.push(t('{on} von {total} Ausgängen an', { on: active, total: device.controls.length }))
  return parts.join(', ')
}

export default function Devices() {
  const devices = useStore((s) => s.devices)
  const rooms = useStore((s) => s.rooms)
  const offset = useStore((s) => s.serverOffset)
  const [filter, setFilter] = useState('all')
  useNow(30000)

  const all = Object.values(devices)
  const list = all
    .filter((d) => (filter === 'all' ? true : filter === 'offline' ? !d.online : d.vendor === filter))
    .sort((a, b) => a.name.localeCompare(b.name, LOCALE))
  const vendors = ['spiderfarmer', 'vivosun', 'acinfinity'].filter((v) => list.some((d) => d.vendor === v))
  const roomName = (id) => rooms.find((r) => r.id === id)?.name

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('Geräte')}</h1>
          <p>{t('Alle Module beider Hersteller. Öffne ein Gerät für Zeitpläne, Modi und Geräteeinstellungen.')}</p>
        </div>
        <Segmented label={t('Filter')} value={filter} options={FILTERS} onChange={setFilter} />
      </div>
      {!all.length ? (
        <div className="panel">
          <Empty title={t('Noch keine Geräte')} action={<a className="btn primary" href={href('options')}>{t('Verbindungen einrichten')}</a>}>
            {t('Sobald Spider Farmer oder Vivosun verbunden ist, erscheinen die Geräte hier automatisch.')}
          </Empty>
        </div>
      ) : null}
      {all.length && !list.length ? <p className="muted">{t('Keine Geräte für diesen Filter.')}</p> : null}
      {vendors.map((vendor) => (
        <section key={vendor}>
          <h2 className="section">{VENDORS[vendor]}</h2>
          <div className="panel">
            {list.filter((d) => d.vendor === vendor).map((d) => (
              <a className="list-row" href={href(`devices/${d.id}`)} key={d.id}>
                <div style={{ minWidth: 0 }}>
                  <div className="title">{d.name}</div>
                  <div className="meta">
                    {t(d.model)}{roomName(d.info?.room_id) ? `, ${roomName(d.info.room_id)}` : ''}
                    {snippet(d) ? `. ${snippet(d)}` : ''}
                  </div>
                </div>
                <div className="row">
                  {d.simulated ? <span className="chip">{t('Simuliert')}</span> : null}
                  {d.info?.hidden ? <span className="chip">{t('Ausgeblendet')}</span> : null}
                  <span className={`chip ${d.online ? 'leaf' : 'alert'}`}>
                    {d.online ? t('Online') : t('Offline, {ago}', { ago: timeAgo(d.last_seen, offset) })}
                  </span>
                </div>
              </a>
            ))}
          </div>
        </section>
      ))}
    </>
  )
}

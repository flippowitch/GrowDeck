import { useEffect, useState } from 'react'
import { api, toast, useStore } from '../store.js'
import { go, href } from '../router.js'
import { dateTime, DIGITS, duration, sensorText, timeAgo, VENDORS } from '../format.js'
import { Readout } from '../components/Climate.jsx'
import ControlRow, { levelText } from '../components/ControlRow.jsx'
import Icon from '../components/Icon.jsx'
import { Empty, Field, Modal } from '../components/ui.jsx'
import { AciPortEditor, SfChannelEditor, SfOutletEditor, SfTargetsEditor, VsFanAutoEditor } from '../editors/Editors.jsx'
import { useNow } from './Overview.jsx'
import { t } from '../i18n.js'

function sourceLabel(source) {
  if (!source) return ''
  if (source === 'user') return t('Du')
  if (source === 'device') return t('Gerät oder Hersteller-App')
  if (source === 'start') return t('Stand beim Start von GrowDeck')
  if (source.startsWith('automation:')) return t('Regel')
  if (source.startsWith('room:')) return t('Zeltsteuerung')
  return source
}

function DeviceSettings({ device, rooms, onClose }) {
  const [name, setName] = useState(device.name === device.info?.default_name ? '' : device.name)
  const [room, setRoom] = useState(device.info?.room_id || '')
  const [hidden, setHidden] = useState(!!device.info?.hidden)
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    try {
      await api(`/devices/${device.id}`, {
        method: 'PATCH',
        body: { name, room_id: room || null, clear_room: !room, hidden },
      })
      toast(t('Gerät gespeichert.'))
      onClose()
    } catch {
      /* toast shown */
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal title={t('Geräteeinstellungen')} onClose={onClose}
      actions={<>
        <button className="btn ghost" onClick={onClose}>{t('Abbrechen')}</button>
        <button className="btn primary" onClick={save} disabled={saving}>{t('Speichern')}</button>
      </>}>
      <div className="stack">
        <Field label={t('Name')} hint={t('Leer lassen für den Standardnamen „{name}“.', { name: device.info?.default_name || device.model })}>
          <input className="input" value={name} maxLength={80} placeholder={device.info?.default_name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('Raum')}>
          <select className="input" value={room} onChange={(e) => setRoom(e.target.value)}>
            <option value="">{t('Kein Raum')}</option>
            {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </Field>
        <label className="check">
          <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
          {t('In der Übersicht ausblenden')}
        </label>
      </div>
    </Modal>
  )
}

function RenameControl({ device, control, onClose }) {
  const [label, setLabel] = useState(control.label === control.extra?.default_label ? '' : control.label)
  const save = async () => {
    try {
      await api(`/devices/${device.id}/controls/${encodeURIComponent(control.id)}`, { method: 'PATCH', body: { label } })
      toast(t('Name gespeichert.'))
      onClose()
    } catch {
      /* toast shown */
    }
  }
  return (
    <Modal title={t('Ausgang umbenennen')} onClose={onClose}
      actions={<>
        <button className="btn ghost" onClick={onClose}>{t('Abbrechen')}</button>
        <button className="btn primary" onClick={save}>{t('Speichern')}</button>
      </>}>
      <Field label={t('Name')} hint={t('Zum Beispiel „Befeuchter“ oder „Umluft oben“. Leer lassen für „{name}“.', {
        name: control.extra?.default_label ? t(control.extra.default_label) : control.id,
      })}>
        <input className="input" value={label} maxLength={60} placeholder={t(control.extra?.default_label)}
          onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
      </Field>
    </Modal>
  )
}

export default function DeviceDetail({ id }) {
  const device = useStore((s) => s.devices[id])
  const rooms = useStore((s) => s.rooms)
  const offset = useStore((s) => s.serverOffset)
  useNow(30000)
  const [editor, setEditor] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [renaming, setRenaming] = useState(null)
  const [log, setLog] = useState([])
  const [raw, setRaw] = useState(null)

  useEffect(() => {
    let alive = true
    const load = () => api(`/control-log?device_id=${encodeURIComponent(id)}&hours=48`, { quiet: true })
      .then((rows) => alive && setLog(rows))
      .catch(() => {})
    load()
    const timer = setInterval(load, 60000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [id])

  if (!device) {
    return (
      <>
        <a className="btn ghost small" href={href('devices')}><Icon name="back" size={18} /> {t('Alle Geräte')}</a>
        <div className="panel" style={{ marginTop: 16 }}>
          <Empty title={t('Gerät nicht gefunden')}>{t('Das Gerät ist nicht mehr verbunden oder wurde entfernt.')}</Empty>
        </div>
      </>
    )
  }

  const room = rooms.find((r) => r.id === device.info?.room_id)
  const groups = {}
  for (const s of device.sensors) (groups[s.group || t('Messwerte')] ||= []).push(s)
  const isSf = device.vendor === 'spiderfarmer'
  const hasTargets = isSf && ['cb', 'ps5', 'ps10', 'ss'].includes(device.info?.type)

  const refresh = async () => {
    try {
      await api(`/devices/${device.id}/refresh`, { method: 'POST' })
      toast(t('Aktualisierung angefordert.'))
    } catch {
      /* toast shown */
    }
  }
  const forget = async () => {
    if (!window.confirm(t('{name} aus GrowDeck entfernen? Der Verlauf bleibt erhalten.', { name: device.name }))) return
    try {
      await api(`/devices/${device.id}`, { method: 'DELETE' })
      go('devices')
    } catch {
      /* toast shown */
    }
  }
  const loadRaw = async () => {
    try {
      setRaw(await api(`/devices/${device.id}`))
    } catch {
      /* toast shown */
    }
  }

  const editButtons = (control) => {
    const f = control.features
    return (
      <>
        {f.includes('sf_schedule') ? (
          <button type="button" className="btn small" onClick={() => setEditor({ kind: 'sf_channel', control })}>{t('Zeitplan und Zyklus')}</button>
        ) : null}
        {f.includes('sf_outlet') ? (
          <button type="button" className="btn small" onClick={() => setEditor({ kind: 'sf_outlet', control })}>{t('Modus einrichten')}</button>
        ) : null}
        {f.includes('aci_port') ? (
          <button type="button" className="btn small" onClick={() => setEditor({ kind: 'aci_port', control })}>{t('Port einrichten')}</button>
        ) : null}
        {f.includes('vs_dfan_auto') ? (
          <button type="button" className="btn small" onClick={() => setEditor({ kind: 'vs_dfan', control })}>{t('Automatik-Grenzen')}</button>
        ) : null}
      </>
    )
  }

  const info = [
    [t('Hersteller'), VENDORS[device.vendor]],
    [t('Modell'), t(device.model)],
    [t('Raum'), room ? room.name : t('Kein Raum')],
    [t('Kennung'), device.native_id],
    [t('Firmware'), device.info?.firmware],
    [t('MAC-Adresse'), device.info?.mac],
    [t('WLAN-Signal'), device.info?.rssi != null ? `${device.info.rssi} dBm` : null],
    [t('Laufzeit'), device.info?.uptime ? duration(device.info.uptime) : null],
    [t('Tag oder Nacht laut Controller'), device.info?.day == null ? null : device.info.day ? t('Tag') : t('Nacht')],
    [t('Klimaziele des Controllers'), device.info?.day_targets == null ? null : device.info.day_targets ? t('Tagwerte aktiv') : t('Nachtwerte aktiv')],
    [t('Zuletzt Daten'), timeAgo(device.last_seen, offset)],
  ].filter(([, v]) => v)

  const controlLabel = (cid) => {
    const label = device.controls.find((c) => c.id === cid)?.label
    return label ? t(label) : cid
  }

  return (
    <>
      <a className="btn ghost small" href={href('devices')}><Icon name="back" size={18} /> {t('Alle Geräte')}</a>
      <div className="page-head" style={{ marginTop: 14 }}>
        <div>
          <h1>{device.name}</h1>
          <p>
            {VENDORS[device.vendor]} {t(device.model)}{room ? `, ${room.name}` : ''}.{' '}
            {/* German "vor 5 min" becomes "seit 5 min"; the English text keeps "5 min ago" */}
            {device.online ? t('Online.') : t('Offline seit {since}.', { since: timeAgo(device.last_seen, offset).replace('vor ', '') })}
          </p>
        </div>
        <div className="row">
          {hasTargets ? <button className="btn" onClick={() => setEditor({ kind: 'sf_targets' })}>{t('Klimaziele')}</button> : null}
          <button className="btn" onClick={refresh} disabled={!device.online}><Icon name="refresh" size={18} /> {t('Aktualisieren')}</button>
          <button className="btn" onClick={() => setSettingsOpen(true)}><Icon name="edit" size={18} /> {t('Einstellungen')}</button>
        </div>
      </div>

      {device.simulated ? (
        <div className="notice frost" style={{ marginBottom: 16 }}>{t('Dieses Gerät ist simuliert (Demo-Modus). Befehle wirken nur auf die Simulation.')}</div>
      ) : null}
      {!device.online ? (
        <div className="notice alert" style={{ marginBottom: 16 }}>
          {isSf
            ? t('Keine Daten vom Gerät. Prüfe, ob es mit dem WLAN verbunden ist und sein Datenverkehr über den Proxy auf der NAS läuft.')
            : device.vendor === 'acinfinity'
              ? t('Der Controller meldet sich nicht in der AC-Infinity-Cloud. Prüfe sein WLAN in der AC-Infinity-App und die Verbindung unter Optionen.')
              : t('Keine Daten aus der Vivosun-Cloud. Prüfe das Gerät in der Vivosun-App und die Verbindung unter Optionen.')}
        </div>
      ) : null}

      {device.info?.notice ? <div className="notice" style={{ marginBottom: 16 }}>{t(device.info.notice)}</div> : null}

      {Object.keys(groups).length ? (
        <>
          <h2 className="section">{t('Messwerte')}</h2>
          <div className="panel panel-pad stack">
            {Object.entries(groups).map(([group, sensors]) => (
              <div key={group}>
                <h3 className="sub" style={{ marginTop: 0 }}>{t(group)}</h3>
                <div className="readouts">
                  {sensors.map((s) => (
                    <a key={s.key} href={href(`history?series=${encodeURIComponent(`${device.id}|${s.key}`)}`)} style={{ textDecoration: 'none' }}>
                      <Readout compact label={t(s.label)} value={s.value} digits={DIGITS[s.kind] ?? 1} unit={s.unit} text={sensorText(s)} tone={s.kind === 'leak' && s.value ? 'warn' : ''} />
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {device.controls.length ? (
        <>
          <h2 className="section">{t('Ausgänge')}</h2>
          <div className="panel">
            <div className="controls" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
              {device.controls.map((c) => (
                <ControlRow key={c.id} device={device} control={c} detail onEdit={editButtons} onRename={setRenaming} />
              ))}
            </div>
          </div>
        </>
      ) : null}

      {device.info?.camera ? (
        <>
          <h2 className="section">{t('Kamera')}</h2>
          <div className="panel panel-pad prose">
            <p>{t('Die GrowCam lässt sich im Heimnetz per RTSP öffnen, zum Beispiel mit VLC oder in der Überwachungs-App der NAS.')}</p>
            <p>
              {t('Benutzer {user}, Passwort {password}', {
                user: <code>{device.info.camera.username || '–'}</code>,
                password: <code>{device.info.camera.password || '–'}</code>,
              })}
            </p>
            <p className="muted small">{t(device.info.camera.hint)}</p>
            <p>
              {t('GrowDeck kann mit der GrowCam jeden Tag Fotos machen und daraus einen Zeitraffer erstellen.')}{' '}
              <a href={href('options?bereich=kameras')}>{t('Unter Optionen → Kameras einrichten')}</a>
            </p>
          </div>
        </>
      ) : null}

      <h2 className="section">{t('Geräteinformationen')}</h2>
      <div className="panel table-wrap">
        <table className="data">
          <tbody>
            {info.map(([k, v]) => (
              <tr key={k}><th scope="row" style={{ width: 180 }}>{k}</th><td>{v}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="section">{t('Schaltprotokoll der letzten 48 Stunden')}</h2>
      <div className="panel table-wrap">
        {log.length ? (
          <table className="data">
            <thead><tr><th>{t('Zeit')}</th><th>{t('Ausgang')}</th><th>{t('Zustand')}</th><th>{t('Ausgelöst von')}</th></tr></thead>
            <tbody>
              {log.slice(0, 80).map((row, i) => {
                const control = device.controls.find((c) => c.id === row.control_id)
                const state = [row.on_state == null ? null : row.on_state ? t('Ein') : t('Aus'),
                  row.level != null && control?.features.includes('level') && row.on_state ? levelText(control, row.level) : null]
                  .filter(Boolean).join(', ')
                return (
                  <tr key={`${row.ts}-${i}`}>
                    <td className="num">{dateTime(row.ts)}</td>
                    <td>{controlLabel(row.control_id)}</td>
                    <td>{state || '–'}</td>
                    <td>{sourceLabel(row.source)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          <p className="muted" style={{ padding: '14px 18px', margin: 0 }}>{t('In den letzten 48 Stunden wurde nichts geschaltet.')}</p>
        )}
      </div>

      <h2 className="section">{t('Fehlersuche')}</h2>
      <details className="raw panel" onToggle={(e) => e.currentTarget.open && loadRaw()}>
        <summary>{t('Rohdaten des Geräts anzeigen')}</summary>
        <pre>{raw ? JSON.stringify({ raw: raw.raw, config: raw.config, info: raw.info }, null, 2) : t('Lade …')}</pre>
      </details>
      {!device.online ? (
        <div style={{ marginTop: 16 }}>
          <button className="btn danger" onClick={forget}><Icon name="trash" size={18} /> {t('Gerät entfernen')}</button>
        </div>
      ) : null}

      {settingsOpen ? <DeviceSettings device={device} rooms={rooms} onClose={() => setSettingsOpen(false)} /> : null}
      {renaming ? <RenameControl device={device} control={renaming} onClose={() => setRenaming(null)} /> : null}
      {editor?.kind === 'sf_channel' ? <SfChannelEditor device={device} control={editor.control} onClose={() => setEditor(null)} /> : null}
      {editor?.kind === 'sf_outlet' ? <SfOutletEditor device={device} control={editor.control} onClose={() => setEditor(null)} /> : null}
      {editor?.kind === 'sf_targets' ? <SfTargetsEditor device={device} onClose={() => setEditor(null)} /> : null}
      {editor?.kind === 'aci_port' ? <AciPortEditor device={device} control={editor.control} onClose={() => setEditor(null)} /> : null}
      {editor?.kind === 'vs_dfan' ? <VsFanAutoEditor device={device} control={editor.control} onClose={() => setEditor(null)} /> : null}
    </>
  )
}

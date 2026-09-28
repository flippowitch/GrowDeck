// Options → Kameras: GrowCams from the Vivosun account and other cameras (RTSP or image address),
// photo times, room and how long photos are kept.
import { useState } from 'react'
import { api, toast, useStore } from '../store.js'
import { href } from '../router.js'
import { formatBytes, photoDate, takePhoto, useCameras } from '../cameras.js'
import { t } from '../i18n.js'
import Icon from './Icon.jsx'
import { Empty, Field, Modal, Segmented } from './ui.jsx'

const KEEP = [
  { value: 0, label: t('Immer aufheben') },
  { value: 30, label: t('{n} Tage', { n: 30 }) },
  { value: 90, label: t('{n} Tage', { n: 90 }) },
  { value: 180, label: t('{n} Tage', { n: 180 }) },
  { value: 365, label: t('1 Jahr') },
]

function CameraEditor({ camera, data, onClose, onSaved }) {
  const rooms = useStore((s) => s.rooms)
  const devices = useStore((s) => s.devices)
  const isNew = !camera.id
  const [draft, setDraft] = useState(() => ({
    source: 'url', name: '', room_id: '', times: ['12:00'], only_light: true, enabled: true, keep_days: 0, ip: '', url: '',
    ...camera, url: camera.url_masked ?? camera.url ?? '',
  }))
  const [busy, setBusy] = useState(false)
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }))
  const growcams = [...data.growcams]
  if (camera.source === 'growcam' && camera.device_id && !growcams.some((g) => g.device_id === camera.device_id)) {
    growcams.unshift({ device_id: camera.device_id, name: camera.device_name || devices[camera.device_id]?.name || 'GrowCam' })
  }
  const sources = [
    ...(growcams.length ? [{ key: 'growcam', label: 'GrowCam' }] : []),
    { key: 'url', label: t('Adresse') },
    ...(data.demo ? [{ key: 'demo', label: t('Demo') }] : []),
  ]
  const pickGrowcam = (deviceId) => {
    const g = growcams.find((x) => x.device_id === deviceId)
    set({ device_id: deviceId, name: draft.name || g?.name || '', room_id: draft.room_id || g?.room_id || '' })
  }
  const save = async () => {
    const body = { ...draft, room_id: draft.room_id || null, times: draft.times.filter(Boolean) }
    if (body.source !== 'url') delete body.url
    setBusy(true)
    try {
      if (isNew) {
        const res = await api('/cameras', { method: 'POST', body })
        onSaved(res)
        onClose()
        toast(t('Kamera gespeichert. Ein Testfoto ist unterwegs …'))
        const created = res.cameras.find((c) => c.id === res.camera)
        if (created && data.ffmpeg) await takePhoto(created)
      } else {
        onSaved(await api(`/cameras/${encodeURIComponent(camera.id)}`, { method: 'PUT', body }))
        toast(t('Kamera gespeichert.'))
        onClose()
      }
    } catch {
      /* toast shown */
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title={isNew ? t('Kamera hinzufügen') : t('{name} bearbeiten', { name: camera.name })} onClose={onClose}
      actions={<>
        <button type="button" className="btn ghost" onClick={onClose}>{t('Abbrechen')}</button>
        <button type="button" className="btn primary" disabled={busy} onClick={save}>{busy ? t('Speichere …') : t('Speichern')}</button>
      </>}>
      <div className="stack">
        {sources.length > 1 ? (
          <div className="field">
            <span>{t('Kamera')}</span>
            <Segmented label={t('Art der Kamera')} value={draft.source} options={sources} onChange={(source) => {
              set({ source })
              if (source === 'growcam' && !draft.device_id && growcams[0]) pickGrowcam(growcams[0].device_id)
            }} />
          </div>
        ) : null}
        {draft.source === 'growcam' ? (
          <>
            <Field label={t('GrowCam aus dem Vivosun-Konto')}>
              <select className="input" value={draft.device_id || ''} onChange={(e) => pickGrowcam(e.target.value)}>
                <option value="" disabled>{t('Bitte wählen')}</option>
                {growcams.map((g) => <option key={g.device_id} value={g.device_id}>{g.name}</option>)}
              </select>
            </Field>
            <Field label={t('IP-Adresse der GrowCam im Heimnetz')} hint={t('Steht im Router, z. B. FRITZ!Box → Heimnetz → Netzwerk. Anmeldung und Port nimmt GrowDeck aus dem Vivosun-Konto.')}>
              <input className="input" inputMode="decimal" placeholder="192.168.178.50" value={draft.ip || ''} onChange={(e) => set({ ip: e.target.value.trim() })} />
            </Field>
          </>
        ) : null}
        {draft.source === 'url' ? (
          <Field label={t('Adresse der Kamera')} hint={t('RTSP-Stream (rtsp://benutzer:passwort@ip:554/…) oder ein Standbild (http://…/snapshot.jpg). Das Passwort bleibt auf der NAS.')}>
            <input className="input" type="text" spellCheck={false} autoComplete="off" placeholder={t('rtsp://admin:passwort@192.168.178.60:554/stream1')}
              value={draft.url || ''} onChange={(e) => set({ url: e.target.value })} />
          </Field>
        ) : null}
        {draft.source === 'demo' ? <p className="small muted" style={{ margin: 0 }}>{t('Die Demo-Kamera erzeugt Bilder, damit Galerie und Zeitraffer ausprobiert werden können.')}</p> : null}
        <div className="form-grid">
          <Field label={t('Name')}>
            <input className="input" maxLength={60} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label={t('Zelt')} hint={t('Fotos erscheinen im Growplan und im Archiv dieses Zelts')}>
            <select className="input" value={draft.room_id || ''} onChange={(e) => set({ room_id: e.target.value })}>
              <option value="">{t('Keinem Zelt zugeordnet')}</option>
              {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </Field>
        </div>
        <div className="field">
          <span>{t('Fotos täglich um')}</span>
          <div className="row">
            {draft.times.map((time, i) => (
              <span className="row cam-time" key={i}>
                <input className="input" type="time" value={time} aria-label={t('Uhrzeit {n}', { n: i + 1 })}
                  onChange={(e) => set({ times: draft.times.map((x, j) => (j === i ? e.target.value : x)) })} />
                {draft.times.length > 1 ? (
                  <button type="button" className="icon-btn" aria-label={t('Uhrzeit {time} entfernen', { time })} onClick={() => set({ times: draft.times.filter((_, j) => j !== i) })}>
                    <Icon name="close" size={16} />
                  </button>
                ) : null}
              </span>
            ))}
            {draft.times.length < 6 ? (
              <button type="button" className="btn small ghost" onClick={() => set({ times: [...draft.times, '16:00'] })}>
                <Icon name="plus" size={16} /> {t('Uhrzeit')}
              </button>
            ) : null}
          </div>
        </div>
        <label className="check">
          <input type="checkbox" checked={draft.only_light} onChange={(e) => set({ only_light: e.target.checked })} />
          {t('Nur fotografieren, wenn im Zelt Licht an ist')}
        </label>
        <div className="form-grid">
          <Field label={t('Fotos aufheben')} hint={t('Fotos an Protokolleinträgen bleiben immer')}>
            <select className="input" value={draft.keep_days || 0} onChange={(e) => set({ keep_days: Number(e.target.value) })}>
              {KEEP.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          {t('Zu den Uhrzeiten automatisch fotografieren')}
        </label>
      </div>
    </Modal>
  )
}

export default function CameraSettings() {
  const [data, setData] = useCameras()
  const rooms = useStore((s) => s.rooms)
  const [editing, setEditing] = useState(null)
  const [remove, setRemove] = useState(null)
  const [busy, setBusy] = useState('')
  if (!data) return <div className="panel panel-pad muted">{t('Lade Kameras …')}</div>
  const roomName = (id) => rooms.find((r) => r.id === id)?.name
  const describe = (c) => {
    const source = c.source === 'growcam' ? `${c.device_name || 'GrowCam'} (${c.ip})` : c.source === 'demo' ? t('Demo-Kamera') : c.url_masked
    const times = c.times.join(', ')
    const photos = c.photos === 1 ? t('{n} Foto', { n: c.photos }) : t('{n} Fotos', { n: c.photos })
    return [source, roomName(c.room_id), c.only_light ? t('täglich {times} Uhr, bei Licht', { times }) : t('täglich {times} Uhr', { times }),
      `${photos} (${formatBytes(c.bytes)})`].filter(Boolean).join(' · ')
  }
  const doRemove = async (withPhotos) => {
    try {
      setData(await api(`/cameras/${encodeURIComponent(remove.id)}?photos=${withPhotos ? 'true' : 'false'}`, { method: 'DELETE' }))
      toast(t('Kamera gelöscht.'))
      setRemove(null)
    } catch {
      /* toast shown */
    }
  }
  return (
    <div className="panel" id="kameras">
      {!data.ffmpeg ? (
        <div className="notice alert" style={{ margin: 14 }}>
          {t('Im Container fehlt ffmpeg, deshalb kann GrowDeck keine Fotos aufnehmen. Baue das Image mit der aktuellen {file} neu.', { file: <code>requirements.txt</code> })}
        </div>
      ) : null}
      {data.growcams.map((g) => (
        <div className="list-row" key={g.device_id}>
          <div>
            <div className="title">{g.name}</div>
            <div className="meta">{t('GrowCam aus deinem Vivosun-Konto, noch nicht für Fotos eingerichtet.')}</div>
          </div>
          <button type="button" className="btn small" onClick={() => setEditing({ source: 'growcam', device_id: g.device_id, name: g.name, room_id: g.room_id || '' })}>
            {t('Einrichten')}
          </button>
        </div>
      ))}
      {!data.cameras.length && !data.growcams.length ? (
        <Empty title={t('Noch keine Kamera')}>
          {t('GrowDeck fotografiert dein Zelt jeden Tag zur gleichen Zeit und macht daraus einen Zeitraffer. Geht mit der Vivosun GrowCam und mit jeder Kamera, die einen RTSP-Stream oder ein Standbild im Heimnetz anbietet.')}
        </Empty>
      ) : null}
      {data.cameras.map((c) => (
        <div className="list-row" key={c.id}>
          <div style={{ minWidth: 0 }}>
            <div className="row" style={{ gap: 8 }}>
              <a className="title" href={href(`kamera/${c.id}`)}>{c.name}</a>
              {!c.enabled ? <span className="chip">{t('Aus')}</span> : null}
              {c.last_error ? <span className="chip alert">{t('Fehler')}</span> : null}
            </div>
            <div className="meta">{describe(c)}</div>
            {c.last_error ? <div className="meta" role="alert">{t(c.last_error)}</div>
              : c.last_photo_ts ? <div className="meta">{t('Letztes Foto {date}', { date: photoDate(c.last_photo_ts) })}</div> : null}
          </div>
          <div className="row" style={{ gap: 4 }}>
            <a className="btn small ghost" href={href(`kamera/${c.id}`)}>{t('Fotos')}</a>
            <button type="button" className="btn small" disabled={!!busy || !data.ffmpeg} onClick={async () => {
              setBusy(c.id)
              await takePhoto(c)
              setBusy('')
            }}>{busy === c.id ? t('Nimmt auf …') : t('Foto jetzt')}</button>
            <button type="button" className="icon-btn" aria-label={t('{name} bearbeiten', { name: c.name })} onClick={() => setEditing(c)}><Icon name="edit" /></button>
            <button type="button" className="icon-btn" aria-label={t('{name} löschen', { name: c.name })} onClick={() => setRemove(c)}><Icon name="trash" /></button>
          </div>
        </div>
      ))}
      <div className="panel-pad">
        <button type="button" className="btn small" onClick={() => setEditing({})}><Icon name="plus" size={16} /> {t('Kamera hinzufügen')}</button>
      </div>
      {editing ? <CameraEditor camera={editing} data={data} onClose={() => setEditing(null)} onSaved={setData} /> : null}
      {remove ? (
        <Modal title={t('{name} löschen?', { name: remove.name })} onClose={() => setRemove(null)}
          actions={<>
            <button type="button" className="btn ghost" onClick={() => setRemove(null)}>{t('Abbrechen')}</button>
            <button type="button" className="btn" onClick={() => doRemove(false)}>{t('Nur Kamera löschen')}</button>
            <button type="button" className="btn danger" onClick={() => doRemove(true)}>{t('Mit allen Fotos löschen')}</button>
          </>}>
          <p className="muted" style={{ margin: 0 }}>
            {!remove.photos ? t('Die Kamera hat noch keine Fotos.')
              : remove.photos === 1 ? t('Die Kamera hat {n} Foto ({size}). Behältst du es, bleibt es im Growplan und im Archiv sichtbar.', { n: remove.photos, size: formatBytes(remove.bytes) })
                : t('Die Kamera hat {n} Fotos ({size}). Behältst du sie, bleiben sie im Growplan und im Archiv sichtbar.', { n: remove.photos, size: formatBytes(remove.bytes) })}
          </p>
        </Modal>
      ) : null}
    </div>
  )
}

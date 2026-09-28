// Gallery of one camera: photos by day, a large view, a photo on demand and time-lapse videos.
import { useEffect, useMemo, useState } from 'react'
import { api, toast, useStore } from '../store.js'
import { href } from '../router.js'
import Icon from '../components/Icon.jsx'
import { Empty, Field, Modal, Segmented } from '../components/ui.jsx'
import { formatBytes, photoDate, photoUrl, takePhoto, useCameras } from '../cameras.js'
import { todayISO } from '../growplan/engine.js'
import { LOCALE, t } from '../i18n.js'

const PAGE = 60
const SPEEDS = [
  { key: '4', label: t('Langsam') },
  { key: '8', label: t('Mittel') },
  { key: '16', label: t('Schnell') },
]

function isoDay(ts) {
  return todayISO(new Date(ts * 1000))
}

function monthLabel(ts) {
  return new Date(ts * 1000).toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' })
}

function thumbLabel(ts) {
  const d = new Date(ts * 1000)
  return `${d.toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'numeric' })}, ${d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })}`
}

function Lightbox({ photos, index, onIndex, onClose, onDeleted }) {
  const photo = photos[index]
  const [confirm, setConfirm] = useState(false)
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'ArrowLeft' && index < photos.length - 1) onIndex(index + 1)
      if (e.key === 'ArrowRight' && index > 0) onIndex(index - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, photos.length, onIndex])
  if (!photo) return null
  const remove = async () => {
    try {
      await api(`/photos/${photo.id.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' })
      toast(t('Foto gelöscht.'))
      setConfirm(false)
      onDeleted(photo.id)
    } catch {
      /* toast shown */
    }
  }
  return (
    <Modal wide title={photoDate(photo.ts)} onClose={onClose}
      actions={<>
        <button type="button" className="btn danger" style={{ marginRight: 'auto' }} onClick={() => setConfirm(true)}>{t('Löschen')}</button>
        <a className="btn" href={photoUrl(photo.id)} download={`${photo.id.replaceAll('/', '_')}.jpg`}>{t('Herunterladen')}</a>
        <button type="button" className="btn" disabled={index >= photos.length - 1} onClick={() => onIndex(index + 1)} aria-label={t('Älteres Foto')}>
          <Icon name="prev" size={18} />
        </button>
        <button type="button" className="btn" disabled={index <= 0} onClick={() => onIndex(index - 1)} aria-label={t('Neueres Foto')}>
          <Icon name="next" size={18} />
        </button>
      </>}>
      <img className="photo-large" src={photoUrl(photo.id)} alt={t('Foto vom {date}', { date: photoDate(photo.ts) })} />
      <p className="small muted" style={{ margin: '8px 0 0' }}>
        {photo.source === 'auto' ? t('Automatisch aufgenommen') : t('Von Hand aufgenommen')} · {formatBytes(photo.size)}
      </p>
      {confirm ? (
        <Modal title={t('Foto löschen?')} onClose={() => setConfirm(false)}
          actions={<>
            <button type="button" className="btn ghost" onClick={() => setConfirm(false)}>{t('Abbrechen')}</button>
            <button type="button" className="btn danger" onClick={remove}>{t('Löschen')}</button>
          </>}>
          <p className="muted" style={{ margin: 0 }}>{t('Das Foto wird von der NAS gelöscht. Hängt es an einem Protokolleintrag, fehlt es dort danach.')}</p>
        </Modal>
      ) : null}
    </Modal>
  )
}

function Timelapse({ camera, firstDay }) {
  const today = todayISO(new Date())
  const [start, setStart] = useState(firstDay || today)
  const [end, setEnd] = useState(today)
  const [speed, setSpeed] = useState('8')
  const [perDay, setPerDay] = useState(true)
  const [job, setJob] = useState(camera.job)
  const [busy, setBusy] = useState(false)
  useEffect(() => setJob(camera.job), [camera.job])
  useEffect(() => {
    if (firstDay) setStart(firstDay)
  }, [firstDay])
  useEffect(() => {
    if (!job?.running) return undefined
    const id = setInterval(async () => {
      try {
        const data = await api(`/cameras/${encodeURIComponent(camera.id)}/timelapse`, { quiet: true })
        setJob(data.job)
        if (data.job && !data.job.running) toast(data.job.error ? t('Zeitraffer: {error}', { error: t(data.job.error) }) : t('Der Zeitraffer ist fertig.'), data.job.error ? 'alert' : 'info')
      } catch {
        /* ignore */
      }
    }, 2000)
    return () => clearInterval(id)
  }, [job?.running, camera.id])
  const create = async () => {
    setBusy(true)
    try {
      setJob(await api(`/cameras/${encodeURIComponent(camera.id)}/timelapse`, {
        method: 'POST', body: { start, end, fps: Number(speed), per_day: perDay },
      }))
    } catch {
      /* toast shown */
    } finally {
      setBusy(false)
    }
  }
  const video = job?.file ? `/api/cameras/${encodeURIComponent(camera.id)}/videos/${encodeURIComponent(job.file)}` : null
  return (
    <section className="panel panel-pad stack" aria-labelledby="tl-head">
      <h2 className="sub" id="tl-head" style={{ margin: 0 }}>{t('Zeitraffer')}</h2>
      <div className="form-grid">
        <Field label={t('Von')}><input type="date" className="input" value={start} max={end} onChange={(e) => setStart(e.target.value)} /></Field>
        <Field label={t('Bis')}><input type="date" className="input" value={end} min={start} max={today} onChange={(e) => setEnd(e.target.value)} /></Field>
      </div>
      <div className="field">
        <span>{t('Tempo')}</span>
        <Segmented label={t('Tempo')} value={speed} options={SPEEDS} onChange={setSpeed} />
      </div>
      <label className="check">
        <input type="checkbox" checked={perDay} onChange={(e) => setPerDay(e.target.checked)} />
        {t('Ein Foto pro Tag (das um {time} Uhr), sonst alle Fotos', { time: camera.times?.[0] || '12:00' })}
      </label>
      <div className="row">
        <button type="button" className="btn primary" disabled={busy || job?.running} onClick={create}>
          {job?.running ? t('Erstelle Zeitraffer aus {n} Fotos …', { n: job.frames }) : t('Zeitraffer erstellen')}
        </button>
        {job?.error && !job.running ? <span className="small" role="alert">{t(job.error)}</span> : null}
      </div>
      {video && !job.running ? (
        <div className="stack" style={{ gap: 8 }}>
          <video className="timelapse" controls preload="metadata" src={video} />
          <div className="row small">
            <span className="muted">{job.file} · {formatBytes(job.size)}</span>
            <a href={`${video}?download=1`}>{t('Video herunterladen')}</a>
          </div>
        </div>
      ) : null}
    </section>
  )
}

export default function Camera({ id }) {
  const [data] = useCameras()
  const rooms = useStore((s) => s.rooms)
  const tick = useStore((s) => s.photoTick)
  const [photos, setPhotos] = useState(null)
  const [more, setMore] = useState(false)
  const [open, setOpen] = useState(null)
  const [busy, setBusy] = useState(false)
  const camera = data?.cameras.find((c) => c.id === id)

  useEffect(() => {
    let alive = true
    api(`/photos?camera_id=${encodeURIComponent(id)}&limit=${PAGE}`, { quiet: true })
      .then((d) => {
        if (!alive) return
        setPhotos(d.photos)
        setMore(d.photos.length === PAGE)
      })
      .catch(() => alive && setPhotos([]))
    return () => {
      alive = false
    }
  }, [id, tick])

  const loadMore = async () => {
    const last = photos[photos.length - 1]
    try {
      const d = await api(`/photos?camera_id=${encodeURIComponent(id)}&limit=${PAGE}&before=${last.ts}`, { quiet: true })
      setPhotos([...photos, ...d.photos])
      setMore(d.photos.length === PAGE)
    } catch {
      /* ignore */
    }
  }

  // grouped by month; each picture carries its day and time
  const months = useMemo(() => {
    const groups = []
    for (const [index, photo] of (photos || []).entries()) {
      const month = monthLabel(photo.ts)
      let group = groups[groups.length - 1]
      if (!group || group.month !== month) groups.push((group = { month, items: [] }))
      group.items.push({ photo, index })
    }
    return groups
  }, [photos])

  if (data && !camera) {
    return (
      <div className="panel">
        <Empty title={t('Diese Kamera gibt es nicht')} action={<a className="btn" href={href('options')}>{t('Zu den Kameras')}</a>}>
          {t('Vielleicht wurde sie in den Optionen gelöscht.')}
        </Empty>
      </div>
    )
  }
  const room = rooms.find((r) => r.id === camera?.room_id)
  const firstDay = photos?.length ? isoDay(photos[photos.length - 1].ts) : null

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{camera?.name || t('Kamera')}</h1>
          {camera ? (
            <p>
              {room ? `${room.name} · ` : ''}
              {camera.only_light
                ? t('Fotos täglich um {times} Uhr, nur bei Licht', { times: camera.times.join(', ') })
                : t('Fotos täglich um {times} Uhr', { times: camera.times.join(', ') })}
              {' · '}{camera.photos === 1 ? t('{n} Foto', { n: camera.photos }) : t('{n} Fotos', { n: camera.photos })} ({formatBytes(camera.bytes)})
            </p>
          ) : <p>{t('Lade …')}</p>}
        </div>
        {camera ? (
          <div className="row page-tools">
            <a className="btn ghost" href={href('options?bereich=kameras')}>{t('Einstellungen')}</a>
            <button type="button" className="btn primary" disabled={busy || !data.ffmpeg} onClick={async () => {
              setBusy(true)
              await takePhoto(camera)
              setBusy(false)
            }}>
              <Icon name="camera" size={18} /> {busy ? t('Nimmt auf …') : t('Foto jetzt')}
            </button>
          </div>
        ) : null}
      </div>
      {camera?.last_error ? <div className="notice alert" role="alert">{t('Letzter Versuch: {error}', { error: t(camera.last_error) })}</div> : null}
      {camera && photos?.length > 1 ? <Timelapse camera={camera} firstDay={firstDay} /> : null}
      <h2 className="section">{t('Fotos')}</h2>
      {photos == null ? <p className="muted">{t('Lade Fotos …')}</p> : null}
      {photos && !photos.length ? (
        <div className="panel">
          <Empty title={t('Noch keine Fotos')}>{t('Die Kamera fotografiert zu den eingestellten Zeiten. Mit „Foto jetzt“ geht es sofort.')}</Empty>
        </div>
      ) : null}
      {months.map((group) => (
        <section className="photo-day" key={group.month} aria-label={group.month}>
          <h3 className="small muted">{group.month}</h3>
          <div className="photo-grid">
            {group.items.map(({ photo, index }) => (
              <button type="button" key={photo.id} onClick={() => setOpen(index)} aria-label={t('Foto vom {date} öffnen', { date: photoDate(photo.ts) })}>
                <img src={photoUrl(photo.id, true)} alt="" loading="lazy" />
                <span>{thumbLabel(photo.ts)}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
      {more ? <button type="button" className="btn" onClick={loadMore}>{t('Ältere Fotos laden')}</button> : null}
      {open != null && photos ? (
        <Lightbox photos={photos} index={open} onIndex={setOpen} onClose={() => setOpen(null)}
          onDeleted={(photoId) => {
            const next = photos.filter((p) => p.id !== photoId)
            setPhotos(next)
            setOpen(next.length ? Math.min(open, next.length - 1) : null)
          }} />
      ) : null}
    </>
  )
}

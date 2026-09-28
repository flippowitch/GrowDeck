// Options → Datensicherung: nightly copies of the database, by hand, download, upload, restore.
import { useEffect, useState } from 'react'
import { api, toast, useStore } from '../store.js'
import { dateTime } from '../format.js'
import { formatBytes } from '../cameras.js'
import { t } from '../i18n.js'
import Icon from './Icon.jsx'
import { Field, Modal, NumberInput, Toggle } from './ui.jsx'

function Restarting() {
  const [text, setText] = useState(() => t('GrowDeck startet neu …'))
  useEffect(() => {
    let wentDown = false
    const started = Date.now()
    const id = setInterval(async () => {
      try {
        const res = await fetch('/api/health', { cache: 'no-store' })
        if (res.ok && (wentDown || Date.now() - started > 8000)) {
          clearInterval(id)
          setText(t('GrowDeck läuft wieder, die Seite lädt neu …'))
          window.location.reload()
        }
      } catch {
        wentDown = true
      }
      if (Date.now() - started > 120000) setText(t('GrowDeck braucht länger als gewohnt. Läuft der Container? Lade die Seite sonst später neu.'))
    }, 2000)
    return () => clearInterval(id)
  }, [])
  return (
    <Modal title={t('Wiederherstellen')} onClose={() => {}}>
      <p style={{ margin: 0 }} aria-live="polite">{text}</p>
    </Modal>
  )
}

export default function BackupPanel() {
  const running = useStore((s) => s.backupRunning)
  const [data, setData] = useState(null)
  const [draft, setDraft] = useState(null)
  const [busy, setBusy] = useState('')
  const [restore, setRestore] = useState(null)
  const [remove, setRemove] = useState(null)
  const [restarting, setRestarting] = useState(false)

  const load = async () => {
    try {
      const d = await api('/backups', { quiet: true })
      setData(d)
      setDraft((current) => current || { enabled: d.enabled, time: d.time, keep: d.keep })
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    load()
  }, [running])

  const run = async (key, fn) => {
    setBusy(key)
    try {
      await fn()
    } catch {
      /* toast shown */
    } finally {
      setBusy('')
    }
  }
  const saveSettings = () => run('settings', async () => {
    setData(await api('/backups/settings', { method: 'PUT', body: draft }))
    toast(t('Einstellungen der Datensicherung gespeichert.'))
  })
  const backupNow = () => run('now', async () => {
    const d = await api('/backups', { method: 'POST' })
    setData(d)
    toast(t('Sicherung erstellt ({size}).', { size: formatBytes(d.item.size) }))
  })
  const upload = (file) => run('upload', async () => {
    const res = await fetch('/api/backups/upload', {
      method: 'POST', body: file, credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' },
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast(body.detail ? t(String(body.detail)) : t('Hochladen fehlgeschlagen ({status}).', { status: res.status }), 'alert')
      return
    }
    setData(body)
    toast(t('Sicherung hochgeladen und geprüft. Zum Übernehmen „Wiederherstellen“ wählen.'))
  })
  const doRestore = () => run('restore', async () => {
    await api(`/backups/${encodeURIComponent(restore.name)}/restore`, { method: 'POST' })
    setRestore(null)
    setRestarting(true)
  })
  const doRemove = () => run('remove', async () => {
    setData(await api(`/backups/${encodeURIComponent(remove.name)}`, { method: 'DELETE' }))
    setRemove(null)
    toast(t('Sicherung gelöscht.'))
  })

  if (!data || !draft) return <div className="panel panel-pad muted">{t('Lade Datensicherung …')}</div>
  const changed = draft.enabled !== data.enabled || draft.time !== data.time || draft.keep !== data.keep
  const next = data.enabled && data.next ? dateTime(data.next) : null
  let lastLine
  if (data.last) {
    const last = dateTime(data.last)
    lastLine = next ? t('Letzte Sicherung {last}, nächste {next}.', { last, next }) : t('Letzte Sicherung {last}.', { last })
  } else {
    lastLine = next ? t('Noch keine Sicherung, nächste {next}.', { next }) : t('Noch keine Sicherung.')
  }

  return (
    <div className="panel panel-pad stack" id="datensicherung">
      <div className="row" style={{ gap: 12 }}>
        <Toggle checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} label={t('Jede Nacht sichern')} />
        <span>{t('Jede Nacht automatisch sichern')}</span>
      </div>
      <div className="form-grid">
        <Field label={t('Uhrzeit')}>
          <input className="input" type="time" value={draft.time} disabled={!draft.enabled} onChange={(e) => setDraft({ ...draft, time: e.target.value })} />
        </Field>
        <Field label={t('Anzahl aufheben')} hint={t('Ältere automatische Sicherungen werden gelöscht, von Hand erstellte bleiben')}>
          <NumberInput min={1} max={60} value={draft.keep} disabled={!draft.enabled} onChange={(keep) => setDraft({ ...draft, keep: keep ?? 7 })} />
        </Field>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        {lastLine}
        {' '}{t('Datenbank {db}, alle Sicherungen zusammen {total}.', { db: formatBytes(data.database_bytes), total: formatBytes(data.total_bytes) })}
        {' '}{t('Sie liegen im Datenordner unter {backups}; Fotos liegen daneben unter {photos} und gehören nicht dazu.', { backups: <code>backups/</code>, photos: <code>photos/</code> })}
      </p>
      {data.last_error ? <div className="notice alert small">{t('Letzter Fehler: {error}', { error: t(data.last_error) })}</div> : null}
      <div className="row">
        {changed ? <button type="button" className="btn" disabled={!!busy} onClick={saveSettings}>{t('Speichern')}</button> : null}
        <button type="button" className="btn" disabled={!!busy || running} onClick={backupNow}>
          {busy === 'now' || running ? t('Sichere …') : t('Jetzt sichern')}
        </button>
        <label className={`btn ghost file-btn${busy ? ' is-disabled' : ''}`}>
          <input type="file" className="visually-hidden" accept=".gz,.sqlite3,.sqlite,.db" disabled={!!busy} onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) upload(file)
          }} />
          <Icon name="plus" size={16} /> {busy === 'upload' ? t('Lade hoch …') : t('Sicherung hochladen')}
        </label>
      </div>
      {data.items.length ? (
        <div className="backup-list">
          {data.items.map((item) => (
            <div className="list-row" key={item.name}>
              <div style={{ minWidth: 0 }}>
                <div className="title">{dateTime(item.created)}</div>
                <div className="meta">{t(item.kind_label)} · {formatBytes(item.size)}</div>
              </div>
              <div className="row" style={{ gap: 4 }}>
                <a className="btn small ghost" href={`/api/backups/${encodeURIComponent(item.name)}`} download={item.name}>{t('Herunterladen')}</a>
                <button type="button" className="btn small" disabled={!!busy} onClick={() => setRestore(item)}>{t('Wiederherstellen')}</button>
                <button type="button" className="icon-btn" aria-label={t('Sicherung vom {date} löschen', { date: dateTime(item.created) })} onClick={() => setRemove(item)}>
                  <Icon name="trash" />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {restore ? (
        <Modal title={t('Sicherung wiederherstellen?')} onClose={() => setRestore(null)}
          actions={<>
            <button type="button" className="btn ghost" onClick={() => setRestore(null)}>{t('Abbrechen')}</button>
            <button type="button" className="btn danger" disabled={busy === 'restore'} onClick={doRestore}>
              {busy === 'restore' ? t('Bereite vor …') : t('Wiederherstellen')}
            </button>
          </>}>
          <p style={{ margin: 0 }}>
            {t('GrowDeck ersetzt alle Daten – Einstellungen, Räume, Regeln, Alarme, Growplan, Archiv und Verlauf – durch den Stand vom {date}. Der jetzige Stand wird vorher als Sicherung „vor Wiederherstellung“ aufgehoben.', { date: <b>{dateTime(restore.created)}</b> })}
          </p>
          <p className="muted small" style={{ margin: '10px 0 0' }}>
            {t('GrowDeck startet danach neu; Docker startet den Container automatisch wieder. Fotos bleiben unverändert.')}
          </p>
        </Modal>
      ) : null}
      {remove ? (
        <Modal title={t('Sicherung löschen?')} onClose={() => setRemove(null)}
          actions={<>
            <button type="button" className="btn ghost" onClick={() => setRemove(null)}>{t('Abbrechen')}</button>
            <button type="button" className="btn danger" disabled={busy === 'remove'} onClick={doRemove}>{t('Löschen')}</button>
          </>}>
          <p className="muted" style={{ margin: 0 }}>{t('Die Sicherung vom {date} wird von der NAS gelöscht.', { date: dateTime(remove.created) })}</p>
        </Modal>
      ) : null}
      {restarting ? <Restarting /> : null}
    </div>
  )
}

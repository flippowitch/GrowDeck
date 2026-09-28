import { useEffect, useState } from 'react'
import { api, loadState, logout, setState, toast, useStore } from '../store.js'
import { duration, STAGES, timeAgo, VENDORS } from '../format.js'
import Icon from '../components/Icon.jsx'
import { Field, Modal, NumberInput, Segmented } from '../components/ui.jsx'
import BackupPanel from '../components/BackupPanel.jsx'
import CameraSettings from '../components/CameraSettings.jsx'
import { dec, langSetting, LOCALE, setLangSetting, t } from '../i18n.js'

const STATE_TEXT = {
  connected: ['leaf', t('Verbunden')],
  connecting: ['amber', t('Verbinde …')],
  degraded: ['amber', t('Eingeschränkt')],
  disconnected: ['alert', t('Nicht verbunden')],
  error: ['alert', t('Fehler')],
  auth_failed: ['alert', t('Anmeldung fehlgeschlagen')],
  not_configured: ['', t('Nicht eingerichtet')],
  disabled: ['', t('Ausgeschaltet')],
  stopped: ['', t('Gestoppt')],
}

function StateChip({ state }) {
  const [tone, text] = STATE_TEXT[state] || ['', state || t('Unbekannt')]
  return <span className={`chip ${tone}`}>{text}</span>
}

const CHAT_TYPES = { private: t('Privat'), group: t('Gruppe'), supergroup: t('Gruppe'), channel: t('Kanal') }

// Telegram: a bot of your own (from @BotFather) writes to you or to a group.
function TelegramCard({ settings, onChanged }) {
  const tg = settings.telegram || {}
  const [editing, setEditing] = useState(false)
  const [token, setToken] = useState('')
  const [found, setFound] = useState(null)
  const [manual, setManual] = useState('')
  const [busy, setBusy] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const setup = editing || !tg.ready
  const typedToken = token.trim() || null

  const reset = () => {
    setEditing(false)
    setToken('')
    setFound(null)
    setManual('')
  }
  const search = async () => {
    setBusy('search')
    try {
      const result = await api('/settings/telegram/chats', { method: 'POST', body: { token: typedToken } })
      setFound(result)
      if (!result.chats.length) {
        toast(t('Noch keine Nachricht an @{bot} gefunden. Schreib dem Bot etwas und such noch einmal.', { bot: result.bot.username }), 'warn', 7000)
      }
    } catch {
      /* toast shown */
    } finally {
      setBusy('')
    }
  }
  const sendTest = async (quietly = false) => {
    try {
      await api('/settings/test-notification', { method: 'POST', body: { channel: 'telegram' }, quiet: true })
      toast(quietly ? t('Telegram ist verbunden, eine Testnachricht ist unterwegs.') : t('Testnachricht an Telegram gesendet.'))
    } catch (err) {
      toast(quietly ? t('Gespeichert, aber die Testnachricht kam nicht an: {error}', { error: err.message }) : err.message, 'alert', 8000)
    }
  }
  const connect = async (chatId, chatName = '') => {
    setBusy(`chat-${chatId}`)
    try {
      const updated = await api('/settings/telegram', { method: 'PUT', body: { token: typedToken, chat_id: chatId, chat_name: chatName } })
      onChanged(updated)
      reset()
      await sendTest(true)
    } catch {
      /* toast shown */
    } finally {
      setBusy('')
    }
  }
  const remove = async () => {
    try {
      onChanged(await api('/settings/telegram', { method: 'DELETE' }))
      reset()
      toast(t('Telegram ist getrennt.'))
    } catch {
      /* toast shown */
    }
  }

  return (
    <div className="panel panel-pad stack">
      <div className="spread">
        <h3 className="sub" style={{ margin: 0 }}>Telegram</h3>
        <StateChip state={tg.ready ? (tg.last_error ? 'error' : 'connected') : tg.configured ? 'connecting' : 'not_configured'} />
      </div>
      {tg.ready && !editing ? (
        <>
          <p className="small" style={{ margin: 0 }}>
            {tg.bot
              ? t('Bot {bot} schreibt an {chat}.', { bot: <b>@{tg.bot}</b>, chat: <b>{tg.chat_name || `Chat ${tg.chat_id}`}</b> })
              : t('Nachrichten gehen an {chat}.', { chat: <b>{tg.chat_name || `Chat ${tg.chat_id}`}</b> })}
            {tg.source === 'env' ? ` ${t('Der Bot-Token kommt aus der .env.')}` : ''}
          </p>
          {tg.last_error ? <div className="notice alert small">{t('Zuletzt fehlgeschlagen: {error}', { error: t(tg.last_error) })}</div> : null}
          <div className="row">
            <button type="button" className="btn" onClick={() => sendTest()}><Icon name="send" size={16} /> {t('Testnachricht senden')}</button>
            <button type="button" className="btn ghost" onClick={() => setEditing(true)}>{t('Ändern')}</button>
            {tg.source !== 'env' ? <button type="button" className="btn ghost" onClick={() => setConfirmRemove(true)}>{t('Trennen')}</button> : null}
          </div>
        </>
      ) : null}
      {setup ? (
        <>
          <ol className="tg-steps small">
            <li>{t('In Telegram {botfather} öffnen, {newbot} senden und einen Namen vergeben. BotFather antwortet mit dem Token.', { botfather: <b>@BotFather</b>, newbot: <code>/newbot</code> })}</li>
            <li>{t('Den Token unten einfügen und deinem neuen Bot eine Nachricht schicken, zum Beispiel {start}. Für eine Gruppe: Bot einladen und dort etwas schreiben.', { start: <code>/start</code> })}</li>
            <li>{t('„Chat suchen“ drücken und den Chat wählen. GrowDeck schickt gleich eine Testnachricht.')}</li>
          </ol>
          <Field label={t('Bot-Token')} hint={tg.configured ? t('Ein Token ist gespeichert (endet auf „{end}“). Leer lassen, um ihn zu behalten.', { end: tg.token_hint }) : undefined}>
            <input className="input" type="password" autoComplete="off" spellCheck={false} value={token}
              placeholder="123456789:AA…" onChange={(e) => setToken(e.target.value)} />
          </Field>
          <div className="row">
            <button type="button" className="btn primary" disabled={busy === 'search' || (!typedToken && !tg.configured)} onClick={search}>
              {busy === 'search' ? t('Suche …') : t('Chat suchen')}
            </button>
            {editing ? <button type="button" className="btn ghost" onClick={reset}>{t('Abbrechen')}</button> : null}
          </div>
          {found ? (
            <div className="tg-chats">
              <span className="small muted">{t('Chats, die @{bot} zuletzt geschrieben haben', { bot: found.bot.username })}</span>
              {found.chats.length ? found.chats.map((c) => (
                <div className="spread" key={c.id}>
                  <span className="small"><b>{c.name}</b> · {CHAT_TYPES[c.type] || c.type}</span>
                  <button type="button" className="btn small" disabled={!!busy} onClick={() => connect(c.id, c.name)}>
                    {tg.chat_id === c.id ? t('Erneut verbinden') : t('Diesen Chat nehmen')}
                  </button>
                </div>
              )) : <span className="small">{t('Noch keiner. Schreib dem Bot eine Nachricht und such noch einmal.')}</span>}
            </div>
          ) : null}
          <details className="small">
            <summary>{t('Chat-ID von Hand eintragen')}</summary>
            <div className="row" style={{ marginTop: 8 }}>
              <input className="input" style={{ maxWidth: 220 }} value={manual} placeholder={t('z. B. 123456789 oder -100…')}
                aria-label={t('Chat-ID')} onChange={(e) => setManual(e.target.value)} />
              <button type="button" className="btn small" disabled={!manual.trim() || (!typedToken && !tg.configured) || !!busy}
                onClick={() => connect(manual.trim())}>{t('Übernehmen')}</button>
            </div>
          </details>
        </>
      ) : null}
      {confirmRemove ? (
        <Modal title={t('Telegram trennen?')} onClose={() => setConfirmRemove(false)}
          actions={<>
            <button type="button" className="btn ghost" onClick={() => setConfirmRemove(false)}>{t('Abbrechen')}</button>
            <button type="button" className="btn danger" onClick={async () => { setConfirmRemove(false); await remove() }}>{t('Trennen')}</button>
          </>}>
          <p className="muted" style={{ margin: 0 }}>{t('GrowDeck vergisst Bot-Token und Chat und schickt keine Nachrichten mehr an Telegram. Den Bot selbst löschst du bei Bedarf bei @BotFather.')}</p>
        </Modal>
      ) : null}
    </div>
  )
}

// Which events go out, for Telegram and the web address alike.
function NotifyGroups({ settings, onChanged }) {
  const labels = settings.notify_group_labels || {}
  const chosen = new Set(settings.notify_groups || [])
  const toggle = async (key, on) => {
    const next = Object.keys(labels).filter((k) => (k === key ? on : chosen.has(k)))
    try {
      onChanged(await api('/settings', { method: 'PUT', body: { notify_groups: next } }))
    } catch {
      /* toast shown */
    }
  }
  const saveLanguage = async (language) => {
    try {
      onChanged(await api('/settings', { method: 'PUT', body: { language } }))
      toast(t('Sprache der Meldungen gespeichert.'))
    } catch {
      /* toast shown */
    }
  }
  return (
    <div className="panel panel-pad stack">
      <h3 className="sub" style={{ margin: 0 }}>{t('Was gemeldet wird')}</h3>
      <div className="stack" style={{ gap: 8 }}>
        {Object.entries(labels).map(([key, label]) => (
          <label className="check" key={key}>
            <input type="checkbox" checked={chosen.has(key)} onChange={(e) => toggle(key, e.target.checked)} />
            {t(label)}
          </label>
        ))}
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        {t('Gilt für Telegram und die Web-Adresse. Meldungen aus demselben Moment kommen gebündelt, dieselbe Meldung höchstens einmal in 15 Minuten.')}
      </p>
      <div className="field">
        <span>{t('Sprache der Meldungen')}</span>
        <Segmented label={t('Sprache der Meldungen')} value={settings.language || 'de'}
          options={[{ key: 'de', label: 'Deutsch' }, { key: 'en', label: 'English' }]}
          onChange={saveLanguage} />
        <small>{t('Für Telegram und die Web-Adresse.')}</small>
      </div>
    </div>
  )
}

function SpiderFarmerCard({ status }) {
  return (
    <div className="panel panel-pad stack">
      <div className="spread">
        <h3 className="sub" style={{ margin: 0 }}>Spider Farmer</h3>
        <StateChip state={status?.state} />
      </div>
      {status?.simulated ? <div className="notice frost">{t('Demo-Modus: Die Spider-Farmer-Geräte sind simuliert.')}</div> : null}
      <p className="muted small" style={{ margin: 0 }}>
        {t('Broker {broker}. {devices} Geräte erkannt, {messages} Nachrichten empfangen.', { broker: status?.broker || '–', devices: status?.devices ?? 0, messages: status?.messages_in ?? 0 })}
        {status?.error ? ` ${t('Letzter Fehler: {error}', { error: t(status.error) })}` : ''}
      </p>
      <details>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{t('So kommen deine Spider-Farmer-Geräte zu GrowDeck')}</summary>
        <div className="prose small" style={{ marginTop: 10 }}>
          <p>
            {t('Die GGS-Module verbinden sich mit {host} auf Port 8883. Der Proxy im Container {container} nimmt diese Verbindung auf der NAS an, gibt die Daten an GrowDeck weiter und hält die Verbindung zur Spider-Farmer-Cloud, damit die App weiter funktioniert.', { host: <code>sf.mqtt.spider-farmer.com</code>, container: <code>growdeck-spiderproxy</code> })}
          </p>
          <p>
            {t('Damit die Geräte die NAS erreichen, muss {host} im Heimnetz auf die IP-Adresse der NAS zeigen. Am einfachsten mit dem mitgelieferten DNS-Dienst oder einer DNS-Umschreibung in AdGuard Home oder Pi-hole. Alternativ leitet ein Router mit NAT-Regeln Port 8883 auf die NAS um.', { host: <code>sf.mqtt.spider-farmer.com</code> })}
          </p>
          <p>
            {t('Danach die Module kurz vom Strom trennen. Sie erscheinen innerhalb einer Minute unter Geräte. Die ausführliche Anleitung für die UGREEN-NAS und die Fritz!Box steht in der README.')}
          </p>
        </div>
      </details>
    </div>
  )
}

const CLOUD_TEXT = {
  vivosun: {
    title: 'Vivosun',
    intro: t('Vivosun-Geräte sind nur über die Vivosun-Cloud erreichbar. GrowDeck meldet sich mit deinem Konto an, liest die Messwerte etwa jede Minute und schickt Befehle sofort über die Cloud.'),
    email: t('E-Mail des Vivosun-Kontos'),
    remove: t('Vivosun-Konto trennen? Die Vivosun-Geräte verschwinden aus GrowDeck.'),
    connecting: t('Vivosun wird verbunden. Die Geräte erscheinen gleich.'),
  },
  acinfinity: {
    title: 'AC Infinity',
    intro: t('GrowDeck liest die WLAN-Controller (69 WiFi, 69 Pro, 69 Pro+, AI+, Outlet AI und AI+) über die AC-Infinity-Cloud, standardmäßig alle 10 Sekunden, und schickt Befehle sofort. Reine Bluetooth-Controller wie der Controller 67 senden keine Daten in die Cloud und erscheinen deshalb nicht.'),
    email: t('E-Mail des AC-Infinity-Kontos'),
    remove: t('AC-Infinity-Konto trennen? Die Controller verschwinden aus GrowDeck.'),
    connecting: t('AC Infinity wird verbunden. Die Controller erscheinen gleich.'),
  },
}

function CloudCard({ vendor, status, onChanged }) {
  const text = CLOUD_TEXT[vendor]
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const configured = status && status.state !== 'not_configured'
  const connect = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      await api(`/integrations/${vendor}`, { method: 'PUT', body: { email, password } })
      setPassword('')
      toast(text.connecting)
      onChanged()
    } catch {
      /* toast shown */
    } finally {
      setBusy(false)
    }
  }
  const disconnect = async () => {
    if (!window.confirm(text.remove)) return
    await api(`/integrations/${vendor}`, { method: 'DELETE' }).catch(() => {})
    onChanged()
  }
  const reconnect = async () => {
    await api(`/integrations/${vendor}/reconnect`, { method: 'POST' }).catch(() => {})
    toast(t('Verbindung wird neu aufgebaut.'))
    onChanged()
  }
  return (
    <div className="panel panel-pad stack">
      <div className="spread">
        <h3 className="sub" style={{ margin: 0 }}>{text.title}</h3>
        <StateChip state={status?.state} />
      </div>
      {status?.simulated ? <div className="notice frost">{t('Demo-Modus: Die {vendor}-Geräte sind simuliert.', { vendor: text.title })}</div> : null}
      {status?.error ? <div className="notice alert">{t(status.error)}</div> : null}
      {configured && !status?.simulated ? (
        <p className="muted small" style={{ margin: 0 }}>
          {status.credentials_source === 'env'
            ? t('Angemeldet als {email} (aus der Container-Konfiguration).', { email: status.email || '–' })
            : t('Angemeldet als {email}.', { email: status.email || '–' })}
          {' '}{t('{n} Geräte.', { n: status.devices ?? 0 })}
          {status.last_sync ? ` ${t('Letzter Abgleich {ago}.', { ago: timeAgo(status.last_sync) })}` : ''}
        </p>
      ) : null}
      <p className="muted small" style={{ margin: 0 }}>{text.intro}</p>
      {!status?.simulated ? (
        <form className="stack" onSubmit={connect}>
          <div className="form-grid">
            <Field label={text.email}>
              <input className="input" type="email" autoComplete="off" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label={t('Passwort')}>
              <input className="input" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
          </div>
          <div className="row">
            <button className="btn primary" type="submit" disabled={busy}>{configured ? t('Konto wechseln') : t('Konto verbinden')}</button>
            {configured ? <button className="btn" type="button" onClick={reconnect}>{t('Neu verbinden')}</button> : null}
            {configured && status.credentials_source === 'app' ? <button className="btn danger" type="button" onClick={disconnect}>{t('Trennen')}</button> : null}
          </div>
          <p className="muted small" style={{ margin: 0 }}>{t('Die Zugangsdaten werden unverschlüsselt in der Datenbank im Datenordner gespeichert.')}</p>
        </form>
      ) : null}
    </div>
  )
}

function RoomEditor({ room, devices, onClose }) {
  const [draft, setDraft] = useState({ ...room })
  const hasPlan = useStore((s) => !!room.id && s.growplans.some((p) => p.room_id === room.id))
  const [members, setMembers] = useState(() => new Set(Object.values(devices).filter((d) => room.id && d.info?.room_id === room.id).map((d) => d.id)))
  const toggleMember = (id) => {
    const next = new Set(members)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setMembers(next)
  }
  const climateDevices = Object.values(devices).filter((d) => d.sensors.some((s) => s.kind === 'temp') && d.sensors.some((s) => s.kind === 'humi'))
  const selected = devices[draft.climate_device_id]
  const groups = selected ? [...new Set(selected.sensors.filter((s) => s.kind === 'temp').map((s) => s.group))] : []
  const save = async () => {
    const body = { ...draft, climate_device_id: draft.climate_device_id || null, climate_group: draft.climate_group || null }
    delete body.id
    try {
      const saved = room.id ? await api(`/rooms/${room.id}`, { method: 'PUT', body }) : await api('/rooms', { method: 'POST', body })
      const roomId = room.id || saved?.id
      if (roomId) await api(`/rooms/${roomId}/devices`, { method: 'POST', body: { device_ids: [...members] } })
      await loadState()
      onClose()
    } catch {
      /* toast shown */
    }
  }
  return (
    <Modal title={room.id ? t('Raum bearbeiten') : t('Neuer Raum')} onClose={onClose}
      actions={<>
        <button className="btn ghost" onClick={onClose}>{t('Abbrechen')}</button>
        <button className="btn primary" onClick={save}>{t('Raum speichern')}</button>
      </>}>
      <div className="stack">
        <Field label={t('Name')}><input className="input" maxLength={60} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={t('Zum Beispiel: Zelt 120')} /></Field>
        <Field label={t('Phase')} hint={hasPlan
          ? t('Dieses Zelt hat einen Growplan: Phase, Woche und VPD-Zielbereich in der Übersicht kommen aus dem Plan.')
          : t('Bestimmt den VPD-Zielbereich in der Übersicht, solange das Zelt keinen Growplan hat')}>
          <select className="input" value={draft.stage} onChange={(e) => setDraft({ ...draft, stage: e.target.value })}>
            {Object.entries(STAGES).map(([key, s]) => <option key={key} value={key}>{s.label}</option>)}
          </select>
        </Field>
        <div className="form-grid">
          <Field label={t('Licht an (Tag beginnt)')}><input className="input" type="time" value={draft.day_start} onChange={(e) => setDraft({ ...draft, day_start: e.target.value })} /></Field>
          <Field label={t('Licht aus (Tag endet)')}><input className="input" type="time" value={draft.day_end} onChange={(e) => setDraft({ ...draft, day_end: e.target.value })} /></Field>
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          {t('Tag und Nacht nutzt GrowDeck für die Anzeige und für Nachtwerte in Regeln. Die Lichtzeiten der Lampen selbst stellst du am Licht ein.')}
        </p>
        <div>
          <span className="small muted" style={{ display: 'block', marginBottom: 6 }}>
            {t('Geräte in diesem Raum, auch von verschiedenen Herstellern')}
          </span>
          <div className="member-list">
            {['spiderfarmer', 'vivosun', 'acinfinity'].map((vendor) => {
              const list = Object.values(devices).filter((d) => d.vendor === vendor).sort((a, b) => a.name.localeCompare(b.name, LOCALE))
              if (!list.length) return null
              return (
                <fieldset key={vendor}>
                  <legend>{VENDORS[vendor]}</legend>
                  {list.map((d) => {
                    const elsewhere = d.info?.room_id && d.info.room_id !== room.id
                    return (
                      <label className="check" key={d.id}>
                        <input type="checkbox" checked={members.has(d.id)} onChange={() => toggleMember(d.id)} />
                        {d.name}{elsewhere && !members.has(d.id) ? <span className="muted small"> {t('(in anderem Raum)')}</span> : null}
                      </label>
                    )
                  })}
                </fieldset>
              )
            })}
          </div>
        </div>
        <Field label={t('Klima aus diesem Gerät')}>
          <select className="input" value={draft.climate_device_id || ''} onChange={(e) => setDraft({ ...draft, climate_device_id: e.target.value, climate_group: '' })}>
            <option value="">{t('Automatisch wählen')}</option>
            {climateDevices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
        {groups.length > 1 ? (
          <Field label={t('Messstelle')}>
            <select className="input" value={draft.climate_group || ''} onChange={(e) => setDraft({ ...draft, climate_group: e.target.value })}>
              <option value="">{t('Hauptsensor')}</option>
              {groups.map((g) => <option key={g} value={g}>{t(g)}</option>)}
            </select>
          </Field>
        ) : null}
      </div>
    </Modal>
  )
}

function applyTheme(theme) {
  try {
    if (theme === 'system') {
      localStorage.removeItem('gd-theme')
      delete document.documentElement.dataset.theme
    } else {
      localStorage.setItem('gd-theme', theme)
      document.documentElement.dataset.theme = theme
    }
  } catch {
    /* ignore */
  }
}

export default function Options({ query }) {
  const integrations = useStore((s) => s.integrations)
  const rooms = useStore((s) => s.rooms)
  const devices = useStore((s) => s.devices)
  const settings = useStore((s) => s.settings)
  const [draft, setDraft] = useState(settings)
  const [system, setSystem] = useState(null)
  const [editingRoom, setEditingRoom] = useState(null)
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('gd-theme') || 'system'
    } catch {
      return 'system'
    }
  })

  const section = query?.get('bereich')
  useEffect(() => {
    if (!section) return undefined
    const id = setTimeout(() => document.getElementById(`bereich-${section}`)?.scrollIntoView({ block: 'start' }), 300)
    return () => clearTimeout(id)
  }, [section])

  const refresh = async () => {
    try {
      const [integrationData, systemData, settingsData] = await Promise.all([
        api('/integrations', { quiet: true }), api('/system', { quiet: true }), api('/settings', { quiet: true }),
      ])
      setState({ integrations: integrationData, settings: settingsData })
      setDraft(settingsData)
      setSystem(systemData)
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    refresh()
    const id = setInterval(async () => {
      try {
        setState({ integrations: await api('/integrations', { quiet: true }) })
      } catch {
        /* ignore */
      }
    }, 5000)
    return () => clearInterval(id)
  }, [])

  const saveSettings = async (keys, message = t('Gespeichert.')) => {
    const body = Object.fromEntries(keys.map((k) => [k, draft[k]]))
    try {
      const updated = await api('/settings', { method: 'PUT', body })
      setState({ settings: updated })
      setDraft(updated)
      toast(message)
    } catch {
      /* toast shown */
    }
  }
  // keeps what the user is typing elsewhere on the page
  const applySettings = (updated) => {
    setState({ settings: updated })
    setDraft((d) => ({ ...d, notify_groups: updated.notify_groups, telegram: updated.telegram }))
  }
  const testNotification = async () => {
    await saveSettings(['notify_webhook', 'notify_format'], t('Adresse gespeichert.'))
    try {
      await api('/settings/test-notification', { method: 'POST', body: { channel: 'webhook' } })
      toast(t('Testnachricht gesendet.'))
    } catch {
      /* toast shown */
    }
  }
  const removeRoom = async (room) => {
    if (!window.confirm(t('Raum „{name}“ löschen? Die Geräte bleiben erhalten.', { name: room.name }))) return
    await api(`/rooms/${room.id}`, { method: 'DELETE' }).catch(() => {})
    await loadState()
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('Optionen')}</h1>
          <p>{t('Verbindungen zu Spider Farmer, Vivosun und AC Infinity, Räume, Benachrichtigungen und Datenhaltung.')}</p>
        </div>
      </div>

      <h2 className="section" style={{ marginTop: 0 }}>{t('Verbindungen')}</h2>
      <div className="grid-2">
        <SpiderFarmerCard status={integrations.spiderfarmer} />
        <CloudCard vendor="vivosun" status={integrations.vivosun} onChanged={refresh} />
        <CloudCard vendor="acinfinity" status={integrations.acinfinity} onChanged={refresh} />
      </div>

      <div className="spread">
        <h2 className="section">{t('Räume')}</h2>
        <button className="btn small" onClick={() => setEditingRoom({ name: '', sort: rooms.length, stage: 'veg', day_start: '06:00', day_end: '00:00', climate_device_id: '', climate_group: '' })}>
          <Icon name="plus" size={17} /> {t('Raum anlegen')}
        </button>
      </div>
      <div className="panel">
        {!rooms.length ? <p className="muted" style={{ padding: '14px 18px', margin: 0 }}>{t('Noch keine Räume. Ein Raum fasst die Geräte eines Zelts zusammen.')}</p> : null}
        {rooms.map((room) => (
          <div className="list-row" key={room.id}>
            <div>
              <div className="title">{room.name}</div>
              <div className="meta">
                {t('{stage}, Licht {start}–{end}, {n} Geräte', {
                  stage: (STAGES[room.stage] || STAGES.veg).label, start: room.day_start, end: room.day_end,
                  n: Object.values(devices).filter((d) => d.info?.room_id === room.id).length,
                })}
              </div>
            </div>
            <div className="row" style={{ gap: 4 }}>
              <button className="icon-btn" aria-label={t('Bearbeiten')} onClick={() => setEditingRoom(room)}><Icon name="edit" /></button>
              <button className="icon-btn" aria-label={t('Löschen')} onClick={() => removeRoom(room)}><Icon name="trash" /></button>
            </div>
          </div>
        ))}
      </div>

      <h2 className="section">{t('Tag und Nacht ohne Raum')}</h2>
      <div className="panel panel-pad stack">
        <p className="muted small" style={{ margin: 0 }}>{t('Gilt für Regeln mit Nachtwert, deren Sensor keinem Raum zugeordnet ist.')}</p>
        <div className="form-grid">
          <Field label={t('Tag beginnt')}><input className="input" type="time" value={draft.day_start || '06:00'} onChange={(e) => setDraft({ ...draft, day_start: e.target.value })} /></Field>
          <Field label={t('Tag endet')}><input className="input" type="time" value={draft.day_end || '00:00'} onChange={(e) => setDraft({ ...draft, day_end: e.target.value })} /></Field>
        </div>
        <div><button className="btn" onClick={() => saveSettings(['day_start', 'day_end'])}>{t('Zeiten speichern')}</button></div>
      </div>

      <h2 className="section">{t('Benachrichtigungen')}</h2>
      <NotifyGroups settings={settings} onChanged={applySettings} />
      <div className="grid-2" style={{ marginTop: 14 }}>
      <TelegramCard settings={settings} onChanged={applySettings} />
      <div className="panel panel-pad stack">
        <h3 className="sub" style={{ margin: 0 }}>{t('Web-Adresse')}</h3>
        <p className="muted small" style={{ margin: 0 }}>
          {t('Mit „Text“ funktioniert zum Beispiel ntfy ({example}), mit „JSON“ ein Home-Assistant-Webhook oder Node-RED.', { example: <code>{`https://ntfy.sh/${t('dein-thema')}`}</code> })}
        </p>
        <Field label={t('Adresse')}>
          <input className="input" type="url" placeholder={`https://ntfy.sh/${t('mein-growzelt')}`} value={draft.notify_webhook || ''}
            onChange={(e) => setDraft({ ...draft, notify_webhook: e.target.value })} />
        </Field>
        <Field label={t('Format')}>
          <Segmented label={t('Format')} value={draft.notify_format || 'json'}
            options={[{ key: 'json', label: 'JSON' }, { key: 'text', label: t('Text') }]}
            onChange={(notify_format) => setDraft({ ...draft, notify_format })} />
        </Field>
        <div className="row">
          <button className="btn" onClick={() => saveSettings(['notify_webhook', 'notify_format'])}>{t('Speichern')}</button>
          <button className="btn" onClick={testNotification} disabled={!draft.notify_webhook}>{t('Testnachricht senden')}</button>
        </div>
      </div>
      </div>

      <h2 className="section">{t('Daten')}</h2>
      <div className="panel panel-pad stack">
        <div className="form-grid">
          <Field label={t('Verlauf aufbewahren (Tage)')}>
            <NumberInput min={1} max={3650} value={draft.retention_days} onChange={(retention_days) => setDraft({ ...draft, retention_days })} />
          </Field>
          <Field label={t('Vivosun abfragen alle (Sekunden)')} hint={t('Mindestens 30, gilt nach „Neu verbinden“')}>
            <NumberInput min={30} max={900} value={draft.vivosun_poll_seconds} onChange={(vivosun_poll_seconds) => setDraft({ ...draft, vivosun_poll_seconds })} />
          </Field>
          <Field label={t('AC Infinity abfragen alle (Sekunden)')} hint={t('Mindestens 5, gilt nach „Neu verbinden“')}>
            <NumberInput min={5} max={600} value={draft.acinfinity_poll_seconds} onChange={(acinfinity_poll_seconds) => setDraft({ ...draft, acinfinity_poll_seconds })} />
          </Field>
        </div>
        <p className="muted small" style={{ margin: 0 }}>{t('Messwerte werden alle {n} Sekunden gespeichert.', { n: settings.history_interval || 60 })}</p>
        <div><button className="btn" onClick={() => saveSettings(['retention_days', 'vivosun_poll_seconds', 'acinfinity_poll_seconds'])}>{t('Speichern')}</button></div>
      </div>

      <h2 className="section" id="bereich-sicherung">{t('Datensicherung')}</h2>
      <BackupPanel />

      <h2 className="section" id="bereich-kameras">{t('Kameras')}</h2>
      <CameraSettings />

      <h2 className="section">{t('Darstellung')}</h2>
      <div className="panel panel-pad stack">
        <div className="field">
          <span>{t('Farbschema')}</span>
          <Segmented label={t('Farbschema')} value={theme}
            options={[{ key: 'system', label: t('Wie das System') }, { key: 'light', label: t('Hell') }, { key: 'dark', label: t('Dunkel') }]}
            onChange={(v) => {
              setTheme(v)
              applyTheme(v)
            }} />
        </div>
        <div className="field">
          <span>Sprache · Language</span>
          <Segmented label="Sprache · Language" value={langSetting()}
            options={[{ key: 'auto', label: t('Wie der Browser') }, { key: 'de', label: 'Deutsch' }, { key: 'en', label: 'English' }]}
            onChange={(value) => value !== langSetting() && setLangSetting(value)} />
          <small>{t('Die Sprache gilt für diesen Browser.')}</small>
        </div>
      </div>

      <h2 className="section">{t('System')}</h2>
      <div className="panel table-wrap">
        <table className="data">
          <tbody>
            <tr><th scope="row" style={{ width: 220 }}>{t('Version')}</th><td>{system?.version || '–'}</td></tr>
            <tr><th scope="row">{t('Läuft seit')}</th><td>{system ? duration(system.uptime) : '–'}</td></tr>
            <tr><th scope="row">{t('Datenbank')}</th><td>{system?.db_size != null ? `${dec((system.db_size / 1048576).toFixed(1))} MB` : '–'}</td></tr>
            <tr><th scope="row">{t('Gespeicherte Messwerte seit Start')}</th><td>{system?.samples_written ?? '–'}</td></tr>
            <tr><th scope="row">{t('MQTT-Broker')}</th><td>{system?.mqtt || '–'}</td></tr>
            <tr><th scope="row">{t('Zeitzone')}</th><td>{system?.timezone || '–'}</td></tr>
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 16 }}>
        <button className="btn" onClick={logout}><Icon name="logout" size={18} /> {t('Abmelden')}</button>
      </div>

      {editingRoom ? <RoomEditor room={editingRoom} devices={devices} onClose={() => setEditingRoom(null)} /> : null}
    </>
  )
}

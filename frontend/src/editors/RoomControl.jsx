// Zeltsteuerung: one climate brain per tent that drives outputs of any vendor.
import { useEffect, useMemo, useState } from 'react'
import { api, toast, useStore } from '../store.js'
import { fmt, VENDORS } from '../format.js'
import Icon from '../components/Icon.jsx'
import { Field, Modal, NumberInput, Segmented } from '../components/ui.jsx'
import { LOCALE, t } from '../i18n.js'

export const ROLE_LABELS = {
  light: t('Licht'), exhaust: t('Abluft'), circulation: t('Umluft'), humidifier: t('Befeuchter'),
  dehumidifier: t('Entfeuchter'), heater: t('Heizung'), cooler: t('Kühlung'), co2: 'CO₂',
}
const ROLE_ICONS = {
  light: 'light', exhaust: 'exhaust_fan', circulation: 'circulation_fan', humidifier: 'humidifier',
  dehumidifier: 'dehumidifier', heater: 'heater', cooler: 'air_conditioner', co2: 'switch',
}
const ROLE_ORDER = ['light', 'exhaust', 'circulation', 'humidifier', 'dehumidifier', 'heater', 'cooler', 'co2']

function stateText(out, control) {
  if (out.role === 'light') return control?.on ? t('An') : t('Aus')
  const on = out.want?.on ?? out.on
  if (!on) return t('Aus')
  const level = out.want?.level ?? out.level
  if (level != null && control?.features?.includes('level')) {
    return control.level_unit === 'Stufe' ? t('Stufe {n}', { n: fmt(level, 0) }) : `${fmt(level, 0)} ${control.level_unit}` // i18n-ignore ('Stufe' is the server's unit key)
  }
  return t('An')
}

export function managedOutputs(roomControl, rooms) {
  const map = {}
  for (const [roomId, status] of Object.entries(roomControl || {})) {
    if (!status?.enabled) continue
    const room = rooms.find((r) => r.id === roomId)
    for (const out of status.outputs || []) {
      if (out.role !== 'light') map[`${out.device_id}|${out.control_id}`] = room?.name || roomId
    }
  }
  return map
}

export function RoomControlPanel({ room, status, devices, onEdit }) {
  if (!status) return null
  const tg = status.targets || {}
  const r = status.readings || {}
  const outputs = [...(status.outputs || [])].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role))
  const vendors = [...new Set(outputs.map((o) => o.vendor).filter(Boolean))]
  return (
    <div className="panel rc-panel">
      <div className="rc-head">
        <div className="rc-title">
          <h3>{t('Zeltsteuerung')}</h3>
          <span className={`chip ${status.enabled ? 'leaf' : ''}`}>{status.enabled ? t('Aktiv') : t('Aus')}</span>
          {vendors.length > 1 ? <span className="chip frost">{vendors.map((v) => VENDORS[v]).join(' + ')}</span> : null}
        </div>
        <button type="button" className="btn small" onClick={onEdit}><Icon name="settings" size={16} /> {t('Einstellen')}</button>
      </div>
      <p className="rc-summary">
        {status.day
          ? (status.day_by === 'light' ? t('Tag (nach dem Licht).') : t('Tag (nach Uhrzeit).'))
          : (status.day_by === 'light' ? t('Nacht (nach dem Licht).') : t('Nacht (nach Uhrzeit).'))}
        {status.plan_source ? ` ${t('Ziele aus dem Growplan ({stage}).', { stage: t(status.plan_source.stage_name) })}` : ''}
        {tg.temp == null ? ''
          : tg.vpd != null ? ` ${t('Ziel {temp} °C und VPD {vpd} kPa, bei der aktuellen Temperatur {low}–{high} % Luftfeuchte.', {
            temp: fmt(tg.temp, 1), vpd: fmt(tg.vpd, 2), low: fmt(tg.humi_low, 0), high: fmt(tg.humi_high, 0) })}`
            : tg.humi != null ? ` ${t('Ziel {temp} °C und {low}–{high} % Luftfeuchte.', {
              temp: fmt(tg.temp, 1), low: fmt(tg.humi_low, 0), high: fmt(tg.humi_high, 0) })}`
              : ` ${t('Ziel {temp} °C.', { temp: fmt(tg.temp, 1) })}`}
        {r.sources?.length ? (
          <span title={r.sources.join(', ')}>
            {' '}{t('Messwerte: {source}.', {
              source: r.sources.length > 1 ? t('Mittelwert aus {n} Geräten', { n: r.sources.length }) : r.sources[0] })}
          </span>
        ) : null}
      </p>
      {status.message ? <div className="notice" style={{ margin: '0 18px 14px' }}>{t(status.message)}</div> : null}
      {outputs.length ? (
        <div className="rc-outputs">
          {outputs.map((out) => {
            const control = devices[out.device_id]?.controls.find((c) => c.id === out.control_id)
            const on = out.role === 'light' ? control?.on : (out.want?.on ?? out.on)
            return (
              <div className="rc-out" key={`${out.device_id}|${out.control_id}`}>
                <span className={`ctl-icon ${on ? 'on' : ''} ${out.role === 'light' ? 'light' : out.role === 'heater' ? 'heater' : ''}`}>
                  <Icon name={ROLE_ICONS[out.role]} size={18} />
                </span>
                <div style={{ minWidth: 0 }}>
                  <div className="rc-role">
                    {ROLE_LABELS[out.role]}
                    <span className="rc-device">{t(out.label)}, {out.vendor ? out.device_name : t(out.device_name)}{out.vendor ? ` (${VENDORS[out.vendor]})` : ''}</span>
                  </div>
                  <div className={`rc-reason ${out.error ? 'warn' : ''}`}>{t(out.error || out.reason)}</div>
                </div>
                <span className={`chip ${on ? 'leaf' : ''}`}>{stateText(out, control)}</span>
              </div>
            )
          })}
        </div>
      ) : (
        <p className="muted small" style={{ margin: '0 18px 16px' }}>{t('Noch keine Ausgänge zugeordnet.')}</p>
      )}
    </div>
  )
}

function levelLimits(control) {
  if (!control?.features?.includes('level')) return null
  return { min: control.level_min, max: control.level_max, step: control.level_step || 1, unit: control.level_unit === 'Stufe' ? 'Stufe' : control.level_unit } // i18n-ignore (server unit key)
}

export function RoomControlEditor({ room, onClose }) {
  const devices = useStore((s) => s.devices)
  const [config, setConfig] = useState(null)
  const [growplan, setGrowplan] = useState(null)
  const [typeRoles, setTypeRoles] = useState({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api(`/rooms/${room.id}/control`, { quiet: true })
      .then((r) => {
        setConfig(r.config)
        setGrowplan(r.growplan || null)
        setTypeRoles(r.type_roles || {})
      })
      .catch((err) => setError(err.message))
  }, [room.id])

  const inRoom = useMemo(() => Object.values(devices).filter((d) => d.info?.room_id === room.id)
    .sort((a, b) => a.vendor.localeCompare(b.vendor) || a.name.localeCompare(b.name, LOCALE)), [devices, room.id])
  const others = useMemo(() => Object.values(devices).filter((d) => d.info?.room_id !== room.id && d.controls.length)
    .sort((a, b) => a.vendor.localeCompare(b.vendor) || a.name.localeCompare(b.name, LOCALE)), [devices, room.id])

  if (!config) {
    return (
      <Modal wide title={t('Zeltsteuerung {room}', { room: room.name })} onClose={onClose}>
        {error ? <div className="notice alert">{error}</div> : <p className="muted">{t('Lade Einstellungen …')}</p>}
      </Modal>
    )
  }

  const set = (patch) => setConfig({ ...config, ...patch })
  const setPart = (part, patch) => setConfig({ ...config, [part]: { ...config[part], ...patch } })
  const outputs = config.outputs || []
  const setOutput = (i, patch) => set({ outputs: outputs.map((o, j) => (j === i ? { ...o, ...patch } : o)) })
  const controlOf = (o) => devices[o.device_id]?.controls.find((c) => c.id === o.control_id)
  const used = new Set(outputs.map((o) => `${o.device_id}|${o.control_id}`))

  const suggest = () => {
    const next = [...outputs]
    for (const d of inRoom) {
      for (const c of d.controls) {
        const role = typeRoles[c.type]
        if (!role || used.has(`${d.id}|${c.id}`) || !c.features.length) continue
        if (['humidifier', 'dehumidifier', 'heater', 'cooler'].includes(role) && next.some((o) => o.role === role)) continue
        next.push({ device_id: d.id, control_id: c.id, role })
      }
    }
    if (next.length === outputs.length) toast(t('Keine weiteren passenden Ausgänge im Raum gefunden.'))
    set({ outputs: next })
  }

  const save = async () => {
    setSaving(true)
    try {
      // outputs chosen from other rooms join this tent
      const extra = outputs.map((o) => o.device_id).filter((id) => devices[id] && devices[id].info?.room_id !== room.id)
      if (extra.length) {
        await api(`/rooms/${room.id}/devices`, { method: 'POST', body: { device_ids: [...new Set([...inRoom.map((d) => d.id), ...extra])] } })
      }
      await api(`/rooms/${room.id}/control`, { method: 'PUT', body: config })
      toast(config.enabled ? t('Zeltsteuerung ist aktiv.') : t('Zeltsteuerung gespeichert (ausgeschaltet).'))
      onClose()
    } catch {
      /* toast shown */
    } finally {
      setSaving(false)
    }
  }

  const optionGroups = (
    <>
      {inRoom.length ? (
        inRoom.map((d) => (
          <optgroup key={d.id} label={`${d.name} (${VENDORS[d.vendor]})`}>
            {d.controls.map((c) => <option key={c.id} value={`${d.id}|${c.id}`}>{t(c.label)} ({d.name}, {VENDORS[d.vendor]})</option>)}
          </optgroup>
        ))
      ) : null}
      {others.length ? (
        others.map((d) => (
          <optgroup key={d.id} label={t('Anderer Raum: {device} ({vendor})', { device: d.name, vendor: VENDORS[d.vendor] })}>
            {d.controls.map((c) => <option key={c.id} value={`${d.id}|${c.id}`}>{t(c.label)} ({d.name}, {VENDORS[d.vendor]})</option>)}
          </optgroup>
        ))
      ) : null}
    </>
  )

  return (
    <Modal wide title={t('Zeltsteuerung {room}', { room: room.name })} onClose={onClose}
      actions={<>
        <button className="btn ghost" onClick={onClose}>{t('Abbrechen')}</button>
        <button className="btn primary" onClick={save} disabled={saving}>{saving ? t('Speichern …') : t('Speichern')}</button>
      </>}>
      <div className="stack">
        <p className="muted small" style={{ margin: 0 }}>
          {t('Die Zeltsteuerung lässt Geräte verschiedener Hersteller zusammenarbeiten: Sie liest das Klima im Zelt und schaltet jeden zugeordneten Ausgang passend, egal ob Spider Farmer, Vivosun oder AC Infinity. Befeuchter und Entfeuchter laufen nie gleichzeitig, und die Abluft wird gedrosselt, solange befeuchtet, geheizt oder CO₂ zugegeben wird.')}
        </p>
        <label className="check">
          <input type="checkbox" checked={!!config.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          {t('Zeltsteuerung aktiv')}
        </label>

        <div className="rc-options">
          <span>{t('Messwerte')}</span>
          <Segmented label={t('Messwerte')} value={config.sensor_mode}
            options={[{ key: 'source', label: t('Klimasensor des Raums') }, { key: 'average', label: t('Mittelwert aller Geräte') }]}
            onChange={(sensor_mode) => set({ sensor_mode })} />
          <span>{t('Tag und Nacht')}</span>
          <Segmented label={t('Tag und Nacht')} value={config.day_source}
            options={[{ key: 'schedule', label: t('Nach Uhrzeit des Raums') }, { key: 'light', label: t('Nach dem Licht') }]}
            onChange={(day_source) => set({ day_source })} />
          <span>{t('Feuchte regeln nach')}</span>
          <Segmented label={t('Feuchte regeln nach')} value={config.humidity_mode}
            options={[{ key: 'rh', label: t('Luftfeuchte') }, { key: 'vpd', label: 'VPD' }]}
            onChange={(humidity_mode) => set({ humidity_mode })} />
        </div>
        {config.day_source === 'light' && !outputs.some((o) => o.role === 'light') ? (
          <div className="notice">{t('Ordne unten mindestens ein Licht zu. Bis dahin gilt die Uhrzeit des Raums.')}</div>
        ) : null}

        <h3 className="sub">{t('Ziele')}</h3>
        <label className="check">
          <input type="checkbox" checked={!!config.plan_targets} disabled={!growplan && !config.plan_targets}
            onChange={(e) => set({ plan_targets: e.target.checked })} />
          {t('Ziele aus dem Growplan übernehmen')}
        </label>
        {config.plan_targets && growplan ? (
          <p className="muted small" style={{ margin: 0 }}>
            {config.humidity_mode === 'vpd'
              ? t('Diese Woche ({stage}): Temperatur {day} / {night} °C ± {tol}, VPD {vday} / {vnight} kPa ± {vtol} (Tag / Nacht).', {
                stage: t(growplan.stage_name), day: fmt(growplan.temp.day, 1), night: fmt(growplan.temp.night, 1),
                tol: fmt(growplan.temp.tolerance, 1), vday: fmt(growplan.vpd.day, 2), vnight: fmt(growplan.vpd.night, 2),
                vtol: fmt(growplan.vpd.tolerance, 2) })
              : t('Diese Woche ({stage}): Temperatur {day} / {night} °C ± {tol}, Luftfeuchte {hday} % ± {htol} (Tag / Nacht).', {
                stage: t(growplan.stage_name), day: fmt(growplan.temp.day, 1), night: fmt(growplan.temp.night, 1),
                tol: fmt(growplan.temp.tolerance, 1), hday: fmt(growplan.humi.day, 0), htol: fmt(growplan.humi.tolerance, 0) })}
            {' '}{t('Die Werte wechseln automatisch mit der Woche des Plans; ändern lassen sie sich im Growplan unter Klima.')}
          </p>
        ) : config.plan_targets ? (
          <div className="notice">{t('Dieses Zelt hat noch keinen Growplan. Bis es einen gibt, gelten die Werte unten.')}</div>
        ) : !growplan ? (
          <p className="muted small" style={{ margin: 0 }}>{t('Mit einem Growplan für dieses Zelt kann die Zeltsteuerung dessen Zielwerte Woche für Woche übernehmen.')}</p>
        ) : null}
        {config.plan_targets && growplan ? null : (<>
        <div className="form-grid">
          <Field label={t('Temperatur Tag (°C)')}><NumberInput step={0.5} value={config.temp.day} onChange={(day) => setPart('temp', { day })} /></Field>
          <Field label={t('Temperatur Nacht (°C)')}><NumberInput step={0.5} value={config.temp.night} onChange={(night) => setPart('temp', { night })} /></Field>
          <Field label={t('Toleranz (°C)')}><NumberInput step={0.1} min={0.2} value={config.temp.tolerance} onChange={(tolerance) => setPart('temp', { tolerance })} /></Field>
        </div>
        {config.humidity_mode === 'vpd' ? (
          <div className="form-grid">
            <Field label={t('VPD Tag (kPa)')}><NumberInput step={0.05} value={config.vpd.day} onChange={(day) => setPart('vpd', { day })} /></Field>
            <Field label={t('VPD Nacht (kPa)')}><NumberInput step={0.05} value={config.vpd.night} onChange={(night) => setPart('vpd', { night })} /></Field>
            <Field label={t('Toleranz (kPa)')}><NumberInput step={0.05} min={0.02} value={config.vpd.tolerance} onChange={(tolerance) => setPart('vpd', { tolerance })} /></Field>
          </div>
        ) : (
          <div className="form-grid">
            <Field label={t('Luftfeuchte Tag (%)')}><NumberInput value={config.humi.day} onChange={(day) => setPart('humi', { day })} /></Field>
            <Field label={t('Luftfeuchte Nacht (%)')}><NumberInput value={config.humi.night} onChange={(night) => setPart('humi', { night })} /></Field>
            <Field label={t('Toleranz (%)')}><NumberInput min={1} value={config.humi.tolerance} onChange={(tolerance) => setPart('humi', { tolerance })} /></Field>
          </div>
        )}
        </>)}
        <label className="check">
          <input type="checkbox" checked={!!config.co2.enabled} onChange={(e) => setPart('co2', { enabled: e.target.checked })} />
          {t('CO₂ tagsüber regeln')}
        </label>
        {config.co2.enabled ? (
          <div className="form-grid">
            <Field label={t('CO₂-Ziel (ppm)')}><NumberInput step={50} value={config.co2.day} onChange={(day) => setPart('co2', { day })} /></Field>
            <Field label={t('Toleranz (ppm)')}><NumberInput step={10} value={config.co2.tolerance} onChange={(tolerance) => setPart('co2', { tolerance })} /></Field>
          </div>
        ) : null}

        <div className="spread">
          <h3 className="sub" style={{ margin: 0 }}>{t('Ausgänge')}</h3>
          <div className="row">
            <button type="button" className="btn small" onClick={suggest}>{t('Vorschlag aus dem Raum')}</button>
            <button type="button" className="btn small" onClick={() => set({ outputs: [...outputs, { device_id: '', control_id: '', role: 'exhaust' }] })}>
              <Icon name="plus" size={16} /> {t('Ausgang')}
            </button>
          </div>
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          {t('Du kannst Ausgänge aller Hersteller mischen. Wählst du einen Ausgang aus einem anderen Raum, zieht das Gerät beim Speichern in dieses Zelt. Regeln schalten Ausgänge der Zeltsteuerung nicht mehr, damit sich beide nicht abwechseln.')}
        </p>
        {outputs.map((o, i) => {
          const control = controlOf(o)
          const limits = levelLimits(control)
          return (
            <div className="rc-edit-row" key={i}>
              <select className="input" value={o.role} aria-label={t('Aufgabe')} onChange={(e) => setOutput(i, { role: e.target.value })}>
                {ROLE_ORDER.map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
              </select>
              <select className="input" value={o.device_id ? `${o.device_id}|${o.control_id}` : ''} aria-label={t('Ausgang')}
                onChange={(e) => {
                  const [device_id, control_id] = e.target.value.split('|')
                  setOutput(i, { device_id: device_id || '', control_id: control_id || '', min_level: undefined, max_level: undefined, day_level: undefined, night_level: undefined })
                }}>
                <option value="">{t('Ausgang wählen')}</option>
                {optionGroups}
              </select>
              {limits && o.role === 'exhaust' ? (
                <div className="row small">
                  <span className="muted">min</span>
                  <NumberInput className="input narrow" min={limits.min} max={limits.max} step={limits.step} value={o.min_level ?? limits.min}
                    onChange={(min_level) => setOutput(i, { min_level })} style={{ width: 76 }} />
                  <span className="muted">max</span>
                  <NumberInput className="input narrow" min={limits.min} max={limits.max} step={limits.step} value={o.max_level ?? limits.max}
                    onChange={(max_level) => setOutput(i, { max_level })} style={{ width: 76 }} />
                </div>
              ) : limits && o.role === 'circulation' ? (
                <div className="row small">
                  <span className="muted">{t('Tag')}</span>
                  <NumberInput className="input narrow" min={limits.min} max={limits.max} step={limits.step} value={o.day_level ?? limits.max}
                    onChange={(day_level) => setOutput(i, { day_level })} style={{ width: 76 }} />
                  <span className="muted">{t('Nacht')}</span>
                  <NumberInput className="input narrow" min={limits.min} max={limits.max} step={limits.step} value={o.night_level ?? limits.min}
                    onChange={(night_level) => setOutput(i, { night_level })} style={{ width: 76 }} />
                </div>
              ) : <span className="muted small">{o.role === 'light' ? t('wird nur gelesen') : control ? t('Ein/Aus') : ''}</span>}
              <button type="button" className="icon-btn" aria-label={t('Ausgang entfernen')} onClick={() => set({ outputs: outputs.filter((_, j) => j !== i) })}>
                <Icon name="trash" size={18} />
              </button>
            </div>
          )
        })}
        {!outputs.length ? <p className="muted small" style={{ margin: 0 }}>{t('Noch keine Ausgänge. „Vorschlag aus dem Raum“ ordnet sie nach Gerätetyp zu.')}</p> : null}
      </div>
    </Modal>
  )
}

import { useEffect, useState } from 'react'
import { api, setState, toast, useStore } from '../store.js'
import { fmt } from '../format.js'
import Icon from '../components/Icon.jsx'
import { DaysPicker, Empty, Field, Modal, NumberInput, Segmented, Toggle } from '../components/ui.jsx'
import { describeRule, findControl, findSensor, OutputSelect, SensorSelect } from '../components/pickers.jsx'
import { managedOutputs } from '../editors/RoomControl.jsx'
import { VENDORS } from '../format.js'
import { LOCALE, t } from '../i18n.js'

const TYPES = [
  { key: 'threshold', label: t('Grenzwert') },
  { key: 'schedule', label: t('Zeitfenster') },
  { key: 'cycle', label: t('Intervall') },
  { key: 'device_state', label: t('Anderes Gerät') },
]

function defaultActions(control) {
  if (!control) return { active: { on: true }, inactive: { on: false } }
  if (control.features.includes('on_off')) return { active: { on: true }, inactive: { on: false } }
  if (control.features.includes('option') && control.options.length) {
    return { active: { option: control.options[0].key }, inactive: null }
  }
  if (control.features.includes('mode') && control.modes.length) return { active: { mode: control.modes[0].key }, inactive: null }
  return { active: {}, inactive: null }
}

export function ActionEditor({ control, action, onChange }) {
  if (!control) return <p className="muted small">{t('Wähle zuerst einen Ausgang.')}</p>
  const f = control.features
  const a = action || {}
  const set = (patch) => {
    const next = { ...a, ...patch }
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key]
    onChange(next)
  }
  return (
    <div className="stack">
      {f.includes('on_off') ? (
        <Segmented label={t('Schalten')} value={a.on === false ? 'off' : a.on === true ? 'on' : 'keep'}
          options={[{ key: 'on', label: t('Einschalten') }, { key: 'off', label: t('Ausschalten') }]}
          onChange={(v) => set({ on: v === 'on', level: v === 'off' ? undefined : a.level })} />
      ) : null}
      {f.includes('level') && a.on !== false ? (
        <div className="row">
          <label className="check">
            <input type="checkbox" checked={a.level != null}
              onChange={(e) => set({ level: e.target.checked ? (control.level ?? control.level_max) : undefined })} />
            {t('Stufe festlegen')}
          </label>
          {a.level != null ? (
            <>
              <NumberInput className="input narrow" min={control.level_min} max={control.level_max} step={control.level_step || 1}
                value={a.level} onChange={(v) => set({ level: v ?? control.level_min })} style={{ width: 100 }} />
              <span className="muted small">{control.level_unit === 'Stufe' /* i18n-ignore (server unit key) */ ? t('von {max}', { max: control.level_max }) : control.level_unit}</span>
            </>
          ) : null}
        </div>
      ) : null}
      {f.includes('mode') && control.modes.length > 1 ? (
        <Field label={t('Modus')}>
          <select className="input" value={a.mode ?? ''} onChange={(e) => set({ mode: e.target.value || undefined })}>
            <option value="">{t('Nicht ändern')}</option>
            {control.modes.map((m) => <option key={m.key} value={m.key}>{t(m.label)}</option>)}
          </select>
        </Field>
      ) : null}
      {f.includes('option') && control.options.length ? (
        <Field label={t('Auswahl')}>
          <select className="input" value={a.option ?? ''} onChange={(e) => set({ option: e.target.value || undefined })}>
            <option value="">{t('Nicht ändern')}</option>
            {control.options.map((o) => <option key={o.key} value={o.key}>{t(o.label)}</option>)}
          </select>
        </Field>
      ) : null}
      {control.vendor === 'spiderfarmer' || control.native?.keyPath ? (
        <p className="muted small" style={{ margin: 0 }}>{t('Bei Spider Farmer wechselt der Ausgang beim Schalten in den manuellen Modus.')}</p>
      ) : null}
    </div>
  )
}

function RuleEditor({ rule, devices, onClose, onSaved }) {
  const roomControl = useStore((s) => s.roomControl)
  const rooms = useStore((s) => s.rooms)
  const managed = managedOutputs(roomControl, rooms)
  const [draft, setDraft] = useState(() => JSON.parse(JSON.stringify(rule)))
  const [saving, setSaving] = useState(false)
  const trig = draft.trigger
  const setTrigger = (patch) => setDraft({ ...draft, trigger: { ...trig, ...patch } })
  const { control } = findControl(devices, draft.target.device_id, draft.target.control_id)
  const { sensor } = findSensor(devices, trig.device_id, trig.sensor)
  const elseMode = draft.inactive_action == null ? 'none' : JSON.stringify(draft.inactive_action) === '{"on":false}' ? 'off' : 'custom'

  const changeType = (type) => {
    const base = { type, days: trig.days ?? null }
    if (type === 'threshold') Object.assign(base, { device_id: trig.device_id || '', sensor: trig.sensor || '', op: 'above', value: 28, hysteresis: 1, night_value: null })
    if (type === 'schedule') Object.assign(base, { start: '06:00', end: '00:00' })
    if (type === 'cycle') Object.assign(base, { on_minutes: 15, off_minutes: 45, start: '', end: '' })
    if (type === 'device_state') Object.assign(base, { device_id: '', control_id: '', state: 'on' })
    setDraft({ ...draft, trigger: base })
  }

  const save = async () => {
    setSaving(true)
    const body = { ...draft }
    if (body.trigger.type === 'cycle' && (!body.trigger.start || !body.trigger.end)) {
      body.trigger = { ...body.trigger }
      delete body.trigger.start
      delete body.trigger.end
    }
    try {
      if (draft.id) await api(`/rules/${draft.id}`, { method: 'PUT', body })
      else await api('/rules', { method: 'POST', body })
      toast(t('Regel gespeichert.'))
      onSaved()
      onClose()
    } catch {
      /* toast shown */
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal wide title={draft.id ? t('Regel bearbeiten') : t('Neue Regel')} onClose={onClose}
      actions={<>
        <button className="btn ghost" onClick={onClose}>{t('Abbrechen')}</button>
        <button className="btn primary" onClick={save} disabled={saving}>{saving ? t('Speichern …') : t('Regel speichern')}</button>
      </>}>
      <div className="stack">
        <Field label={t('Name')}>
          <input className="input" value={draft.name} maxLength={80} placeholder={t('Zum Beispiel: Abluft bei Hitze')}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </Field>

        <h3 className="sub">{t('Wann')}</h3>
        <Segmented label={t('Art der Bedingung')} value={trig.type} options={TYPES} onChange={changeType} />
        {trig.type === 'threshold' ? (
          <div className="stack">
            <Field label={t('Sensor')}>
              <SensorSelect devices={devices} value={trig.device_id ? `${trig.device_id}|${trig.sensor}` : ''}
                onChange={(v) => {
                  const [device_id, key] = v.split('|')
                  setTrigger({ device_id: device_id || '', sensor: key || '' })
                }} />
            </Field>
            <div className="form-grid">
              <Field label={t('Bedingung')}>
                <select className="input" value={trig.op} onChange={(e) => setTrigger({ op: e.target.value })}>
                  <option value="above">{t('Wert liegt über')}</option>
                  <option value="below">{t('Wert liegt unter')}</option>
                </select>
              </Field>
              <Field label={sensor?.unit ? t('Grenzwert ({unit})', { unit: sensor.unit }) : t('Grenzwert')}>
                <NumberInput step={0.1} value={trig.value} onChange={(value) => setTrigger({ value })} />
              </Field>
              <Field label={t('Grenzwert nachts')} hint={t('Optional, nutzt Tag/Nacht des Raums')}>
                <NumberInput step={0.1} value={trig.night_value} onChange={(night_value) => setTrigger({ night_value })} />
              </Field>
              <Field label={t('Rückschaltabstand')} hint={t('Verhindert ständiges Hin- und Herschalten')}>
                <NumberInput step={0.1} min={0} value={trig.hysteresis} onChange={(hysteresis) => setTrigger({ hysteresis: hysteresis ?? 0 })} />
              </Field>
            </div>
          </div>
        ) : null}
        {trig.type === 'device_state' ? (
          <div className="stack">
            <Field label={t('Wenn dieser Ausgang')} hint={t('Zum Beispiel das Licht eines anderen Herstellers')}>
              <select className="input" value={trig.device_id ? `${trig.device_id}|${trig.control_id}` : ''}
                onChange={(e) => {
                  const [device_id, control_id] = e.target.value.split('|')
                  setTrigger({ device_id: device_id || '', control_id: control_id || '' })
                }}>
                <option value="">{t('Ausgang wählen')}</option>
                {Object.values(devices).filter((d) => d.controls.some((c) => c.on != null))
                  .sort((a, b) => a.name.localeCompare(b.name, LOCALE)).map((d) => (
                    <optgroup key={d.id} label={`${d.name} (${VENDORS[d.vendor]})`}>
                      {d.controls.filter((c) => c.on != null).map((c) => <option key={c.id} value={`${d.id}|${c.id}`}>{t(c.label)}</option>)}
                    </optgroup>
                  ))}
              </select>
            </Field>
            <Segmented label={t('Zustand')} value={trig.state || 'on'}
              options={[{ key: 'on', label: t('eingeschaltet ist') }, { key: 'off', label: t('ausgeschaltet ist') }]}
              onChange={(state) => setTrigger({ state })} />
          </div>
        ) : null}
        {trig.type === 'schedule' ? (
          <div className="form-grid">
            <Field label={t('Von')}><input className="input" type="time" value={trig.start} onChange={(e) => setTrigger({ start: e.target.value })} /></Field>
            <Field label={t('Bis')} hint={t('Über Mitternacht ist möglich')}><input className="input" type="time" value={trig.end} onChange={(e) => setTrigger({ end: e.target.value })} /></Field>
          </div>
        ) : null}
        {trig.type === 'cycle' ? (
          <div className="form-grid">
            <Field label={t('An für (Minuten)')}><NumberInput min={1} value={trig.on_minutes} onChange={(on_minutes) => setTrigger({ on_minutes })} /></Field>
            <Field label={t('Aus für (Minuten)')}><NumberInput min={1} value={trig.off_minutes} onChange={(off_minutes) => setTrigger({ off_minutes })} /></Field>
            <Field label={t('Nur von')} hint={t('Optional')}><input className="input" type="time" value={trig.start || ''} onChange={(e) => setTrigger({ start: e.target.value })} /></Field>
            <Field label={t('Bis')}><input className="input" type="time" value={trig.end || ''} onChange={(e) => setTrigger({ end: e.target.value })} /></Field>
          </div>
        ) : null}
        <div>
          <span className="small muted" style={{ display: 'block', marginBottom: 6 }}>{t('Wochentage')}</span>
          <DaysPicker value={trig.days} onChange={(days) => setTrigger({ days })} />
        </div>

        <h3 className="sub">{t('Was')}</h3>
        <Field label={t('Ausgang')}>
          <OutputSelect devices={devices} value={draft.target.device_id ? `${draft.target.device_id}|${draft.target.control_id}` : ''}
            onChange={(v) => {
              const [device_id, control_id] = v.split('|')
              const next = findControl(devices, device_id, control_id).control
              const defaults = defaultActions(next)
              setDraft({ ...draft, target: { device_id: device_id || '', control_id: control_id || '' },
                active_action: defaults.active, inactive_action: defaults.inactive })
            }} />
        </Field>
        {managed[`${draft.target.device_id}|${draft.target.control_id}`] ? (
          <div className="notice">{t('Dieser Ausgang wird von der Zeltsteuerung „{room}“ gesteuert. Die Regel schaltet ihn deshalb nicht, solange die Zeltsteuerung aktiv ist.', {
            room: managed[`${draft.target.device_id}|${draft.target.control_id}`] })}</div>
        ) : null}
        <div className="grid-2">
          <div className="panel panel-pad">
            <h3 className="sub" style={{ marginTop: 0 }}>{t('Wenn die Bedingung erfüllt ist')}</h3>
            <ActionEditor control={control} action={draft.active_action} onChange={(active_action) => setDraft({ ...draft, active_action })} />
          </div>
          <div className="panel panel-pad">
            <h3 className="sub" style={{ marginTop: 0 }}>{t('Sonst')}</h3>
            <Segmented label={t('Sonst')} value={elseMode}
              options={[{ key: 'none', label: t('Nichts tun') }, ...(control?.features.includes('on_off') ? [{ key: 'off', label: t('Ausschalten') }] : []), { key: 'custom', label: t('Eigene Aktion') }]}
              onChange={(v) => setDraft({ ...draft, inactive_action: v === 'none' ? null : v === 'off' ? { on: false } : { ...(draft.inactive_action || {}) } })} />
            {elseMode === 'custom' ? (
              <div style={{ marginTop: 12 }}>
                <ActionEditor control={control} action={draft.inactive_action} onChange={(inactive_action) => setDraft({ ...draft, inactive_action })} />
              </div>
            ) : null}
          </div>
        </div>
        <label className="check">
          <input type="checkbox" checked={!!draft.enforce} onChange={(e) => setDraft({ ...draft, enforce: e.target.checked })} />
          {t('Zustand halten: erneut schalten, wenn das Gerät anders eingestellt wird')}
        </label>
        <label className="check">
          <input type="checkbox" checked={draft.enabled !== false} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
          {t('Regel ist aktiv')}
        </label>
      </div>
    </Modal>
  )
}

const NEW_RULE = {
  name: '',
  enabled: true,
  trigger: { type: 'threshold', device_id: '', sensor: '', op: 'above', value: 28, hysteresis: 1, night_value: null, days: null },
  target: { device_id: '', control_id: '' },
  active_action: { on: true },
  inactive_action: { on: false },
  enforce: false,
}

function StatusChip({ rule, state }) {
  if (rule.enabled === false) return <span className="chip">{t('Aus')}</span>
  if (state?.error) return <span className="chip alert">{t('Problem')}</span>
  if (state?.active === true) return <span className="chip leaf">{t('Bedingung erfüllt')}</span>
  if (state?.active === false) return <span className="chip">{t('Nicht erfüllt')}</span>
  return <span className="chip amber">{t('Wartet auf Messwert')}</span>
}

export default function Rules() {
  const devices = useStore((s) => s.devices)
  const automation = useStore((s) => s.automation)
  const [rules, setRules] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [editing, setEditing] = useState(null)

  const load = async () => {
    try {
      const data = await api('/rules', { quiet: true })
      setRules(data.rules)
      setState({ automation: data.status })
    } catch {
      /* ignore */
    } finally {
      setLoaded(true)
    }
  }
  useEffect(() => {
    load()
    const id = setInterval(load, 10000)
    return () => clearInterval(id)
  }, [])

  const toggleRule = async (rule) => {
    try {
      await api(`/rules/${rule.id}`, { method: 'PUT', body: { ...rule, enabled: rule.enabled === false } })
      load()
    } catch {
      /* toast shown */
    }
  }
  const move = async (index, delta) => {
    const next = [...rules]
    const [item] = next.splice(index, 1)
    next.splice(index + delta, 0, item)
    setRules(next)
    await api('/rules/order', { method: 'POST', body: { ids: next.map((r) => r.id) } }).catch(() => {})
    load()
  }
  const remove = async (rule) => {
    if (!window.confirm(t('Regel „{name}“ löschen?', { name: rule.name }))) return
    await api(`/rules/${rule.id}`, { method: 'DELETE' }).catch(() => {})
    load()
  }
  const setEnabled = async (enabled) => {
    try {
      const status = await api('/automation/enabled', { method: 'POST', body: { enabled } })
      setState({ automation: status })
    } catch {
      /* toast shown */
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('Regeln')}</h1>
          <p>
            {t('Regeln verbinden beliebige Sensoren mit beliebigen Ausgängen, auch über die Hersteller hinweg. GrowDeck prüft sie alle 10 Sekunden. Steuern mehrere Regeln denselben Ausgang, gilt die weiter unten stehende.')}
          </p>
        </div>
        <div className="row">
          <label className="check">
            <Toggle checked={automation.enabled} onChange={setEnabled} label={t('Regeln ausführen')} />
            {automation.enabled ? t('Regeln laufen') : t('Pausiert')}
          </label>
          <button className="btn primary" onClick={() => setEditing(NEW_RULE)}><Icon name="plus" size={18} /> {t('Neue Regel')}</button>
        </div>
      </div>

      {!automation.enabled ? (
        <div className="notice" style={{ marginBottom: 16 }}>{t('Alle Regeln sind pausiert. Geräte laufen mit ihren eigenen Einstellungen weiter.')}</div>
      ) : null}

      <div className="panel">
        {loaded && !rules.length ? (
          <Empty title={t('Noch keine Regeln')} action={<button className="btn primary" onClick={() => setEditing(NEW_RULE)}>{t('Erste Regel anlegen')}</button>}>
            {t('Zum Beispiel: Die Vivosun-Abluft schaltet hoch, wenn der Spider-Farmer-Sensor über 28 °C misst.')}
          </Empty>
        ) : null}
        {rules.map((rule, i) => {
          const state = automation.rules?.[rule.id]
          const text = describeRule(rule, devices)
          return (
            <div className="list-row" key={rule.id}>
              <div style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 8 }}>
                  <span className="title">{rule.name}</span>
                  <StatusChip rule={rule} state={state} />
                  {state?.value != null && rule.trigger.type === 'threshold' ? (
                    <span className="small muted num">{t('aktuell {value}', { value: fmt(state.value, 1) })}</span>
                  ) : null}
                </div>
                <div className="meta">{text.when}</div>
                <div className="meta">{t('Dann: {then}', { then: text.then })}</div>
                {state?.error ? <div className="ctl-note">{t(state.error)}</div> : null}
              </div>
              <div className="row" style={{ gap: 4 }}>
                <Toggle checked={rule.enabled !== false} onChange={() => toggleRule(rule)} label={t('{name} aktiv', { name: rule.name })} />
                <button className="icon-btn" aria-label={t('Nach oben')} disabled={i === 0} onClick={() => move(i, -1)}><Icon name="up" /></button>
                <button className="icon-btn" aria-label={t('Nach unten')} disabled={i === rules.length - 1} onClick={() => move(i, 1)}><Icon name="down" /></button>
                <button className="icon-btn" aria-label={t('Bearbeiten')} onClick={() => setEditing(rule)}><Icon name="edit" /></button>
                <button className="icon-btn" aria-label={t('Löschen')} onClick={() => remove(rule)}><Icon name="trash" /></button>
              </div>
            </div>
          )
        })}
      </div>

      {editing ? <RuleEditor rule={editing} devices={devices} onClose={() => setEditing(null)} onSaved={load} /> : null}
    </>
  )
}

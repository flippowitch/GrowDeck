// Editors for settings that run on the devices themselves.
import { useEffect, useState } from 'react'
import { api, sendCommand, toast } from '../store.js'
import { Field, Modal, NumberInput, Segmented, WeekmaskPicker } from '../components/ui.jsx'
import Icon from '../components/Icon.jsx'
import { hhmmToSeconds, minutesToHhmm } from '../format.js'
import { t } from '../i18n.js'

const clone = (v) => JSON.parse(JSON.stringify(v ?? null))

function timeValue(seconds) {
  const s = Number(seconds) || 0
  return minutesToHhmm(Math.round((s >= 86400 ? 0 : s) / 60))
}

function useNativeConfig(device, keyPath, fallback) {
  const [cfg, setCfg] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    api(`/devices/${device.id}/native`, { method: 'POST', body: { action: 'get', keyPath }, quiet: true })
      .then((r) => alive && setCfg(clone(r.value) || {}))
      .catch((err) => {
        if (!alive) return
        if (fallback && Object.keys(fallback).length) {
          setCfg(clone(fallback))
          setError(t('Das Gerät hat nicht geantwortet. Angezeigt wird der zuletzt bekannte Stand.'))
        } else {
          setError(err.message)
          setCfg({})
        }
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.id, keyPath.join('/')])
  return [cfg, setCfg, error]
}

async function saveNative(device, keyPath, value) {
  await api(`/devices/${device.id}/native`, { method: 'POST', body: { action: 'set', keyPath, value } })
  toast(t('Auf dem Gerät gespeichert.'))
}

// ------------------------------------------------------------ time periods
export function PeriodList({ periods, onChange, withBrightness, max = 12 }) {
  const update = (i, patch) => onChange(periods.map((p, j) => (j === i ? { ...p, ...patch } : p)))
  return (
    <div>
      {periods.length === 0 ? <p className="muted small">{t('Noch kein Zeitfenster angelegt.')}</p> : null}
      {periods.map((p, i) => (
        <div className="period-row" key={i}>
          <label className="check" title={t('Zeitfenster aktiv')}>
            <input type="checkbox" checked={!!p.enabled} onChange={(e) => update(i, { enabled: e.target.checked ? 1 : 0 })} />
            <span className="small">{t('Aktiv')}</span>
          </label>
          <input className="input" type="time" aria-label={t('Beginn')} value={timeValue(p.startTime)}
            onChange={(e) => update(i, { startTime: hhmmToSeconds(e.target.value) })} />
          <input className="input" type="time" aria-label={t('Ende')} value={timeValue(p.endTime)}
            onChange={(e) => update(i, { endTime: hhmmToSeconds(e.target.value) })} />
          <div className="row extra">
            <WeekmaskPicker value={p.weekmask ?? 127} onChange={(weekmask) => update(i, { weekmask })} />
            {withBrightness ? (
              <label className="row small">
                <span className="muted">{t('Helligkeit')}</span>
                <NumberInput className="input narrow" min={0} max={100} value={p.brightness ?? 100}
                  onChange={(v) => update(i, { brightness: v ?? 0 })} style={{ width: 80 }} />
                <span className="muted">%</span>
              </label>
            ) : null}
          </div>
          <button type="button" className="icon-btn" aria-label={t('Zeitfenster entfernen')}
            onClick={() => onChange(periods.filter((_, j) => j !== i))}>
            <Icon name="trash" size={19} />
          </button>
        </div>
      ))}
      {periods.length < max ? (
        <button type="button" className="btn small" onClick={() => onChange([
          ...periods,
          { enabled: 1, weekmask: 127, startTime: 8 * 3600, endTime: 20 * 3600, ...(withBrightness ? { brightness: 100 } : {}) },
        ])}>
          <Icon name="plus" size={17} /> {t('Zeitfenster hinzufügen')}
        </button>
      ) : null}
    </div>
  )
}

function CycleFields({ cycle, onChange }) {
  const c = cycle || { weekmask: 127, startTime: 8 * 3600, openDur: 3600, closeDur: 1800, times: 3 }
  const set = (patch) => onChange({ ...c, ...patch })
  return (
    <div className="stack">
      <div className="form-grid">
        <Field label={t('Start')}>
          <input className="input" type="time" value={timeValue(c.startTime)}
            onChange={(e) => set({ startTime: hhmmToSeconds(e.target.value) })} />
        </Field>
        <Field label={t('An-Dauer (Minuten)')}>
          <NumberInput min={1} value={Math.round((c.openDur ?? 0) / 60)} onChange={(v) => set({ openDur: Math.max(1, v ?? 1) * 60 })} />
        </Field>
        <Field label={t('Aus-Dauer (Minuten)')}>
          <NumberInput min={1} value={Math.round((c.closeDur ?? 0) / 60)} onChange={(v) => set({ closeDur: Math.max(1, v ?? 1) * 60 })} />
        </Field>
        <Field label={t('Wiederholungen')} hint={t('0 wiederholt bis Mitternacht')}>
          <NumberInput min={0} value={c.times ?? 0} onChange={(v) => set({ times: Math.max(0, v ?? 0) })} />
        </Field>
      </div>
      <WeekmaskPicker value={c.weekmask ?? 127} onChange={(weekmask) => set({ weekmask })} />
    </div>
  )
}

function ModeSelect({ modes, value, onChange }) {
  return (
    <select className="input" value={String(value ?? '0')} onChange={(e) => onChange(Number(e.target.value))}>
      {modes.map((m) => <option key={m.key} value={m.key}>{t(m.label)}</option>)}
    </select>
  )
}

function Loading({ error }) {
  return error ? <div className="notice alert">{error}</div> : <p className="muted">{t('Lade Einstellungen vom Gerät …')}</p>
}

// ------------------------------------------- SF light / blower / fan channel
export function SfChannelEditor({ device, control, onClose }) {
  const keyPath = control.native?.keyPath || []
  const [cfg, setCfg, error] = useNativeConfig(device, keyPath, control.native?.config)
  const [saving, setSaving] = useState(false)
  const isLight = control.type === 'light'
  const isFanLike = control.id === 'blower' || control.id === 'fan'
  const set = (patch) => setCfg({ ...cfg, ...patch })
  const save = async () => {
    setSaving(true)
    try {
      await saveNative(device, keyPath, cfg)
      onClose()
    } catch {
      /* toast shown */
    } finally {
      setSaving(false)
    }
  }
  const mode = Number(cfg?.modeType ?? 0)
  return (
    <Modal wide title={t('{name}: Zeitplan und Zyklus', { name: t(control.label) })} onClose={onClose}
      actions={<>
        <button className="btn ghost" onClick={onClose}>{t('Abbrechen')}</button>
        <button className="btn primary" disabled={!cfg || saving} onClick={save}>{saving ? t('Speichern …') : t('Auf Gerät speichern')}</button>
      </>}>
      {!cfg ? <Loading error={error} /> : (
        <div className="stack">
          {error ? <div className="notice">{error}</div> : null}
          <p className="muted small" style={{ margin: 0 }}>
            {t('Diese Einstellungen laufen direkt auf dem Spider-Farmer-Gerät und funktionieren auch, wenn GrowDeck aus ist.')}
          </p>
          <Field label={t('Modus')}>
            <ModeSelect modes={control.modes} value={mode} onChange={(modeType) => set({ modeType })} />
          </Field>
          <h3 className="sub">{mode === 1 ? t('Zeitplan (aktiv)') : t('Zeitplan')}</h3>
          <PeriodList periods={cfg.timePeriod || []} withBrightness={isLight} onChange={(timePeriod) => set({ timePeriod })} />
          <h3 className="sub">{mode === 2 ? t('Zyklus (aktiv)') : t('Zyklus')}</h3>
          <CycleFields cycle={cfg.cycleTime} onChange={(cycleTime) => set({ cycleTime })} />
          {isLight ? (
            <>
              <h3 className="sub">{t('Hitzeschutz und PPFD-Automatik')}</h3>
              <div className="form-grid">
                <Field label={t('Dimmen ab (°C)')} hint={t('Leer lassen = aus')}>
                  <NumberInput step={0.5} value={cfg.darkTemp} onChange={(darkTemp) => set({ darkTemp })} />
                </Field>
                <Field label={t('Ausschalten ab (°C)')} hint={t('Leer lassen = aus')}>
                  <NumberInput step={0.5} value={cfg.offTemp} onChange={(offTemp) => set({ offTemp })} />
                </Field>
                <Field label={t('PPFD: minimale Helligkeit (%)')}>
                  <NumberInput min={0} max={100} value={cfg.ppfdMinBrightness} onChange={(v) => set({ ppfdMinBrightness: v })} />
                </Field>
                <Field label={t('PPFD: maximale Helligkeit (%)')}>
                  <NumberInput min={0} max={100} value={cfg.ppfdMaxBrightness} onChange={(v) => set({ ppfdMaxBrightness: v })} />
                </Field>
              </div>
            </>
          ) : null}
          {isFanLike ? (
            <>
              <h3 className="sub">{t('Klimamodi')}</h3>
              <p className="muted small" style={{ margin: 0 }}>
                {t('In den Modi Klima, Luftfeuchte und Temperatur regelt das Gerät zwischen diesen Stufen anhand der Klimaziele.')}
              </p>
              <div className="form-grid">
                <Field label={t('Minimale Stufe')}>
                  <NumberInput min={0} max={control.id === 'fan' ? 10 : 100} value={cfg.minSpeed} onChange={(minSpeed) => set({ minSpeed })} />
                </Field>
                <Field label={t('Maximale Stufe')}>
                  <NumberInput min={0} max={control.id === 'fan' ? 10 : 100} value={cfg.maxSpeed} onChange={(maxSpeed) => set({ maxSpeed })} />
                </Field>
              </div>
            </>
          ) : null}
        </div>
      )}
    </Modal>
  )
}

// ------------------------------------------------------------ SF outlets
const ENV_CHOICES = {
  3: { field: 'tempAdd', label: t('Das Gerät an dieser Steckdose …'), options: [
    { key: 1, label: t('heizt (an, wenn zu kalt)') }, { key: 2, label: t('kühlt (an, wenn zu warm)') }] },
  4: { field: 'humiAdd', label: t('Das Gerät an dieser Steckdose …'), options: [
    { key: 1, label: t('befeuchtet (an, wenn zu trocken)') }, { key: 2, label: t('entfeuchtet (an, wenn zu feucht)') }] },
  5: { field: 'co2Add', label: t('Das Gerät an dieser Steckdose …'), options: [
    { key: 1, label: t('gibt CO₂ zu (an, wenn zu wenig)') }, { key: 2, label: t('senkt CO₂ (an, wenn zu viel)') }] },
}

function DripFields({ cfg, set, soilIds }) {
  const env = cfg.wateringEnv || { period: [], extra: { enabled: 0, dry: 30, openDur: 60, closeDur: 600 } }
  const periods = env.period || []
  const extra = env.extra || { enabled: 0, dry: 30, openDur: 60, closeDur: 600 }
  const setEnv = (patch) => set({ wateringEnv: { ...env, ...patch } })
  const setPeriod = (i, patch) => setEnv({ period: periods.map((p, j) => (j === i ? { ...p, ...patch } : p)) })
  return (
    <div className="stack">
      <Field label={t('Bodensensor')}>
        <select className="input" value={cfg.bind?.id ?? 'avg'}
          onChange={(e) => set({ bind: { bindType: 2, id: e.target.value } })}>
          <option value="avg">{t('Durchschnitt aller Sonden')}</option>
          {soilIds.map((id) => <option key={id} value={id}>{t('Bodensonde {id}', { id })}</option>)}
        </select>
      </Field>
      <h3 className="sub">{t('Bewässerungsfenster')}</h3>
      {periods.map((p, i) => (
        <div className="panel panel-pad stack" key={i}>
          <div className="spread">
            <label className="check">
              <input type="checkbox" checked={!!p.enabled} onChange={(e) => setPeriod(i, { enabled: e.target.checked ? 1 : 0 })} />
              {t('Fenster {n} aktiv', { n: i + 1 })}
            </label>
            <button type="button" className="icon-btn" aria-label={t('Fenster entfernen')}
              onClick={() => setEnv({ period: periods.filter((_, j) => j !== i).map((x, j) => ({ ...x, tmn: j + 1 })) })}>
              <Icon name="trash" size={19} />
            </button>
          </div>
          <div className="form-grid">
            <Field label={t('Von')}><input className="input" type="time" value={timeValue(p.startTime)} onChange={(e) => setPeriod(i, { startTime: hhmmToSeconds(e.target.value) })} /></Field>
            <Field label={t('Bis')}><input className="input" type="time" value={timeValue(p.endTime)} onChange={(e) => setPeriod(i, { endTime: hhmmToSeconds(e.target.value) })} /></Field>
            <Field label={t('Pumpe an (Sekunden)')}><NumberInput min={1} value={p.openDur} onChange={(v) => setPeriod(i, { openDur: v ?? 1 })} /></Field>
            <Field label={t('Pause (Sekunden)')}><NumberInput min={1} value={p.closeDur} onChange={(v) => setPeriod(i, { closeDur: v ?? 1 })} /></Field>
            <Field label={t('Ziel-Bodenfeuchte (%)')}><NumberInput min={0} max={99} value={p.target} onChange={(v) => setPeriod(i, { target: v ?? 0 })} /></Field>
            <Field label={t('Gießen unter (%)')}><NumberInput min={0} max={99} value={p.dry} onChange={(v) => setPeriod(i, { dry: v ?? 0 })} /></Field>
          </div>
        </div>
      ))}
      {periods.length < 12 ? (
        <button type="button" className="btn small" onClick={() => setEnv({ period: [...periods, {
          enabled: 1, startTime: 28800, endTime: 32400, openDur: 60, closeDur: 600, target: 50, dry: 30, tmn: periods.length + 1,
        }] })}>
          <Icon name="plus" size={17} /> {t('Fenster hinzufügen')}
        </button>
      ) : null}
      <h3 className="sub">{t('Zusatzbewässerung außerhalb der Fenster')}</h3>
      <label className="check">
        <input type="checkbox" checked={!!extra.enabled} onChange={(e) => setEnv({ extra: { ...extra, enabled: e.target.checked ? 1 : 0 } })} />
        {t('Gießen, wenn der Boden zu trocken wird')}
      </label>
      {extra.enabled ? (
        <div className="form-grid">
          <Field label={t('Gießen unter (%)')}><NumberInput min={0} max={99} value={extra.dry} onChange={(v) => setEnv({ extra: { ...extra, dry: v ?? 0 } })} /></Field>
          <Field label={t('Pumpe an (Sekunden)')}><NumberInput min={1} value={extra.openDur} onChange={(v) => setEnv({ extra: { ...extra, openDur: v ?? 1 } })} /></Field>
          <Field label={t('Pause (Sekunden)')}><NumberInput min={1} value={extra.closeDur} onChange={(v) => setEnv({ extra: { ...extra, closeDur: v ?? 1 } })} /></Field>
        </div>
      ) : null}
    </div>
  )
}

export function SfOutletEditor({ device, control, onClose }) {
  const keyPath = control.native?.keyPath || ['outlet', control.id]
  const [cfg, setCfg, error] = useNativeConfig(device, keyPath, control.native?.config)
  const [saving, setSaving] = useState(false)
  const set = (patch) => setCfg({ ...cfg, ...patch })
  const mode = Number(cfg?.modeType ?? 0)
  const soilIds = [...new Set(device.sensors.map((s) => /^soil(\d+)\./.exec(s.key)?.[1]).filter(Boolean))]

  const changeMode = (modeType) => {
    const next = { ...cfg, modeType }
    if (modeType === 1 && !(next.timePeriod || []).length) {
      next.timePeriod = [{ enabled: 1, weekmask: 127, startTime: 8 * 3600, endTime: 20 * 3600 }]
    }
    if (modeType === 2 && !next.cycleTime) {
      next.cycleTime = { weekmask: 127, startTime: 8 * 3600, openDur: 900, closeDur: 2700, times: 0 }
    }
    if (modeType === 3 && !next.tempAdd) next.tempAdd = 1
    if (modeType === 4 && !next.humiAdd) next.humiAdd = 1
    if (modeType === 5 && !next.co2Add) next.co2Add = 1
    if (modeType === 14 && !next.wateringEnv) {
      next.wateringEnv = { period: [], extra: { enabled: 0, dry: 30, openDur: 60, closeDur: 600 } }
      next.bind = { bindType: 2, id: 'avg' }
    }
    setCfg(next)
  }

  const save = async () => {
    setSaving(true)
    try {
      await saveNative(device, keyPath, cfg)
      onClose()
    } catch {
      /* toast shown */
    } finally {
      setSaving(false)
    }
  }

  const env = ENV_CHOICES[mode]
  return (
    <Modal wide title={t('{name}: Modus einrichten', { name: t(control.label) })} onClose={onClose}
      actions={<>
        <button className="btn ghost" onClick={onClose}>{t('Abbrechen')}</button>
        <button className="btn primary" disabled={!cfg || saving} onClick={save}>{saving ? t('Speichern …') : t('Auf Gerät speichern')}</button>
      </>}>
      {!cfg ? <Loading error={error} /> : (
        <div className="stack">
          {error ? <div className="notice">{error}</div> : null}
          <Field label={t('Modus')}>
            <ModeSelect modes={control.modes} value={mode} onChange={changeMode} />
          </Field>
          {mode === 0 ? <p className="muted">{t('Im manuellen Modus schaltest du die Steckdose direkt mit dem Schalter.')}</p> : null}
          {mode === 1 ? <PeriodList periods={cfg.timePeriod || []} onChange={(timePeriod) => set({ timePeriod })} /> : null}
          {mode === 2 ? <CycleFields cycle={cfg.cycleTime} onChange={(cycleTime) => set({ cycleTime })} /> : null}
          {env ? (
            <>
              <Field label={env.label}>
                <Segmented
                  label={env.label}
                  value={Number(cfg[env.field] ?? 1)}
                  options={env.options}
                  onChange={(v) => set({ [env.field]: v })}
                />
              </Field>
              <p className="muted small" style={{ margin: 0 }}>
                {t('Die Zielwerte für Tag und Nacht legst du unter „Klimaziele“ des Geräts fest.')}
              </p>
            </>
          ) : null}
          {mode === 14 ? <DripFields cfg={cfg} set={set} soilIds={soilIds} /> : null}
        </div>
      )}
    </Modal>
  )
}

// ------------------------------------------------------------ SF targets
const TARGET_ROWS = [
  { key: 'temp', label: t('Temperatur'), unit: '°C', step: 1, band: t('Toleranz (°C)') },
  { key: 'humi', label: t('Luftfeuchte'), unit: '%', step: 1, band: t('Toleranz (%)') },
  { key: 'co2', label: 'CO₂', unit: 'ppm', step: 50, band: t('Toleranz (ppm)') },
]

export function SfTargetsEditor({ device, onClose }) {
  const [cfg, setCfg, error] = useNativeConfig(device, ['target'], null)
  const [plan, setPlan] = useState(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    api(`/devices/${device.id}/native`, { method: 'POST', body: { action: 'get', keyPath: ['plan'] }, quiet: true })
      .then((r) => setPlan(r.value))
      .catch(() => {})
  }, [device.id])
  const target = {
    dayTime: { startTime: 6 * 3600, endTime: 0 },
    temp: { targetDay: 26, targetNight: 21, deadband: 1 },
    humi: { targetDay: 60, targetNight: 55, deadband: 3 },
    co2: { targetDay: 800, targetNight: 500, deadband: 50 },
    ...(cfg || {}),
  }
  const setPart = (key, patch) => setCfg({ ...target, [key]: { ...target[key], ...patch } })
  const save = async () => {
    setSaving(true)
    try {
      await saveNative(device, ['target'], target)
      onClose()
    } catch {
      /* toast shown */
    } finally {
      setSaving(false)
    }
  }
  const planActive = plan && (plan.enabled === 1 || plan.enabled === true || plan.isPlanRun === 1)
  return (
    <Modal wide title={t('Klimaziele auf dem Gerät')} onClose={onClose}
      actions={<>
        <button className="btn ghost" onClick={onClose}>{t('Abbrechen')}</button>
        <button className="btn primary" disabled={!cfg || saving} onClick={save}>{saving ? t('Speichern …') : t('Auf Gerät speichern')}</button>
      </>}>
      {!cfg ? <Loading error={error} /> : (
        <div className="stack">
          <p className="muted small" style={{ margin: 0 }}>
            {t('Die Spider-Farmer-Firmware nutzt diese Werte für Steckdosen und Lüfter in den Modi Temperatur, Luftfeuchte, CO₂ und Klima.')}
          </p>
          {planActive ? (
            <div className="notice">
              {t('Auf dem Gerät läuft ein Anbauplan aus der Spider-Farmer-App. Er kann diese Werte beim nächsten Phasenwechsel überschreiben.')}
            </div>
          ) : null}
          <div className="form-grid">
            <Field label={t('Tag beginnt')}>
              <input className="input" type="time" value={timeValue(target.dayTime?.startTime)}
                onChange={(e) => setPart('dayTime', { startTime: hhmmToSeconds(e.target.value) })} />
            </Field>
            <Field label={t('Tag endet')}>
              <input className="input" type="time" value={timeValue(target.dayTime?.endTime)}
                onChange={(e) => setPart('dayTime', { endTime: hhmmToSeconds(e.target.value) })} />
            </Field>
          </div>
          {TARGET_ROWS.map((row) => (
            <div key={row.key}>
              <h3 className="sub">{row.label}</h3>
              <div className="form-grid">
                <Field label={t('Tag ({unit})', { unit: row.unit })}>
                  <NumberInput step={row.step} value={target[row.key]?.targetDay} onChange={(v) => setPart(row.key, { targetDay: v ?? 0 })} />
                </Field>
                <Field label={t('Nacht ({unit})', { unit: row.unit })}>
                  <NumberInput step={row.step} value={target[row.key]?.targetNight} onChange={(v) => setPart(row.key, { targetNight: v ?? 0 })} />
                </Field>
                <Field label={row.band}>
                  <NumberInput step={row.step} min={0} value={target[row.key]?.deadband} onChange={(v) => setPart(row.key, { deadband: v ?? 0 })} />
                </Field>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

// --------------------------------------------------- Vivosun exhaust auto
const AUTO_FIELDS = [
  { min: 'tMin', max: 'tMax', label: t('Temperatur'), unit: '°C', step: 0.5 },
  { min: 'hMin', max: 'hMax', label: t('Luftfeuchte'), unit: '%', step: 1 },
  { min: 'vpdMin', max: 'vpdMax', label: 'VPD', unit: 'kPa', step: 0.05 },
]

export function VsFanAutoEditor({ device, control, onClose }) {
  const [auto, setAuto] = useState({ ...(control.extra?.auto || {}) })
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    try {
      await sendCommand(device.id, control.id, { mode: '1', auto })
      toast(t('Automatik gespeichert und eingeschaltet.'))
      onClose()
    } catch {
      /* toast shown */
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal title={t('{name}: Automatik', { name: t(control.label) })} onClose={onClose}
      actions={<>
        <button className="btn ghost" onClick={onClose}>{t('Abbrechen')}</button>
        <button className="btn primary" disabled={saving} onClick={save}>{saving ? t('Speichern …') : t('Speichern und Automatik einschalten')}</button>
      </>}>
      <div className="stack">
        <p className="muted small" style={{ margin: 0 }}>
          {t('Der GrowHub dreht die Abluft hoch, sobald ein Wert die Grenze überschreitet. Leere Felder sind ausgeschaltet.')}
        </p>
        {AUTO_FIELDS.map((f) => (
          <div className="form-grid" key={f.label}>
            <Field label={t('{name}: untere Grenze ({unit})', { name: f.label, unit: f.unit })}>
              <NumberInput step={f.step} value={auto[f.min]} onChange={(v) => setAuto({ ...auto, [f.min]: v })} />
            </Field>
            <Field label={t('{name}: obere Grenze ({unit})', { name: f.label, unit: f.unit })}>
              <NumberInput step={f.step} value={auto[f.max]} onChange={(v) => setAuto({ ...auto, [f.max]: v })} />
            </Field>
          </div>
        ))}
      </div>
    </Modal>
  )
}

// ------------------------------------------------------- AC Infinity ports
function Threshold({ label, unit, enabled, value, step = 1, min, max, onToggle, onValue }) {
  return (
    <div className="row" style={{ gap: 10 }}>
      <label className="check" style={{ minWidth: 190 }}>
        <input type="checkbox" checked={!!enabled} onChange={(e) => onToggle(e.target.checked)} />
        {label}
      </label>
      <NumberInput className="input narrow" step={step} min={min} max={max} value={value} disabled={!enabled}
        onChange={onValue} style={{ width: 100 }} aria-label={label} />
      <span className="muted small">{unit}</span>
    </div>
  )
}

const TIMER_MODES = { 4: ['to_on', t('Einschalten nach (Minuten)')], 5: ['to_off', t('Ausschalten nach (Minuten)')] }

export function AciPortEditor({ device, control, onClose }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let alive = true
    api(`/devices/${device.id}/native`, { method: 'POST', body: { action: 'get', control_id: control.id }, quiet: true })
      .then((r) => alive && setData(r))
      .catch((err) => alive && setError(err.message))
    return () => {
      alive = false
    }
  }, [device.id, control.id])

  const v = data?.value
  const set = (patch) => setData({ ...data, value: { ...v, ...patch } })
  const setGroup = (group, patch) => set({ [group]: { ...(v[group] || {}), ...patch } })
  const mode = Number(v?.mode || 1)

  const save = async () => {
    setSaving(true)
    try {
      await api(`/devices/${device.id}/native`, { method: 'POST', body: { action: 'set', control_id: control.id, value: v } })
      toast(t('Auf dem Controller gespeichert.'))
      onClose()
    } catch {
      /* toast shown */
    } finally {
      setSaving(false)
    }
  }

  const a = v?.auto || {}
  const p = v?.vpd || {}
  const x = v?.ai || {}
  return (
    <Modal wide title={t('{name}: Port einrichten', { name: t(control.label) })} onClose={onClose}
      actions={<>
        <button className="btn ghost" onClick={onClose}>{t('Abbrechen')}</button>
        <button className="btn primary" disabled={!v || saving} onClick={save}>{saving ? t('Speichern …') : t('Auf Controller speichern')}</button>
      </>}>
      {!v ? <Loading error={error} /> : (
        <div className="stack">
          <p className="muted small" style={{ margin: 0 }}>
            {t('Der Controller führt diese Einstellungen selbst aus, auch wenn GrowDeck aus ist. Sie werden über die AC-Infinity-Cloud übertragen.')}
          </p>
          <div className="form-grid">
            <Field label={t('Modus')}>
              <select className="input" value={String(mode)} onChange={(e) => set({ mode: e.target.value })}>
                {data.modes.map((m) => <option key={m.key} value={m.key}>{t(m.label)}</option>)}
              </select>
            </Field>
            {!data.outlet ? (
              <Field label={t('Stufe bei An (0–10)')}>
                <NumberInput min={0} max={10} value={v.on_speed} onChange={(on_speed) => set({ on_speed })} />
              </Field>
            ) : null}
            {v.off_speed != null ? (
              <Field label={t('Stufe bei Aus (0–10)')} hint={t('Grundlast, zum Beispiel für Abluft')}>
                <NumberInput min={0} max={10} value={v.off_speed} onChange={(off_speed) => set({ off_speed })} />
              </Field>
            ) : null}
          </div>

          {mode === 3 ? (
            <>
              <h3 className="sub">{t('Auto: schaltet an, wenn …')}</h3>
              <Segmented label={t('Art')} value={a.target_mode ? 'target' : 'limits'}
                options={[{ key: 'limits', label: t('Grenzwerte') }, { key: 'target', label: t('Zielwert') }]}
                onChange={(k) => setGroup('auto', { target_mode: k === 'target' })} />
              {a.target_mode ? (
                <div className="stack">
                  <Threshold label={t('Zieltemperatur')} unit="°C" enabled={a.target_temp_on} value={a.target_temp}
                    onToggle={(on) => setGroup('auto', { target_temp_on: on })} onValue={(target_temp) => setGroup('auto', { target_temp })} />
                  <Threshold label={t('Zielfeuchte')} unit="%" enabled={a.target_humi_on} value={a.target_humi}
                    onToggle={(on) => setGroup('auto', { target_humi_on: on })} onValue={(target_humi) => setGroup('auto', { target_humi })} />
                </div>
              ) : (
                <div className="stack">
                  <Threshold label={t('Temperatur über')} unit="°C" enabled={a.temp_high_on} value={a.temp_high}
                    onToggle={(on) => setGroup('auto', { temp_high_on: on })} onValue={(temp_high) => setGroup('auto', { temp_high })} />
                  <Threshold label={t('Temperatur unter')} unit="°C" enabled={a.temp_low_on} value={a.temp_low}
                    onToggle={(on) => setGroup('auto', { temp_low_on: on })} onValue={(temp_low) => setGroup('auto', { temp_low })} />
                  <Threshold label={t('Luftfeuchte über')} unit="%" enabled={a.humi_high_on} value={a.humi_high}
                    onToggle={(on) => setGroup('auto', { humi_high_on: on })} onValue={(humi_high) => setGroup('auto', { humi_high })} />
                  <Threshold label={t('Luftfeuchte unter')} unit="%" enabled={a.humi_low_on} value={a.humi_low}
                    onToggle={(on) => setGroup('auto', { humi_low_on: on })} onValue={(humi_low) => setGroup('auto', { humi_low })} />
                </div>
              )}
            </>
          ) : null}

          {mode === 8 ? (
            <>
              <h3 className="sub">{t('VPD: schaltet an, wenn …')}</h3>
              <Segmented label={t('Art')} value={p.target_mode ? 'target' : 'limits'}
                options={[{ key: 'limits', label: t('Grenzwerte') }, { key: 'target', label: t('Zielwert') }]}
                onChange={(k) => setGroup('vpd', { target_mode: k === 'target' })} />
              {p.target_mode ? (
                <Threshold label={t('Ziel-VPD')} unit="kPa" step={0.1} enabled={p.target_on} value={p.target}
                  onToggle={(on) => setGroup('vpd', { target_on: on })} onValue={(target) => setGroup('vpd', { target })} />
              ) : (
                <div className="stack">
                  <Threshold label={t('VPD über')} unit="kPa" step={0.1} enabled={p.high_on} value={p.high}
                    onToggle={(on) => setGroup('vpd', { high_on: on })} onValue={(high) => setGroup('vpd', { high })} />
                  <Threshold label={t('VPD unter')} unit="kPa" step={0.1} enabled={p.low_on} value={p.low}
                    onToggle={(on) => setGroup('vpd', { low_on: on })} onValue={(low) => setGroup('vpd', { low })} />
                </div>
              )}
            </>
          ) : null}

          {TIMER_MODES[mode] ? (
            <Field label={TIMER_MODES[mode][1]} hint={t('Der Timer startet beim Speichern.')}>
              <NumberInput min={0} max={1440} value={v.timer?.[TIMER_MODES[mode][0]]}
                onChange={(val) => setGroup('timer', { [TIMER_MODES[mode][0]]: val })} />
            </Field>
          ) : null}

          {mode === 6 ? (
            <div className="form-grid">
              <Field label={t('An für (Minuten)')}><NumberInput min={0} max={1440} value={v.cycle?.on} onChange={(on) => setGroup('cycle', { on })} /></Field>
              <Field label={t('Aus für (Minuten)')}><NumberInput min={0} max={1440} value={v.cycle?.off} onChange={(off) => setGroup('cycle', { off })} /></Field>
            </div>
          ) : null}

          {mode === 7 ? (
            <div className="form-grid">
              <Field label={t('Ein um')} hint={t('Leer = kein Einschalten')}>
                <input className="input" type="time" value={v.schedule?.start || ''} onChange={(e) => setGroup('schedule', { start: e.target.value || null })} />
              </Field>
              <Field label={t('Aus um')} hint={t('Leer = kein Ausschalten')}>
                <input className="input" type="time" value={v.schedule?.end || ''} onChange={(e) => setGroup('schedule', { end: e.target.value || null })} />
              </Field>
            </div>
          ) : null}

          {mode === 9 ? (
            <Threshold label={t('CO₂ unter')} unit="ppm" step={50} enabled={x.co2_low_on} value={x.co2_low}
              onToggle={(on) => setGroup('ai', { co2_low_on: on })} onValue={(co2_low) => setGroup('ai', { co2_low })} />
          ) : null}
          {mode === 10 ? (
            <Threshold label={t('CO₂ über')} unit="ppm" step={50} enabled={x.co2_fan_high_on} value={x.co2_fan_high}
              onToggle={(on) => setGroup('ai', { co2_fan_high_on: on })} onValue={(co2_fan_high) => setGroup('ai', { co2_fan_high })} />
          ) : null}
          {mode === 11 ? (
            <Threshold label={t('Bodenfeuchte unter')} unit="%" enabled={x.moisture_low_on} value={x.moisture_low}
              onToggle={(on) => setGroup('ai', { moisture_low_on: on })} onValue={(moisture_low) => setGroup('ai', { moisture_low })} />
          ) : null}
          {mode === 12 ? (
            <div className="stack">
              <Threshold label={t('Wassertemperatur über')} unit="°C" enabled={x.water_temp_high_on} value={x.water_temp_high}
                onToggle={(on) => setGroup('ai', { water_temp_high_on: on })} onValue={(water_temp_high) => setGroup('ai', { water_temp_high })} />
              <Threshold label={t('Wassertemperatur unter')} unit="°C" enabled={x.water_temp_low_on} value={x.water_temp_low}
                onToggle={(on) => setGroup('ai', { water_temp_low_on: on })} onValue={(water_temp_low) => setGroup('ai', { water_temp_low })} />
            </div>
          ) : null}
          {mode === 13 ? (
            <div className="stack">
              <Threshold label={t('pH über')} unit="" step={0.1} enabled={x.ph_high_on} value={x.ph_high}
                onToggle={(on) => setGroup('ai', { ph_high_on: on })} onValue={(ph_high) => setGroup('ai', { ph_high })} />
              <Threshold label={t('pH unter')} unit="" step={0.1} enabled={x.ph_low_on} value={x.ph_low}
                onToggle={(on) => setGroup('ai', { ph_low_on: on })} onValue={(ph_low) => setGroup('ai', { ph_low })} />
            </div>
          ) : null}
          {mode === 14 || mode === 15 ? (
            <p className="muted small" style={{ margin: 0 }}>
              {mode === 14 ? t('Die EC/TDS-Grenzen stellst du in der AC-Infinity-App ein. GrowDeck schaltet hier nur den Modus.')
                : t('Der Port schaltet, sobald der Wassermelder Wasser erkennt.')}
            </p>
          ) : null}
          {mode === 1 || mode === 2 ? (
            <p className="muted small" style={{ margin: 0 }}>
              {mode === 2 ? t('Der Port läuft dauerhaft mit der Stufe bei An.') : t('Der Port ist aus (oder läuft mit der Stufe bei Aus).')}
            </p>
          ) : null}
        </div>
      )}
    </Modal>
  )
}

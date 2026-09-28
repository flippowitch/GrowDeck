import { useState } from 'react'
import Icon from './Icon.jsx'
import { LevelSlider, NumberInput, Segmented, Toggle } from './ui.jsx'
import { sendCommand, useStore } from '../store.js'
import { fmt } from '../format.js'
import { sliderLock } from '../controlLock.js'
import { t } from '../i18n.js'

const ICONS = {
  light: 'light',
  exhaust_fan: 'exhaust_fan',
  circulation_fan: 'circulation_fan',
  outlet: 'outlet',
  heater: 'heater',
  humidifier: 'humidifier',
  dehumidifier: 'dehumidifier',
  air_conditioner: 'air_conditioner',
  switch: 'switch',
  select: 'select',
}

const TONE = { light: 'light', heater: 'heater', air_conditioner: 'cold', dehumidifier: 'cold' }

// level_unit the server sends for fans with steps (compared only, never shown)
const STEPS = 'Stufe' // i18n-ignore

export function levelText(control, value = control.level) {
  if (value == null) return ''
  if (control.level_unit === STEPS) return t('Stufe {level}/{max}', { level: fmt(value, 0), max: fmt(control.level_max, 0) })
  return `${fmt(value, 0)} ${control.level_unit || ''}`.trim()
}

export function controlSummary(control) {
  const parts = []
  if (control.type === 'select') {
    const option = control.options.find((o) => o.key === control.value)
    parts.push(option ? t(option.label) : control.value === 'custom' ? t('Eigenes Programm') : t('Unbekannt'))
    return parts.join(', ')
  }
  if (control.on != null) parts.push(control.on ? t('Ein') : t('Aus'))
  if (control.on && control.features.includes('level') && control.level != null) {
    parts.push(control.extra?.natural_wind ? t('Natürlicher Wind')
      : levelText(control, control.extra?.current_level ?? control.level))
  }
  if (control.type === 'air_conditioner') {
    const fn = control.options.find((o) => o.key === control.value)
    if (fn) parts.push(t(fn.label))
    if (control.extra?.target_temp != null) parts.push(t('Ziel {value}', { value: `${fmt(control.extra.target_temp, 1)} °C` }))
  }
  if (control.type === 'humidifier' && control.mode === '1' && control.extra?.target_humi != null) {
    parts.push(t('Ziel {value}', { value: `${fmt(control.extra.target_humi, 0)} %` }))
  }
  if (control.type === 'heater' && control.mode === '1' && control.extra?.target_temp != null) {
    parts.push(t('Ziel {value}', { value: `${fmt(control.extra.target_temp, 1)} °C` }))
  }
  if (control.type === 'dehumidifier' && control.extra?.target_humi != null) {
    parts.push(t('Ziel {value}', { value: `${fmt(control.extra.target_humi, 0)} %` }))
  }
  // server mode labels, compared before translating
  const redundant = (control.mode_label === 'Aus' && !control.on) || (control.mode_label === 'An' && control.on) // i18n-ignore
  if (control.mode_label && !redundant) parts.push(t(control.mode_label))
  return parts.join(', ')
}

function TargetInput({ label, unit, value, step, min, max, onSave, disabled }) {
  const [draft, setDraft] = useState(null)
  const shown = draft ?? value
  const save = () => {
    if (draft != null && draft !== value) onSave(draft)
    setDraft(null)
  }
  return (
    <label className="row small" style={{ gap: 8 }}>
      <span className="muted">{label}</span>
      <NumberInput
        className="input narrow"
        value={shown}
        step={step}
        min={min}
        max={max}
        disabled={disabled}
        onChange={setDraft}
        onBlur={save}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        aria-label={label}
        style={{ minHeight: 34, width: 96 }}
      />
      <span className="muted">{unit}</span>
    </label>
  )
}

// Level of a control as a share of its range, for the bar in the read-only view.
function levelShare(control) {
  const lo = Number(control.level_min ?? 0)
  const hi = Number(control.level_max ?? 100)
  const value = control.extra?.current_level ?? control.level
  if (value == null || !(hi > lo)) return null
  return Math.max(0, Math.min(1, (Number(value) - lo) / (hi - lo)))
}

// One output of a device. `readOnly` shows its state without anything to operate (overview);
// changes happen in the device details.
export default function ControlRow({ device, control, detail = false, readOnly = false, onEdit, onRename }) {
  const [busy, setBusy] = useState(false)
  const roomControl = useStore((s) => s.roomControl)
  const features = new Set(control.features || [])
  const disabled = !device.online || busy
  const extra = control.extra || {}
  const lock = readOnly ? null : sliderLock(device, control, roomControl)

  const run = async (patch) => {
    setBusy(true)
    try {
      await sendCommand(device.id, control.id, patch)
    } catch {
      /* toast already shown */
    } finally {
      setBusy(false)
    }
  }

  const tone = TONE[control.type] || ''
  const sliderTone = control.type === 'light' ? 'light' : ''
  const displayOnly = features.size === 0

  if (readOnly) {
    const share = features.has('level') && control.on && !extra.natural_wind ? levelShare(control) : null
    return (
      <div className={`ctl ${device.online ? '' : 'offline'}`}>
        <div className="ctl-top">
          <span className={`ctl-icon ${control.on ? 'on' : ''} ${tone}`}>
            <Icon name={ICONS[control.type] || 'switch'} size={19} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="ctl-name" title={t(control.label)}>{t(control.label)}</div>
            <div className="ctl-state">{controlSummary(control) || (displayOnly ? t('Nur Anzeige') : '')}</div>
          </div>
        </div>
        {share != null ? (
          <div className={`ctl-meter ${sliderTone}`} aria-hidden="true"><span style={{ width: `${share * 100}%` }} /></div>
        ) : null}
        {control.note ? <div className="ctl-note">{t(control.note)}</div> : null}
      </div>
    )
  }

  return (
    <div className={`ctl ${device.online ? '' : 'offline'}`}>
      <div className="ctl-top">
        <span className={`ctl-icon ${control.on ? 'on' : ''} ${tone}`}>
          <Icon name={ICONS[control.type] || 'switch'} size={19} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="ctl-name" title={t(control.label)}>{t(control.label)}</div>
          <div className="ctl-state">{controlSummary(control) || (displayOnly ? t('Nur Anzeige') : '')}</div>
        </div>
        {features.has('on_off') ? (
          <Toggle
            checked={!!control.on}
            tone={control.type === 'light' ? 'light' : ''}
            label={control.on ? t('{name} ausschalten', { name: t(control.label) }) : t('{name} einschalten', { name: t(control.label) })}
            disabled={disabled}
            busy={busy}
            onChange={(on) => run({ on })}
          />
        ) : control.type === 'select' && features.has('option') ? (
          <select
            className="input"
            style={{ width: 'auto', minHeight: 34 }}
            value={control.value ?? ''}
            disabled={disabled}
            aria-label={t(control.label)}
            onChange={(e) => run({ option: e.target.value })}
          >
            {control.value === 'custom' ? <option value="custom">{t('Eigenes Programm')}</option> : null}
            {control.options.map((o) => (
              <option key={o.key} value={o.key}>{t(o.label)}</option>
            ))}
          </select>
        ) : null}
      </div>

      {features.has('level') && extra.level_caption ? <span className="small muted">{t(extra.level_caption)}</span> : null}
      {features.has('level') ? (
        <LevelSlider
          value={control.level}
          min={control.level_min}
          max={control.level_max}
          step={control.level_step || 1}
          values={control.level_values}
          tone={sliderTone}
          disabled={disabled || !!lock}
          label={lock ? t('{name} Stufe (gesperrt)', { name: t(control.label) }) : t('{name} Stufe', { name: t(control.label) })}
          format={(v) => (control.level_unit === STEPS ? `${fmt(v, 0)}/${fmt(control.level_max, 0)}` : fmt(v, 0))}
          unit={control.level_unit === STEPS ? '' : control.level_unit}
          onCommit={(level) => run({ level })}
        />
      ) : null}
      {lock && (features.has('level') || (detail && features.has('spectrum'))) ? (
        <div className="ctl-lock"><Icon name="lock" size={14} /><span>{lock.text}</span></div>
      ) : null}

      {features.has('option') && control.type !== 'select' ? (
        <label className="row small">
          <span className="muted">{t('Betriebsart')}</span>
          <select
            className="input"
            style={{ width: 'auto' }}
            value={control.value ?? ''}
            disabled={disabled}
            onChange={(e) => run({ option: e.target.value })}
          >
            {control.value == null ? <option value="">{t('Bitte wählen')}</option> : null}
            {control.options.map((o) => (
              <option key={o.key} value={o.key}>{t(o.label)}</option>
            ))}
          </select>
        </label>
      ) : null}

      {detail && features.has('mode') && control.modes?.length > 1 ? (
        <label className="row small">
          <span className="muted">{t('Modus')}</span>
          <select
            className="input"
            style={{ width: 'auto' }}
            value={control.mode ?? ''}
            disabled={disabled}
            onChange={(e) => run({ mode: e.target.value })}
          >
            {control.mode != null && !control.modes.some((m) => m.key === control.mode) ? (
              <option value={control.mode}>{control.mode_label ? t(control.mode_label) : t('Modus {mode}', { mode: control.mode })}</option>
            ) : null}
            {control.mode == null ? <option value="">{t('Unbekannt')}</option> : null}
            {control.modes.map((m) => (
              <option key={m.key} value={m.key}>{t(m.label)}</option>
            ))}
          </select>
        </label>
      ) : null}

      {detail && (features.has('natural_wind') || features.has('oscillate') || features.has('night_mode') || extra.close_co2 !== undefined) ? (
        <div className="ctl-extras">
          {features.has('natural_wind') ? (
            <button type="button" className="pill-toggle" aria-pressed={!!extra.natural_wind} disabled={disabled}
              onClick={() => run({ natural_wind: !extra.natural_wind })}>{t('Natürlicher Wind')}</button>
          ) : null}
          {features.has('oscillate') ? (
            <button type="button" className="pill-toggle" aria-pressed={!!extra.oscillate} disabled={disabled}
              onClick={() => run({ oscillate: !extra.oscillate })}>{t('Schwenken')}</button>
          ) : null}
          {features.has('night_mode') ? (
            <button type="button" className="pill-toggle" aria-pressed={!!extra.night_mode} disabled={disabled}
              onClick={() => run({ night_mode: !extra.night_mode })}>{t('Nachtmodus')}</button>
          ) : null}
          {extra.close_co2 !== undefined ? (
            <button type="button" className="pill-toggle" aria-pressed={!!extra.close_co2} disabled={disabled}
              onClick={() => run({ close_co2: !extra.close_co2 })}>{t('Aus bei CO₂-Zugabe')}</button>
          ) : null}
        </div>
      ) : null}

      {detail && features.has('spectrum') && extra.spectrum != null ? (
        <div>
          <span className="small muted">{t('Spektrum')}</span>
          <LevelSlider value={extra.spectrum} min={0} max={100} step={1} unit="%" disabled={disabled || !!lock}
            label={lock ? t('{name} Spektrum (gesperrt)', { name: t(control.label) }) : t('{name} Spektrum', { name: t(control.label) })} onCommit={(spectrum) => run({ spectrum })} />
        </div>
      ) : null}

      {detail && (features.has('target_temp') || features.has('target_humi')) ? (
        <div className="row" style={{ gap: 16 }}>
          {features.has('target_temp') ? (
            <TargetInput label={t('Zieltemperatur')} unit="°C" step={0.5} min={10} max={40} value={extra.target_temp}
              disabled={disabled} onSave={(v) => run({ target_temp: v })} />
          ) : null}
          {features.has('target_humi') ? (
            <TargetInput label={t('Zielfeuchte')} unit="%" step={1} min={20} max={95} value={extra.target_humi}
              disabled={disabled} onSave={(v) => run({ target_humi: v })} />
          ) : null}
        </div>
      ) : null}

      {detail && features.has('fan_level') ? (
        <div className="row small">
          <span className="muted">{t('Lüfter')}</span>
          <Segmented
            label={t('Lüfterstufe')}
            value={extra.fan_level || 'standard'}
            options={[{ key: 'quiet', label: t('Leise') }, { key: 'standard', label: t('Standard') }]}
            onChange={(fan_level) => run({ fan_level })}
          />
        </div>
      ) : null}

      {control.note ? <div className="ctl-note">{t(control.note)}</div> : null}

      {detail && (onEdit || onRename) ? (
        <div className="row">
          {onEdit ? onEdit(control) : null}
          {onRename ? (
            <button type="button" className="btn ghost small" onClick={() => onRename(control)}>{t('Umbenennen')}</button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

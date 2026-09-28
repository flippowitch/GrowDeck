// Shared selects and texts for rules and alarms.
import { fmt } from '../format.js'
import { LOCALE, t } from '../i18n.js'
import { levelText } from './ControlRow.jsx'

const DAY_NAMES = [t('Mo'), t('Di'), t('Mi'), t('Do'), t('Fr'), t('Sa'), t('So')]

export function sortedDevices(devices) {
  return Object.values(devices).sort((a, b) => a.name.localeCompare(b.name, LOCALE))
}

// Sensor name with its group ("Temperatur (Zelt)") in the language of the page.
export function sensorLabel(sensor) {
  return sensor.group ? `${t(sensor.label)} (${t(sensor.group)})` : t(sensor.label)
}

export function SensorSelect({ devices, value, onChange, kinds }) {
  const list = sortedDevices(devices).filter((d) => d.sensors.some((s) => !kinds || kinds.includes(s.kind)))
  return (
    <select className="input" value={value || ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t('Sensor wählen')}</option>
      {list.map((d) => (
        <optgroup key={d.id} label={d.name}>
          {d.sensors
            .filter((s) => !kinds || kinds.includes(s.kind))
            .map((s) => (
              <option key={s.key} value={`${d.id}|${s.key}`}>
                {sensorLabel(s)}: {fmt(s.value, s.kind === 'vpd' ? 2 : 1)} {s.unit}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  )
}

export function OutputSelect({ devices, value, onChange }) {
  const list = sortedDevices(devices).filter((d) => d.controls.some((c) => c.features.length))
  return (
    <select className="input" value={value || ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t('Ausgang wählen')}</option>
      {list.map((d) => (
        <optgroup key={d.id} label={d.name}>
          {d.controls
            .filter((c) => c.features.length)
            .map((c) => (
              <option key={c.id} value={`${d.id}|${c.id}`}>{t(c.label)}</option>
            ))}
        </optgroup>
      ))}
    </select>
  )
}

export function findSensor(devices, deviceId, key) {
  const device = devices[deviceId]
  return { device, sensor: device?.sensors.find((s) => s.key === key) }
}

export function findControl(devices, deviceId, controlId) {
  const device = devices[deviceId]
  return { device, control: device?.controls.find((c) => c.id === controlId) }
}

export function actionText(action, control) {
  if (!action) return t('nichts')
  const parts = []
  if (action.on === true) parts.push(t('ein'))
  if (action.on === false) parts.push(t('aus'))
  if (action.level != null) parts.push(control ? levelText(control, action.level) : t('Stufe {level}', { level: fmt(action.level, 0) }))
  if (action.mode != null) {
    const mode = control?.modes?.find((m) => m.key === String(action.mode))
    parts.push(t('Modus {mode}', { mode: mode ? t(mode.label) : action.mode }))
  }
  if (action.option != null) {
    const option = control?.options?.find((o) => o.key === String(action.option))
    parts.push(option ? t(option.label) : action.option)
  }
  return parts.join(', ') || t('nichts')
}

export function daysText(days) {
  if (!days || days.length === 7) return t('täglich')
  if (days.length === 0) return t('nie')
  return days.map((d) => DAY_NAMES[d]).join(', ')
}

// "Abluft von Zelt-Controller": an output or sensor together with its device.
function ofDevice(label, device) {
  return t('{name} von {device}', { name: label, device: device.name })
}

export function describeRule(rule, devices) {
  const trig = rule.trigger || {}
  let when
  if (trig.type === 'threshold') {
    const { device, sensor } = findSensor(devices, trig.device_id, trig.sensor)
    const unit = sensor?.unit ? ` ${sensor.unit}` : ''
    const vars = {
      name: device ? ofDevice(sensor ? sensorLabel(sensor) : trig.sensor, device) : t('Unbekannter Sensor'),
      value: `${fmt(Number(trig.value), 1)}${unit}`,
    }
    if (trig.night_value != null && trig.night_value !== '') {
      vars.night = `${fmt(Number(trig.night_value), 1)}${unit}`
      when = trig.op === 'above' ? t('Wenn {name} über {value} (nachts {night})', vars) : t('Wenn {name} unter {value} (nachts {night})', vars)
    } else {
      when = trig.op === 'above' ? t('Wenn {name} über {value}', vars) : t('Wenn {name} unter {value}', vars)
    }
  } else if (trig.type === 'schedule') {
    when = `${daysText(trig.days)} ${trig.start}–${trig.end}`
  } else if (trig.type === 'device_state') {
    const { device, control } = findControl(devices, trig.device_id, trig.control_id)
    if (device) {
      const name = ofDevice(control?.label ? t(control.label) : trig.control_id, device)
      when = trig.state === 'off' ? t('Wenn {name} aus ist', { name }) : t('Wenn {name} läuft', { name })
    } else {
      when = t('Wenn ein unbekannter Ausgang schaltet')
    }
  } else if (trig.type === 'cycle') {
    const vars = { on: fmt(Number(trig.on_minutes), 0), off: fmt(Number(trig.off_minutes), 0), start: trig.start, end: trig.end }
    when = trig.start && trig.end ? t('{on} min an, {off} min aus zwischen {start} und {end}', vars) : t('{on} min an, {off} min aus', vars)
  } else {
    when = t('Unbekannte Bedingung')
  }
  const { device, control } = findControl(devices, rule.target?.device_id, rule.target?.control_id)
  const target = device ? ofDevice(control?.label ? t(control.label) : rule.target.control_id, device) : t('unbekannter Ausgang')
  const action = actionText(rule.active_action, control)
  const then = rule.inactive_action
    ? t('{target} {action}, sonst {other}', { target, action, other: actionText(rule.inactive_action, control) })
    : `${target} ${action}`
  return { when, then }
}

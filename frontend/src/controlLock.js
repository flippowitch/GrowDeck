// Whether a control's sliders may be moved by hand right now. They are locked while
// something automatic owns the value: the device runs its own program (schedule, cycle,
// auto, VPD …) or the room control sets the level of this output. A command from GrowDeck
// would only be overwritten a moment later.
import { t } from './i18n.js'

// Mode keys in which a device simply does what it is told. AC Infinity: "Aus" and "An";
// Spider Farmer and Vivosun: "Manuell".
const MANUAL_MODES = { acinfinity: new Set(['1', '2']) }
const DEFAULT_MANUAL = new Set(['0'])
// roles of the room control that set a level (exhaust by demand, circulation by day/night)
const LEVEL_ROLES = new Set(['exhaust', 'circulation'])

export function isManual(device, control) {
  if (!(control.features || []).includes('mode') || control.mode == null) return true
  return (MANUAL_MODES[device.vendor] || DEFAULT_MANUAL).has(String(control.mode))
}

// Name of the mode to switch to, in the language of the page.
export function manualModeLabel(device, control) {
  if (device.vendor === 'acinfinity') {
    const label = (control.modes || []).find((m) => m.key === '2')?.label
    return label ? t(label) : t('An')
  }
  const label = (control.modes || []).find((m) => m.key === '0')?.label
  return label ? t(label) : t('Manuell')
}

// The enabled room control that has this output assigned, if any.
export function roomControlOf(device, control, roomControl) {
  for (const status of Object.values(roomControl || {})) {
    if (!status?.enabled) continue
    const output = (status.outputs || []).find((o) => o.device_id === device.id && o.control_id === control.id)
    if (output) return { status, output }
  }
  return null
}

// null = free to move; otherwise {by: 'room' | 'mode', text} with the reason in words.
export function sliderLock(device, control, roomControl) {
  const rc = roomControlOf(device, control, roomControl)
  if (rc && LEVEL_ROLES.has(rc.output.role) && (control.features || []).includes('level')) {
    return {
      by: 'room',
      text: rc.status.plan_source ? t('Die Zeltsteuerung regelt die Stufe nach dem Growplan.') : t('Die Zeltsteuerung regelt die Stufe.'),
    }
  }
  if (!isManual(device, control)) {
    return {
      by: 'mode',
      text: t('Läuft im Modus „{mode}“. Zum Verstellen auf „{manual}“ umstellen.', {
        mode: control.mode_label ? t(control.mode_label) : t('Automatik'),
        manual: manualModeLabel(device, control),
      }),
    }
  }
  return null
}

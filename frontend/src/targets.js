// Climate targets of a tent and how measured values compare with them.
// The targets come from the tent's Growplan (the ranges of this week), else from the room
// control (what it regulates), else from the default VPD band of the room's phase.
import { fmt, fmtBand, hhmmToMinutes } from './format.js'
import { planBands } from './growplan/engine.js'
import { t } from './i18n.js'

const whole = (v) => Math.abs(v - Math.round(v)) < 1e-9

export const METRICS = {
  temp: { label: t('Temperatur'), unit: '°C', words: [t('zu kühl'), t('zu warm')], margin: () => 1, text: (v) => fmt(v, whole(v) ? 0 : 1) },
  humi: { label: t('Luftfeuchte'), unit: '%', words: [t('zu trocken'), t('zu feucht')], margin: () => 5, text: (v) => fmt(v, 0) },
  vpd: { label: 'VPD', unit: 'kPa', words: [t('zu feucht'), t('zu trocken')], margin: () => 0.15, text: fmtBand },
  ppfd: { label: 'PPFD', unit: 'µmol', words: [t('zu wenig'), t('zu viel')], margin: (band) => band[0] * 0.1, text: (v) => fmt(v, 0) },
}

const around = (v, tolerance) => [Math.round((v - tolerance) * 1000) / 1000, Math.round((v + tolerance) * 1000) / 1000]
export const sameBand = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1]

export function rangeText(key, band, withUnit = false) {
  const m = METRICS[key]
  return `${m.text(band[0])}–${m.text(band[1])}${withUnit ? ` ${m.unit}` : ''}`
}

// "Tag 22–26, Nacht 18–21 °C" or "45–55 %"
export function pairText(key, pair) {
  if (sameBand(pair.day, pair.night) || !pair.night) return rangeText(key, pair.day, true)
  if (!pair.day) return t('Nacht {range}', { range: rangeText(key, pair.night, true) })
  return t('Tag {day}, Nacht {night}', { day: rangeText(key, pair.day), night: rangeText(key, pair.night, true) })
}

// Where a value stands: tone for the color and words so the state never depends on color.
// Inside the band = good, a little outside = warn, further outside = bad.
export function judge(key, value, band) {
  if (value == null || !band) return null
  const m = METRICS[key]
  if (value >= band[0] - 1e-9 && value <= band[1] + 1e-9) return { tone: 'good', inside: true, word: '' }
  const margin = m.margin(band)
  const near = value >= band[0] - margin && value <= band[1] + margin
  return { tone: near ? 'warn' : 'bad', inside: false, word: value < band[0] ? m.words[0] : m.words[1] }
}

export function isDayNow(room, control, nowMs) {
  // the room control knows best (light outputs or its day window on the NAS)
  if (control?.enabled && typeof control.day === 'boolean') return control.day
  const a = hhmmToMinutes(room.day_start || '06:00')
  const b = hhmmToMinutes(room.day_end || '00:00')
  if (a === b) return true
  const d = new Date(nowMs)
  const minute = d.getHours() * 60 + d.getMinutes()
  return a < b ? minute >= a && minute < b : minute >= a || minute < b
}

export function lightHours(room) {
  const a = hhmmToMinutes(room.day_start || '06:00')
  const b = hhmmToMinutes(room.day_end || '00:00')
  return a === b ? 24 : Math.round((((b - a + 1440) % 1440) / 60) * 10) / 10
}

export const ratioText = (h) => `${fmt(h, whole(h) ? 0 : 1)}/${fmt(24 - h, whole(24 - h) ? 0 : 1)}`

// Day and night bands per metric ({day, night} or null; ppfd = one band for the day).
export function tentTargets({ gp, control, stage, today }) {
  const stageVpd = stage?.band ? { day: stage.band, night: stage.band } : null
  if (gp) {
    const b = planBands(gp.data, today)
    return { source: 'growplan', plan: b, temp: b.temp, humi: b.humi, vpd: b.vpd, ppfd: b.ppfd, vpdFromStage: false }
  }
  const rc = control?.enabled ? control.plan : null
  if (rc) {
    const pair = (p) => ({ day: around(p.day, p.tolerance), night: around(p.night, p.tolerance) })
    const byVpd = rc.humidity_mode === 'vpd'
    return {
      source: 'control',
      temp: pair(rc.temp),
      humi: byVpd ? null : pair(rc.humi),
      vpd: byVpd ? pair(rc.vpd) : stageVpd,
      ppfd: null,
      vpdFromStage: !byVpd && !!stageVpd,
    }
  }
  return { source: 'stage', temp: null, humi: null, vpd: stageVpd, ppfd: null, vpdFromStage: !!stageVpd }
}

// Where the targets come from, for the legend under the charts.
export function targetLegend(targets, stage, implicit) {
  const stageNote = implicit
    ? t('Richtwert für {stage}, Standard ohne Raum', { stage: stage.label })
    : t('Richtwert für {stage}', { stage: stage.label })
  if (targets.source === 'growplan') {
    const p = targets.plan
    const week = p.phase === 'seed' ? t('Anzucht') : t('Woche {n}', { n: p.week })
    const vars = { stage: t(p.stage_name), week }
    if (!p.leaf_offset) return t('Zielbereiche aus dem Growplan ({stage}, {week})', vars)
    return t('Zielbereiche aus dem Growplan ({stage}, {week}); VPD für die Luft umgerechnet, Blatt {offset} K kühler', {
      ...vars, offset: fmt(p.leaf_offset, whole(p.leaf_offset) ? 0 : 1),
    })
  }
  if (targets.source === 'control') {
    return targets.vpdFromStage ? t('Zielbereiche der Zeltsteuerung; VPD: {note}', { note: stageNote }) : t('Zielbereiche der Zeltsteuerung')
  }
  return targets.vpd ? t('VPD-Zielbereich: {note}', { note: stageNote }) : ''
}

// Targets of an active room control that has its own values and misses the Growplan's ranges.
export function controlDeviations(control, targets) {
  if (!control?.enabled || control.plan_source || targets.source !== 'growplan' || !control.plan) return []
  const rc = control.plan
  const out = []
  const check = (key, phase, value) => {
    const band = targets[key]?.[phase]
    if (value == null || !band) return
    if (value < band[0] - 1e-9 || value > band[1] + 1e-9) out.push({ key, phase, value, band })
  }
  const key = rc.humidity_mode === 'vpd' ? 'vpd' : 'humi'
  for (const k of ['temp', key]) {
    check(k, 'day', rc[k]?.day)
    check(k, 'night', rc[k]?.night)
  }
  // the same miss by day and night is one line
  return out.filter((d, i) => !(d.phase === 'night' && out.some((o, j) => j < i && o.key === d.key && o.value === d.value && sameBand(o.band, d.band))))
    .map((d) => (d.phase === 'day' && out.some((o) => o.phase === 'night' && o.key === d.key && o.value === d.value && sameBand(o.band, d.band))
      ? { ...d, phase: null } : d))
}

export function deviationText(d) {
  const m = METRICS[d.key]
  const vars = { label: m.label, value: m.text(d.value), range: rangeText(d.key, d.band, true) }
  if (d.phase === 'day') return t('{label} Tag {value} statt {range}', vars)
  if (d.phase === 'night') return t('{label} Nacht {value} statt {range}', vars)
  return t('{label} {value} statt {range}', vars)
}

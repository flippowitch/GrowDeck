// Number, unit and time formatting in the language of the page (German or English,
// undefined if the browser lacks the locale data).
import { LOCALE, t } from './i18n.js'

export { LOCALE }

const nf = {}
function numberFormat(digits) {
  if (!nf[digits]) {
    nf[digits] = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits })
  }
  return nf[digits]
}

export const DIGITS = {
  temp: 1, humi: 0, vpd: 2, co2: 0, ppfd: 0, soil_temp: 1, soil_moisture: 0, soil_ec: 2,
  water: 0, rssi: 0, other: 1, light: 0, ph: 1, ec: 2, tds: 0, leak: 0,
}

export function fmt(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return '–'
  return numberFormat(digits).format(value)
}

// VPD band edges: one decimal where enough (0,8), two where needed (1,05)
export function fmtBand(value) {
  const n = Math.round(value * 100) / 100
  return fmt(n, Number.isInteger(Math.round(n * 100) / 10) ? 1 : 2)
}

export function fmtSensor(sensor) {
  if (!sensor) return '–'
  return fmt(sensor.value, DIGITS[sensor.kind] ?? 1)
}

export function unitLabel(unit) {
  return unit || ''
}

export function timeAgo(ts, offsetMs = 0) {
  if (!ts) return t('nie')
  const seconds = Math.max(0, (Date.now() + offsetMs) / 1000 - ts)
  if (seconds < 45) return t('gerade eben')
  if (seconds < 3600) return t('vor {n} min', { n: Math.round(seconds / 60) })
  if (seconds < 86400) return t('vor {n} h', { n: Math.round(seconds / 3600) })
  return t('vor {n} Tagen', { n: Math.round(seconds / 86400) })
}

export function clock(ts) {
  return new Date(ts * 1000).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })
}

export function dateTime(ts) {
  return new Date(ts * 1000).toLocaleString(LOCALE, {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

export function duration(seconds) {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h >= 48) return t('{n} Tage', { n: Math.floor(h / 24) })
  if (h > 0) return `${h} h ${m} min`
  return `${m} min`
}

// "06:30" <-> minutes / seconds
export function hhmmToMinutes(text) {
  const [h, m] = String(text || '0:0').split(':').map((x) => parseInt(x, 10) || 0)
  return (h % 24) * 60 + (m % 60)
}
export function minutesToHhmm(min) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}
export function secondsToHhmm(sec) {
  if (sec === 86400) return '24:00'
  return minutesToHhmm(Math.round((sec || 0) / 60))
}
export function hhmmToSeconds(text) {
  if (text === '24:00') return 86400
  return hhmmToMinutes(text) * 60
}

export const VENDORS = { spiderfarmer: 'Spider Farmer', vivosun: 'Vivosun', acinfinity: 'AC Infinity' }

export const STAGES = {
  clone: { label: t('Stecklinge'), band: [0.4, 0.8] },
  veg: { label: t('Wachstum'), band: [0.8, 1.2] },
  flower: { label: t('Blüte'), band: [1.2, 1.6] },
  late: { label: t('Späte Blüte'), band: [1.4, 1.8] },
  dry: { label: t('Trocknung'), band: null },
}

export function vpd(tempC, rh, leafOffset = 0) {
  if (tempC == null || rh == null) return null
  const leaf = tempC - leafOffset
  const svpLeaf = 0.6108 * Math.exp((17.27 * leaf) / (leaf + 237.3))
  const svpAir = 0.6108 * Math.exp((17.27 * tempC) / (tempC + 237.3))
  return Math.max(0, svpLeaf - (svpAir * rh) / 100)
}

export const SENSOR_TITLES = {
  temp: t('Temperatur'), humi: t('Luftfeuchte'), vpd: 'VPD', co2: 'CO₂', ppfd: 'PPFD',
  soil_temp: t('Bodentemperatur'), soil_moisture: t('Bodenfeuchte'), soil_ec: t('Boden-EC'),
  water: t('Wasserstand'), rssi: t('WLAN-Signal'), other: t('Weitere Messwerte'),
  light: t('Licht'), ph: t('pH-Wert'), ec: 'EC', tds: 'TDS', leak: t('Wassermelder'),
}

export function sensorText(sensor) {
  if (sensor.kind === 'leak') return sensor.value == null ? '–' : sensor.value ? t('Wasser!') : t('trocken')
  return null
}

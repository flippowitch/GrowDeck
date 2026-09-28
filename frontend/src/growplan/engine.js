// Growplan engine: the rules of the Growplan app as pure functions.
// Everything the app kept in one global settings object is passed in explicitly:
// `plan` = settings of one grow (per tent), `lib` = shared library (own schedules,
// adjusted built-in schedules, checklist).
import { LOCALE } from '../format.js'
import { dec, t } from '../i18n.js'
import {
  ADDITIVES, BUILTIN, CHECK_DEFAULT, COLORS, ENV, F, LAMP_DEFAULT, PHASE_LBL, PH_MEDIUM, P, TYPE_LBL, Z,
} from './data.js'

// ------------------------------------------------------------ formatting
export function num(x, d = 1) {
  const p = 10 ** d
  return dec(String(Math.round(x * p) / p))
}
export const f1 = (x) => dec(x.toFixed(1))
export const f2 = (x) => dec(x.toFixed(2))
export const fV = (x) => (Math.round(x * 100) % 10 === 0 ? f1(x) : f2(x))
export const rng = (a, u) => `${num(a[0])}–${num(a[1])}${u ? ` ${u}` : ''}`
export const rngV = (a, u) => `${fV(a[0])}–${fV(a[1])}${u ? ` ${u}` : ''}`
export const fmtInt = (v) => Math.round(v).toLocaleString(LOCALE)
export function parseNum(v) {
  if (v == null) return null
  const text = String(v).trim().replace(/\s/g, '').replace(',', '.')
  if (text === '') return null
  const n = parseFloat(text)
  return Number.isNaN(n) ? null : n
}
// numbers for input fields; parseNum accepts both "," and "."
export const numIn = (v) => (v == null ? '' : dec(String(v)))
export function clampInt(v, lo, hi, def) {
  const n = parseInt(v, 10)
  if (Number.isNaN(n)) return def
  return Math.max(lo, Math.min(hi, n))
}
export function roundTo(x, dec) {
  const p = 10 ** dec
  return Math.round(x * p) / p
}
export const mid = (a) => (a[0] + a[1]) / 2
export const clone = (o) => JSON.parse(JSON.stringify(o))
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
export const unitOf = (p) => (p.u === 'g' ? 'g' : 'ml')

// ----------------------------------------------------------------- dates
const pad2 = (n) => (n < 10 ? '0' : '') + n
export function todayISO(now = new Date()) {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
}
export const isISO = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(dayNumber(v))
function dayNumber(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  return Date.UTC(y, m - 1, d) / 86400000
}
// whole days from a to b, independent of daylight saving time
export const daysBetween = (a, b) => dayNumber(b) - dayNumber(a)
export function addDays(iso, days) {
  const d = new Date(dayNumber(iso) * 86400000 + days * 86400000)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}
export const dateObj = (iso) => new Date(`${iso}T12:00:00`)
export function fmtDate(iso, opt) {
  const d = dateObj(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(LOCALE, opt || { weekday: 'short', day: '2-digit', month: '2-digit' })
}
export function agoText(iso, today) {
  const d = daysBetween(iso, today)
  if (d <= 0) return d < 0 ? t('geplant') : t('heute')
  if (d === 1) return t('gestern')
  return t('vor {n} Tagen', { n: d })
}

// ------------------------------------------------------------- schedules
export const allScheds = (lib) => BUILTIN.map((b) => lib?.ovr?.[b.id] || b).concat(lib?.custom || [])
export const schedById = (lib, id) => allScheds(lib).find((s) => s.id === id) || null
export const currentSched = (lib, plan) => schedById(lib, plan.sched) || BUILTIN[0]
export const isBuiltin = (id) => BUILTIN.some((b) => b.id === id)
export const schedLabel = (s) => t(s.name) + (s.adjusted ? ` · ${t('angepasst')}` : '')
export function isHidden(plan, s, name) {
  const h = plan.hidden?.[s.id]
  return !!(h && h.indexOf(name) >= 0)
}
export const hasMissing = (s) => s.products.some((p) => (p.v || []).concat(p.b || []).some((v) => v < 0))

// Column of the schedule for a week of the plan: longer or shorter bloom phases are
// mapped onto the schedule's weeks (hold the middle, keep the end), as in the app.
export function colFor(s, phase, week, floWeeks) {
  if (phase === 'seed') return s.seed === 'water' ? { water: true, seed: true } : { ph: 'v', i: 0, seed: true }
  if (phase === 'veg') return { ph: 'v', i: Math.max(1, Math.min(week, s.vegN)) - 1 }
  const N = floWeeks
  const fl = s.flushN || 0
  const Fu = N - fl
  const Fn = s.bloomN - fl
  let i
  if (week > Fu) return { ph: 'b', i: Fn + Math.min(week - Fu, fl) - 1, flush: true }
  if (Fu === Fn) i = week
  else if (Fu > Fn) {
    const hold = Math.max(1, Math.min(s.hold || Fn, Fn))
    const tail = Fn - hold
    if (week <= hold) i = week
    else if (week > Fu - tail) i = week - (Fu - Fn)
    else i = hold
  } else {
    i = Fu <= 1 ? 1 : Math.round(((week - 1) * (Fn - 1)) / (Fu - 1)) + 1
  }
  return { ph: 'b', i: i - 1 }
}
export function doseAt(p, c) {
  if (c.water) return 0
  const arr = c.ph === 'v' ? p.v : p.b
  const v = arr ? arr[c.i] : 0
  return v == null || Number.isNaN(v) ? 0 : v
}
export function rowAt(s, key, c) {
  const o = s[key]
  if (!o || c.water) return null
  const arr = c.ph === 'v' ? o.v : o.b
  if (!arr) return null
  const v = arr[c.i]
  return v == null || v === '' || v === 0 ? null : v
}
export function anyRow(s, key) {
  const o = s[key]
  if (!o) return false
  return (o.v || []).concat(o.b || []).some((v) => v != null && v !== '' && v !== 0)
}
export function mixFor(s, plan, phase, week) {
  const col = colFor(s, phase, week, plan.floWeeks)
  const items = []
  if (!col.water) {
    s.products.forEach((p) => {
      if (isHidden(plan, s, p.n)) return
      const v = doseAt(p, col)
      if (v !== 0) items.push({ p, v })
    })
  }
  return { col, items, water: items.length === 0 }
}
export function phTarget(s, medium) {
  if (s.phRange) return s.phRange
  if (s.organic && medium === 'erde') return [6.2, 6.5]
  return PH_MEDIUM[medium] || PH_MEDIUM.erde
}
export function prodColor(s, p) {
  if (p && p.c) return p.c
  const i = s.products.indexOf(p)
  return COLORS[(i < 0 ? 0 : i) % COLORS.length]
}
export function prodNames(lib) {
  const seen = new Set()
  const out = []
  ADDITIVES.concat(...allScheds(lib).map((s) => s.products.map((p) => p.n))).forEach((n) => {
    if (n && !seen.has(n)) {
      seen.add(n)
      out.push(n)
    }
  })
  return out
}
// weeks of the plan that use the same column of the schedule (week comments apply to all)
export function sameColWeeks(s, c, plan) {
  const out = []
  for (let i = 1; i <= plan.vegWeeks; i++) {
    const x = colFor(s, 'veg', i, plan.floWeeks)
    if (x.ph === c.ph && x.i === c.i) out.push(`W${i}`)
  }
  for (let i = 1; i <= plan.floWeeks; i++) {
    const x = colFor(s, 'flower', i, plan.floWeeks)
    if (x.ph === c.ph && x.i === c.i) out.push(`B${i}`)
  }
  return out
}

// schedule editor helpers
export function resize(a, n) {
  const out = (a || []).slice(0, n)
  while (out.length < n) out.push(0)
  return out
}
export function resizeS(a, n) {
  const out = (a || []).slice(0, n)
  while (out.length < n) out.push('')
  return out
}
export function ensureRows(d) {
  if (!d.ec || typeof d.ec !== 'object') d.ec = { v: [], b: [] }
  if (!d.notes || typeof d.notes !== 'object') d.notes = { v: [], b: [] }
  d.ec.v = resize(d.ec.v, d.vegN)
  d.ec.b = resize(d.ec.b, d.bloomN)
  d.notes.v = resizeS(d.notes.v, d.vegN)
  d.notes.b = resizeS(d.notes.b, d.bloomN)
}
export function newCustomFrom(base) {
  const c = clone(base)
  c.id = `c-${uid()}`
  c.custom = true
  // stored values stay German, they are translated where they are shown
  c.name = base.custom ? `${base.name} (Kopie)` : `${base.brand} ${base.name.replace(' (Vorlage)', '')}` // i18n-ignore
  c.brand = 'Eigenes Schema' // i18n-ignore
  delete c.tips
  delete c.adjusted
  c.src = `Eigene Werte, Ausgangsbasis: ${base.brand} ${base.name}.` // i18n-ignore
  c.products.forEach((p, i) => {
    if (!p.c) p.c = prodColor(base, base.products[i])
  })
  return c
}
export function newBlank() {
  return {
    id: `c-${uid()}`, custom: true, brand: 'Eigenes Schema', name: 'Mein Schema', medium: '', vegN: 4, bloomN: 8, // i18n-ignore
    flushN: 1, hold: 7, seed: 'veg1',
    products: [P('Basisdünger Wachstum', 'base', [1, 2, 3, 4], Z(8), ''), P('Basisdünger Blüte', 'base', Z(4), F(8, 2, 1, 7), '')], // i18n-ignore
    src: 'Eigene Werte.', // i18n-ignore
  }
}
export const newProduct = (name, vegN, bloomN) => P(name, 'add', Z(vegN), Z(bloomN), '')
export const cellIn = (v) => (v == null || v === 0 ? '' : v < 0 ? '?' : dec(String(v)))

// ------------------------------------------------------ phase, climate, light
export const maxWeek = (phase, plan) => (phase === 'seed' ? 2 : phase === 'veg' ? plan.vegWeeks : plan.floWeeks)
export function stageKey(phase, week, floWeeks) {
  if (phase === 'seed') return 'seed'
  if (phase === 'veg') return week <= 2 ? 'veg1' : 'veg2'
  if (week === floWeeks) return 'flush'
  if (week <= 2) return 'flo1'
  if (week <= floWeeks - 3) return 'flo2'
  return 'flo3'
}
export function envOf(plan, k) {
  const d = ENV[k]
  const o = plan.envOv?.[k] || {}
  const r = {}
  for (const f in d) r[f] = f in o ? o[f] : d[f]
  return r
}
export function envAdj(plan, k) {
  const o = plan.envOv?.[k]
  return !!(o && Object.keys(o).length)
}
export const phaseLabel = (ph, w) => (ph === 'seed' ? t('Anzucht') : t('{phase} · Woche {n}', { phase: PHASE_LBL[ph], n: w }))
export const lampEff = (plan) => (plan.lamp.ppf * plan.lamp.util) / 100
export function dimForPPFD(plan, ppfd) {
  const d = ((ppfd * plan.tent) / lampEff(plan)) * 100
  return Math.max(10, Math.min(100, Math.round(d / 5) * 5))
}
export const ppfdForDim = (plan, d) => Math.round((lampEff(plan) * (d / 100)) / plan.tent)
export const luxOf = (plan, ppfd) => ppfd * plan.lamp.luxF
export const luxR = (v) => Math.round(v / 100) * 100
export function klx(v) {
  const k = v / 1000
  return num(k, k < 10 ? 1 : 0)
}
export const klxRange = (plan, a) => `${klx(luxOf(plan, a[0]))}–${klx(luxOf(plan, a[1]))}`
export const luxRange = (plan, a) => `${fmtInt(luxR(luxOf(plan, a[0])))}–${fmtInt(luxR(luxOf(plan, a[1])))}`
export const shortLamp = (plan) => (plan.lamp.name === LAMP_DEFAULT.name ? 'G3000' : plan.lamp.name)
export const dli = (ppfd, h) => ppfd * h * 0.0036
export const svp = (t) => 0.61078 * Math.exp((17.27 * t) / (t + 237.3))
export const vpdOf = (tAir, rh, off) => svp(tAir - off) - (svp(tAir) * rh) / 100

// Phase and week from the start dates (Growplan's autoWeek); null = manual position.
export function autoPosition(plan, today) {
  if (isISO(plan.floStart) && today >= plan.floStart) {
    return { phase: 'flower', week: Math.max(1, Math.min(plan.floWeeks, Math.floor(daysBetween(plan.floStart, today) / 7) + 1)) }
  }
  if (isISO(plan.vegStart) && today >= plan.vegStart) {
    return { phase: 'veg', week: Math.max(1, Math.min(plan.vegWeeks, Math.floor(daysBetween(plan.vegStart, today) / 7) + 1)) }
  }
  return null
}
export function currentPosition(plan, today) {
  const auto = autoPosition(plan, today)
  return auto ? { ...auto, auto: true } : { phase: plan.phase, week: plan.week, auto: false }
}
export function stepPosition(pos, dir, plan) {
  let { phase, week } = pos
  if (dir < 0) {
    if (week > 1) week--
    else if (phase === 'flower') {
      phase = 'veg'
      week = plan.vegWeeks
    } else if (phase === 'veg') {
      phase = 'seed'
      week = 1
    }
  } else if (week < maxWeek(phase, plan)) week++
  else if (phase === 'seed') {
    phase = 'veg'
    week = 1
  } else if (phase === 'veg') {
    phase = 'flower'
    week = 1
  }
  return { phase, week }
}
export const harvestISO = (plan) => (isISO(plan.floStart) ? addDays(plan.floStart, plan.floWeeks * 7) : '')
export function harvestLabel(plan) {
  const iso = harvestISO(plan)
  return iso ? dateObj(iso).toLocaleDateString(LOCALE, { day: '2-digit', month: 'short' }) : ''
}
export function clampWeek(plan) {
  const next = { ...plan }
  if (next.phase === 'veg') next.week = Math.min(next.week, next.vegWeeks)
  else if (next.phase === 'flower') next.week = Math.min(next.week, next.floWeeks)
  if (!(next.week >= 1)) next.week = 1
  return next
}

// Room control targets for the current week (same rules as the backend). Growplan's VPD
// targets are leaf VPD; devices and room control work with the VPD of the air, so the
// day target is converted with the leaf offset of the VPD calculator. At night the leaf
// is about as warm as the air and the target follows from night temperature and humidity.
export function controlTargets(plan, today) {
  const pos = currentPosition(plan, today)
  const key = stageKey(pos.phase, pos.week, plan.floWeeks)
  const e = envOf(plan, key)
  const half = (r) => (r[1] - r[0]) / 2
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
  const humi = clamp(mid(e.rh), 20, 95)
  const leaf = Number(plan.leafOff) || 0
  const dayTemp = mid(e.tag)
  const dayVpd = mid(e.vpd) + svp(dayTemp) - svp(dayTemp - leaf)
  return {
    stage: key, stage_name: ENV[key].n, phase: pos.phase, week: pos.week, light_hours: e.h, leaf_offset: leaf, leaf_vpd: e.vpd,
    temp: { day: roundTo(clamp(mid(e.tag), 5, 40), 1), night: roundTo(clamp(mid(e.nacht), 5, 40), 1), tolerance: roundTo(clamp(Math.min(half(e.tag), half(e.nacht)), 0.2, 10), 1) },
    humi: { day: Math.round(humi), night: Math.round(humi), tolerance: Math.round(clamp(half(e.rh), 1, 30)) },
    vpd: { day: roundTo(clamp(dayVpd, 0.2, 3), 2), night: roundTo(clamp(svp(mid(e.nacht)) * (1 - mid(e.rh) / 100), 0.2, 3), 2), tolerance: roundTo(clamp(half(e.vpd), 0.02, 1), 2) },
  }
}

// Target ranges of the current week to compare with what the sensors in the tent measure.
// Temperature, humidity and PPFD as the plan states them. The leaf VPD targets become VPD of
// the air like for the room control: by day shifted by the leaf offset at the middle of the
// day temperature, at night the range around the VPD of night temperature and humidity.
export function planBands(plan, today) {
  const t = controlTargets(plan, today)
  const e = envOf(plan, t.stage)
  const dayTemp = mid(e.tag)
  const shift = svp(dayTemp) - svp(dayTemp - t.leaf_offset)
  const edge = (v) => roundTo(Math.max(0, v), 2)
  return {
    stage: t.stage, stage_name: t.stage_name, phase: t.phase, week: t.week,
    light_hours: e.h, leaf_offset: t.leaf_offset, leaf_vpd: [...e.vpd],
    temp: { day: [...e.tag], night: [...e.nacht] },
    humi: { day: [...e.rh], night: [...e.rh] },
    vpd: {
      day: [edge(e.vpd[0] + shift), edge(e.vpd[1] + shift)],
      night: [edge(t.vpd.night - t.vpd.tolerance), edge(t.vpd.night + t.vpd.tolerance)],
    },
    ppfd: [...e.ppfd],
  }
}

// ------------------------------------------------------------------- log
export const isWatering = (e) => e.type !== 'note'
export function sortedLog(log) {
  return log.slice().sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1
    return (b.ts || 0) - (a.ts || 0)
  })
}
export const lastWatering = (log) => sortedLog(log).find(isWatering) || null
export const plantById = (plan, id) => plan.plants.find((p) => p.id === id) || null
export const activePlants = (plan) => plan.plants.filter((p) => !p.gone)
export function plantsLabel(plan, e) {
  if (!e.plants || !e.plants.length) return t('Alle Pflanzen')
  return e.plants.map((id) => plantById(plan, id)?.name || t('unbekannte Pflanze')).join(', ')
}
export const extraText = (e) => (e.extra || []).map((x) => t(x.n) + (x.a != null ? ` ${num(x.a, 1)} ${x.u}` : '')).join(', ')
export function mixText(e) {
  if ((e.type !== 'feed' && e.type !== 'flush') || !e.mix) return ''
  const f = (e.strength || 100) / 100
  return e.mix.map((x) => `${t(x.n)} ${x.v == null ? '?' : num(x.v * f * (e.liters || 0), 1)} ${x.u}`).join(', ')
}
export function newEntry(plan, lib, pos, today, plantId) {
  const s = currentSched(lib, plan)
  const m = mixFor(s, plan, pos.phase, pos.week)
  return {
    id: uid(), ts: Date.now(), date: today, plants: plantId ? [plantId] : [],
    type: m.water ? (m.col.flush ? 'flush' : 'water') : m.col.flush ? 'flush' : 'feed',
    liters: plan.liters, strength: plan.strength, sched: { id: s.id, name: `${s.brand} · ${s.name}` },
    phase: pos.phase, week: pos.week, ecIn: null, phIn: null, ecOut: null, phOut: null, note: '', tags: [], extra: [],
    mix: m.items.map((it) => ({ n: it.p.n, u: unitOf(it.p), v: it.v < 0 ? null : it.v, c: prodColor(s, it.p) })),
  }
}
export function toText(plan, log, title = t('Growplan – Gießprotokoll')) {
  const lines = [title, '']
  sortedLog(log).slice(0, 60).forEach((e) => {
    const m = []
    if (e.ecIn != null) m.push(`EC ${f2(e.ecIn)}`)
    if (e.phIn != null) m.push(`pH ${f1(e.phIn)}`)
    if (e.ecOut != null || e.phOut != null) m.push(t('Drain {values}', { values: `${e.ecOut != null ? `EC ${f2(e.ecOut)} ` : ''}${e.phOut != null ? `pH ${f1(e.phOut)}` : ''}` }))
    lines.push(`${fmtDate(e.date, { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' })} · ${TYPE_LBL[e.type]} · ${phaseLabel(e.phase, e.week)}${e.type !== 'note' && e.liters ? ` · ${num(e.liters, 2)} L` : ''} · ${plantsLabel(plan, e)}`)
    if (m.length) lines.push(`   ${m.join(' · ')}`)
    const mt = mixText(e)
    if (mt) lines.push(`   ${mt}`)
    const xt = extraText(e)
    if (xt) lines.push(`   + ${xt}`)
    if (e.tags && e.tags.length) lines.push(`   ${t('Maßnahmen: {tags}', { tags: e.tags.map((tag) => t(tag)).join(', ') })}`)
    if (e.note) lines.push(`   ${t('Notiz: {note}', { note: e.note })}`)
  })
  return lines.join('\n')
}

// ------------------------------------------------------------- checklist
export const checkItems = (lib) => CHECK_DEFAULT.filter((c) => (lib.checkOff || []).indexOf(c.id) < 0).concat(lib.checkCustom || [])
export const checkDone = (lib, today) => (lib.check?.date === today ? lib.check.done || [] : [])

// ------------------------------------------------------------- defaults
export function newPlant(name, id) {
  return { id: id || `p${uid()}`, name: String(name || '').trim().slice(0, 24) || t('Pflanze'), strain: '', type: 'photo', pot: null, start: '', note: '' }
}
export function defaultPlan() {
  return {
    phase: 'veg', week: 1, vegWeeks: 4, floWeeks: 8, sched: BUILTIN[0].id, strength: 100, liters: 5, tent: 0.81,
    vegStart: '', floStart: '', dim: 100, tAir: 24, rh: 55, leafOff: 2, medium: 'erde',
    plants: [1, 2, 3].map((i) => newPlant(t('Pflanze {n}', { n: i }), `p${i}`)), hidden: {}, envOv: {}, lamp: clone(LAMP_DEFAULT), luxIn: '',
  }
}
export const emptyLibrary = () => ({ custom: [], ovr: {}, check: { date: '', done: [] }, checkCustom: [], checkOff: [] })

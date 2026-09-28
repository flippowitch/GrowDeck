// Growplan for the static demo: plans, watering log, library, watering reminders and recognised
// waterings, and the grow archive, in memory with the same answers as the GrowDeck backend.
// Starts from the snapshot in demo-data.json (Zelt 1 in flowering week 3, one archived grow).
import { t } from '../src/i18n.js'
import { ENV } from '../src/growplan/data.js'
import {
  addDays, controlTargets, currentPosition, envOf, harvestISO, isISO, isWatering, mid, planBands, sortedLog, stageKey,
  todayISO,
} from '../src/growplan/engine.js'
import {
  DATA, SHIFT, addEvent, broadcast, clone, ctx, fail, hash, localHHMM, localISO, round, shiftISO, shiftTs,
} from './core.js'

const plans = new Map()
const logs = new Map()
let library = clone(DATA.growplan?.library) || { custom: [], ovr: {}, check: { date: '', done: [] }, checkCustom: [], checkOff: [] }
let counter = 1
const now = () => Math.floor(Date.now() / 1000)

// ------------------------------------------------------------ snapshot
function shiftPlanData(data) {
  const out = clone(data)
  out.vegStart = shiftISO(out.vegStart)
  out.floStart = shiftISO(out.floStart)
  for (const p of out.plants || []) p.start = shiftISO(p.start)
  return out
}
function shiftEntry(e) {
  return { ...clone(e), date: shiftISO(e.date), ts: typeof e.ts === 'number' ? Math.round(e.ts + SHIFT * 1000) : e.ts }
}
for (const p of DATA.growplan?.plans || []) {
  plans.set(p.id, {
    id: p.id, room_id: p.room_id, name: p.name, data: shiftPlanData(p.data),
    created: Math.round(shiftTs(p.created)), updated: Math.round(shiftTs(p.updated)), rev: 0,
  })
  logs.set(p.id, (DATA.growplan_logs?.[p.id] || []).map(shiftEntry))
}

// watering reminders and recognised waterings, per plan
const watering = {
  settings: clone(DATA.state?.watering?.settings || {}),
  suggestions: Object.fromEntries(Object.entries(DATA.state?.watering?.suggestions || {}).map(([planId, items]) => [
    planId, items.map((s) => {
      const ts = Math.round(shiftTs(s.ts))
      return { ...s, ts, date: localISO(ts), time: localHHMM(ts) }
    }),
  ])),
}

function shiftGrow(g) {
  const out = clone(g)
  for (const key of ['started', 'harvested', 'flower_start']) out[key] = shiftISO(out[key])
  for (const p of out.plants || []) p.start = shiftISO(p.start)
  if (out.plan) out.plan = shiftPlanData(out.plan)
  out.log = (out.log || []).map(shiftEntry)
  out.created = Math.round(shiftTs(out.created))
  out.updated = Math.round(shiftTs(out.updated))
  return out
}
let grows = (DATA.grows || []).map(shiftGrow)
// a second, older grow so that the comparison can be tried right away
if (grows[0]) {
  const first = grows[0]
  const harvested = addDays(first.started, -24)
  const flower = addDays(harvested, -56)
  const started = addDays(flower, -38)
  const older = clone(first)
  Object.assign(older, {
    id: 'grow-demo2', name: 'Winter: Blueberry & Amnesia', strain: 'Blueberry, Amnesia Haze', started, harvested, flower_start: flower,
    yield_g: 347, rating: 3, notes: 'Zu spät auf Blüte umgestellt, Blueberry hat sich sehr gestreckt. Luftfeuchte in der Blüte zu hoch.',
    created: first.created - 140 * 86400, updated: first.created - 140 * 86400,
    plants: [{ ...first.plants[0], strain: 'Blueberry', start: addDays(started, 0) }, { ...first.plants[1], start: addDays(started, 0) }],
  })
  older.stats = {
    ...older.stats, days: 94, veg_days: 38, flower_days: 56, waterings: 36, feeds: 22, liters: 198, notes: 4,
    ec_in: 1.41, ph_in: 6.31, ec_out: 2.18, ph_out: 6.52, kwh: 402.3, cost: 120.69,
    climate: {
      veg: { temp_day: 25.8, temp_night: 20.4, humi_day: 64.2, humi_night: 66.1, vpd_day: 1.02, vpd_night: 0.71, in_temp: 0.74, in_humi: 0.63, in_vpd: 0.55, light_hours: 18, dli: 29.1, days: 38 },
      flower: { temp_day: 23.9, temp_night: 18.7, humi_day: 58.4, humi_night: 61.3, vpd_day: 1.12, vpd_night: 0.72, in_temp: 0.83, in_humi: 0.41, in_vpd: 0.38, light_hours: 12, dli: 30.4, days: 56 },
    },
  }
  older.plan = { ...clone(first.plan), vegStart: started, floStart: flower, floWeeks: 8 }
  grows.push(older)
}

// ------------------------------------------------------------ summaries
function planStatus(record) {
  const data = record.data
  const pos = currentPosition(data, todayISO())
  const key = stageKey(pos.phase, pos.week, data.floWeeks)
  const last = sortedLog(logs.get(record.id) || []).find(isWatering)
  return {
    ...pos,
    max_week: pos.phase === 'seed' ? 2 : pos.phase === 'veg' ? data.vegWeeks : data.floWeeks,
    stage: key, stage_name: ENV[key].n, env: envOf(data, key), harvest: harvestISO(data) || null,
    last_watering: last ? { date: last.date, type: last.type, liters: last.liters } : null,
  }
}

function summary(record) {
  return {
    id: record.id, room_id: record.room_id, name: record.name, created: record.created, updated: record.updated,
    entries: (logs.get(record.id) || []).length, rev: record.rev, data: clone(record.data), status: planStatus(record),
  }
}

export const summaries = () => [...plans.values()].sort((a, b) => a.created - b.created).map(summary)
export const wateringPayload = () => clone(watering)
export const planForRoom = (roomId) => [...plans.values()].find((p) => p.room_id === roomId) || null
export const logOf = (planId) => logs.get(planId) || []
export const growList = () => grows

function changed(record, withLibrary = false) {
  if (record) record.rev += 1
  broadcast('growplan', withLibrary ? { plans: summaries(), library: clone(library) } : { plans: summaries() })
  ctx.onPlanChange?.()
}
const wateringChanged = () => broadcast('watering', wateringPayload())

export function targetsForRoom(roomId) {
  const record = planForRoom(roomId)
  return record ? { plan_id: record.id, ...controlTargets(record.data, todayISO()) } : null
}

export function bandsForRoom(roomId) {
  const record = planForRoom(roomId)
  return record ? planBands(record.data, todayISO()) : null
}

export function roomDeleted(roomId) {
  for (const record of plans.values()) {
    if (record.room_id === roomId) {
      record.room_id = null
      changed(record)
    }
  }
}

// ------------------------------------------------------------- plans
const GERMAN_DEFAULT = () => ({
  phase: 'veg', week: 1, vegWeeks: 4, floWeeks: 8, sched: 'an-sensi-top', strength: 100, liters: 5, tent: 0.81,
  vegStart: '', floStart: '', dim: 100, tAir: 24, rh: 55, leafOff: 2, medium: 'erde',
  plants: [1, 2, 3].map((i) => ({ id: `p${i}`, name: t('Pflanze {n}', { n: i }), strain: '', type: 'photo', pot: null, start: '', note: '' })),
  hidden: {}, envOv: {}, lamp: { name: 'Spider Farmer G3000', ppf: 852, watt: 300, util: 85, luxF: 65, price: 0.3 }, luxIn: '',
})

function merge(data) {
  const plan = { ...GERMAN_DEFAULT(), ...clone(data || {}) }
  plan.phase = ['seed', 'veg', 'flower'].includes(plan.phase) ? plan.phase : 'veg'
  plan.vegWeeks = Math.max(1, Math.min(12, parseInt(plan.vegWeeks, 10) || 4))
  plan.floWeeks = Math.max(4, Math.min(16, parseInt(plan.floWeeks, 10) || 8))
  plan.week = Math.max(1, Math.min(plan.phase === 'veg' ? plan.vegWeeks : plan.phase === 'flower' ? plan.floWeeks : 2, parseInt(plan.week, 10) || 1))
  if (typeof plan.liters === 'string') plan.liters = parseFloat(plan.liters.replace(',', '.')) || 5
  if (!Array.isArray(plan.plants) || !plan.plants.length) plan.plants = GERMAN_DEFAULT().plants
  for (const key of ['view', 'theme', 'logFilter', 'check', 'checkCustom', 'checkOff']) delete plan[key]
  return plan
}

const PHOTO_ID = /^[a-z0-9][a-z0-9-]{0,39}\/\d{4}-\d{2}-\d{2}\/\d{6}(?:-\d{1,2})?$/

function checkEntry(entry) {
  const num = (v) => (v == null || v === '' ? null : parseFloat(String(v).replace(',', '.')))
  const out = { ...clone(entry), liters: num(entry.liters), ecIn: num(entry.ecIn), phIn: num(entry.phIn), ecOut: num(entry.ecOut), phOut: num(entry.phOut) }
  if (!out.date) fail(400, 'Bitte ein Datum wählen')
  if ([out.phIn, out.phOut].some((v) => v != null && (v < 0 || v > 14)) || [out.ecIn, out.ecOut].some((v) => v != null && (v < 0 || v > 10))) {
    fail(400, 'EC (0–10) bzw. pH (0–14) bitte prüfen')
  }
  if (out.type === 'note') {
    if (!(out.note || '').trim() && !(out.tags || []).length && [out.ecIn, out.phIn, out.ecOut, out.phOut].every((v) => v == null)) {
      fail(400, 'Bitte eine Notiz, Maßnahme oder Messung eintragen')
    }
    out.liters = null
    out.mix = []
    out.extra = []
  } else if (!(out.liters > 0) || out.liters > 500) fail(400, 'Bitte eine gültige Wassermenge angeben')
  if (out.photo && !PHOTO_ID.test(out.photo)) delete out.photo
  if (!out.photo) delete out.photo
  out.ts = out.ts || Date.now()
  return out
}

function create(roomId, name, data) {
  const record = { id: `gp-demo${counter++}`, room_id: roomId || null, name: (name || '').trim().slice(0, 60) || 'Mein Grow', data: merge(data), created: now() + counter, updated: now(), rev: 0 }
  plans.set(record.id, record)
  logs.set(record.id, [])
  return record
}

function exportBackup(id, record) {
  return {
    app: 'growplan', format: 2, exported: new Date().toISOString(),
    settings: { view: 'heute', theme: '', logFilter: '', ...clone(record.data), check: clone(library.check), checkCustom: clone(library.checkCustom), checkOff: clone(library.checkOff) },
    log: sortedLog(logs.get(id)).reverse(), custom: clone(library.custom), ovr: clone(library.ovr),
  }
}

function importBackup(id, record, body) {
  if (!body || body.app !== 'growplan' || !Array.isArray(body.log)) fail(400, 'Kein Growplan-Backup.')
  const list = logs.get(id)
  const wasEmpty = !list.length
  const known = new Set(list.map((e) => e.id))
  const incoming = body.log.filter((e) => e && e.id && e.date)
  const added = incoming.filter((e) => !known.has(e.id)).length
  const merged = new Map(list.map((e) => [e.id, e]))
  for (const e of incoming) merged.set(e.id, { ...clone(e), ts: e.ts || Date.now() })
  logs.set(id, [...merged.values()])
  const customs = new Map(library.custom.map((c) => [c.id, c]))
  for (const c of body.custom || []) if (c?.id && Array.isArray(c.products)) customs.set(c.id, { ...clone(c), custom: true })
  library = { ...library, custom: [...customs.values()], ovr: { ...library.ovr, ...clone(body.ovr || {}) } }
  const settingsApplied = wasEmpty && !!body.settings
  if (settingsApplied) {
    record.data = merge({ ...record.data, ...body.settings })
    for (const key of ['check', 'checkCustom', 'checkOff']) if (body.settings[key]) library[key] = clone(body.settings[key])
  }
  record.updated = now()
  changed(record, true)
  return {
    result: { added, updated: incoming.length - added, skipped: body.log.length - incoming.length, custom: (body.custom || []).length, ovr: Object.keys(body.ovr || {}).length, settings: settingsApplied },
    plan: summary(record), log: sortedLog(logs.get(id)), library: clone(library),
  }
}

// ------------------------------------------------------------ watering
function cleanWatering(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const out = { days: 0, time: '09:00', soil_below: null, detect: true }
  const days = parseInt(src.days, 10)
  if (!Number.isNaN(days)) out.days = Math.max(0, Math.min(30, days))
  if (typeof src.time === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(src.time)) out.time = src.time
  if (src.soil_below != null && src.soil_below !== '') {
    const soil = Number(src.soil_below)
    out.soil_below = soil >= 1 && soil <= 99 ? soil : null
  }
  out.detect = src.detect !== false
  return out
}

function dismiss(planId, suggestionId = null) {
  const items = watering.suggestions[planId] || []
  watering.suggestions[planId] = items.filter((s) => suggestionId && s.id !== suggestionId)
  wateringChanged()
}

// ------------------------------------------------------------ archive
function withRatios(grow) {
  const stats = { ...(grow.stats || {}) }
  const y = grow.yield_g
  stats.g_per_watt = y && stats.lamp_watts ? round(y / stats.lamp_watts, 2) : null
  stats.g_per_kwh = y && stats.kwh ? round(y / stats.kwh, 2) : null
  stats.cost_per_g = y && stats.cost ? round(stats.cost / y, 3) : null
  return { ...clone(grow), stats }
}
const brief = (grow) => {
  const { plan, log, ...rest } = withRatios(grow)
  return rest
}

function photoStats(roomId, started, harvested) {
  const photos = ctx.photosInRange?.(roomId, new Date(`${started}T00:00:00`).getTime() / 1000, new Date(`${harvested}T23:59:59`).getTime() / 1000) || []
  const stats = { photos: photos.length }
  if (photos.length) {
    stats.photo_first = photos[photos.length - 1].id
    stats.photo_last = photos[0].id
    stats.cameras = [...new Set(photos.map((p) => p.camera_id))].sort()
  }
  return stats
}

// photos of the archived grows (the camera module generates them for these periods)
export function refreshGrowPhotos() {
  for (const g of grows) {
    const { photo_first: a, photo_last: b, cameras, ...rest } = g.stats
    g.stats = { ...rest, ...photoStats(g.room_id, g.started, g.harvested) }
  }
}

function details(raw) {
  const out = {}
  if ('name' in raw) out.name = String(raw.name || '').trim().slice(0, 80)
  if ('strain' in raw) out.strain = String(raw.strain || '').trim().slice(0, 120)
  if ('notes' in raw) out.notes = String(raw.notes || '').trim().slice(0, 4000)
  if ('yield_g' in raw) {
    if (raw.yield_g == null || raw.yield_g === '') out.yield_g = null
    else {
      const n = Number(String(raw.yield_g).replace(',', '.'))
      if (Number.isNaN(n)) fail(400, 'Den Ertrag bitte in Gramm als Zahl angeben.')
      if (n < 0 || n > 100000) fail(400, 'Den Ertrag bitte in Gramm angeben (0 bis 100000).')
      out.yield_g = round(n, 1)
    }
  }
  if ('rating' in raw) out.rating = raw.rating == null || raw.rating === '' || raw.rating === 0 ? null : Math.max(1, Math.min(5, parseInt(raw.rating, 10) || 1))
  return out
}

// Key figures like the backend (archive.py); the climate per phase is estimated from the plan's
// targets because the demo keeps no measured history.
function growStats(plan, log, roomId, started, harvested) {
  const flower = isISO(plan.floStart) ? plan.floStart : null
  const veg = isISO(plan.vegStart) ? plan.vegStart : started
  const waterings = log.filter((e) => e.type !== 'note')
  const days = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000)
  const mean = (key) => {
    const values = log.map((e) => e[key]).filter((v) => v != null).map(Number)
    return values.length ? round(values.reduce((x, y) => x + y, 0) / values.length, 2) : null
  }
  const stats = {
    days: days(started, harvested),
    veg_days: flower && flower >= veg ? days(veg, flower) : null,
    flower_days: flower && harvested >= flower ? days(flower, harvested) : null,
    waterings: waterings.length, feeds: log.filter((e) => e.type === 'feed').length,
    liters: round(waterings.reduce((sum, e) => sum + (Number(e.liters) || 0), 0), 1),
    notes: log.filter((e) => e.type === 'note').length,
    ec_in: mean('ecIn'), ph_in: mean('phIn'), ec_out: mean('ecOut'), ph_out: mean('phOut'),
  }
  const lamp = plan.lamp || {}
  const watts = (Number(lamp.watt) || 0) * (Number(plan.dim) || 100) / 100
  stats.lamp_watts = watts ? Math.round(watts) : null
  let kwh = 0
  const climate = {}
  const today = todayISO()
  for (let day = started; day <= harvested; day = addDays(day, 1)) {
    const phase = flower && day >= flower ? 'flower' : 'veg'
    const week = phase === 'flower' ? Math.floor(days(flower, day) / 7) + 1 : Math.max(1, Math.floor(days(veg, day) / 7) + 1)
    const key = stageKey(phase, Math.min(week, plan.floWeeks || 8), plan.floWeeks || 8)
    const env = envOf(plan, key)
    kwh += (watts * env.h) / 1000
    if (day > today) continue
    const c = (climate[phase] ||= { n: 0, temp_day: 0, temp_night: 0, humi_day: 0, humi_night: 0, vpd_day: 0, vpd_night: 0, light_hours: 0, dli: 0 })
    const wobble = (k) => (hash(`${day}${k}${roomId}`) - 0.5)
    const td = mid(env.tag) + wobble('t') * 2
    const tn = mid(env.nacht) + wobble('n') * 1.5
    const hd = mid(env.rh) + 3 + wobble('h') * 8
    const hn = hd + 3
    const svp = (t) => 0.61078 * Math.exp((17.27 * t) / (t + 237.3))
    c.n += 1
    c.temp_day += td
    c.temp_night += tn
    c.humi_day += hd
    c.humi_night += hn
    c.vpd_day += svp(td) * (1 - hd / 100)
    c.vpd_night += svp(tn) * (1 - hn / 100)
    c.light_hours += env.h
    c.dli += mid(env.ppfd) * env.h * 0.0036
  }
  stats.climate = {}
  for (const [phase, c] of Object.entries(climate)) {
    const avg = (v, d) => round(v / c.n, d)
    stats.climate[phase] = {
      temp_day: avg(c.temp_day, 1), temp_night: avg(c.temp_night, 1), humi_day: avg(c.humi_day, 1), humi_night: avg(c.humi_night, 1),
      vpd_day: avg(c.vpd_day, 2), vpd_night: avg(c.vpd_night, 2), in_temp: round(0.78 + hash(`${roomId}${phase}t`) * 0.18, 2),
      in_humi: round(0.55 + hash(`${roomId}${phase}h`) * 0.3, 2), in_vpd: round(0.5 + hash(`${roomId}${phase}v`) * 0.3, 2),
      light_hours: avg(c.light_hours, 1), dli: avg(c.dli, 1), days: c.n,
    }
  }
  stats.climate_days = Object.values(climate).reduce((sum, c) => sum + c.n, 0)
  stats.kwh = watts ? round(kwh, 1) : null
  const price = Number(lamp.price) || 0
  stats.cost = watts && price ? round(kwh * price, 2) : null
  stats.price = price || null
  return { ...stats, ...photoStats(roomId, started, harvested) }
}

function archivePlan(id, record, raw) {
  const plan = record.data
  const log = sortedLog(logs.get(id) || [])
  const harvested = isISO(raw.harvested) ? raw.harvested : todayISO()
  const extra = details(raw)
  const room = ctx.rooms?.().find((r) => r.id === record.room_id) || null
  const candidates = [plan.vegStart, ...(plan.plants || []).map((p) => p.start), ...log.map((e) => e.date)].filter((d) => isISO(d) && d <= harvested)
  const started = candidates.length ? candidates.sort()[0] : localISO(record.created)
  const active = (plan.plants || []).filter((p) => !p.gone)
  const strains = [...new Set(active.map((p) => p.strain).filter(Boolean))].sort()
  const t = now()
  const grow = {
    id: `grow-${Math.floor(hash(String(Date.now())) * 0xffffffff).toString(16).padStart(8, '0')}`, room_id: record.room_id,
    room_name: room?.name || null, plan_name: record.name || '',
    name: extra.name || record.name || room?.name || 'Grow', strain: 'strain' in extra ? extra.strain : strains.join(', '),
    started, harvested, flower_start: plan.floStart || null,
    yield_g: extra.yield_g ?? null, rating: extra.rating ?? null, notes: extra.notes || '',
    plants: clone(active), medium: plan.medium, lamp: clone(plan.lamp), sched: plan.sched,
    stats: growStats(plan, log, record.room_id, started, harvested), plan: clone(plan), log: clone(log), created: t, updated: t,
  }
  grows = [grow, ...grows].sort((a, b) => (b.harvested || '').localeCompare(a.harvested || '') || b.created - a.created)
  if (raw.reset) {
    record.data = merge({
      ...plan, phase: 'seed', week: 1, vegStart: '', floStart: '', luxIn: '',
      plants: active.map((p) => ({ ...p, start: '', note: '' })),
    })
    for (const p of record.data.plants) delete p.gone
    logs.set(id, [])
    record.updated = t
    dismiss(id)
  }
  changed(record)
  broadcast('grows', { changed: true })
  addEvent('info', 'growplan', `Grow „${grow.name}“ abgeschlossen und im Archiv gespeichert.`)
  return { grow: brief(grow), plan: summary(record) }
}

export function growsRoute(method, parts, body) {
  const [, id, action] = parts
  if (!id) return { grows: grows.map(brief) }
  const grow = grows.find((g) => g.id === id) || fail(404, 'Diesen Grow gibt es im Archiv nicht.')
  if (action) fail(404, 'Nicht gefunden.')
  if (method === 'GET') return { grow: withRatios(grow) }
  if (method === 'DELETE') {
    grows = grows.filter((g) => g.id !== id)
    broadcast('grows', { changed: true })
    return { ok: true }
  }
  Object.assign(grow, details(body || {}))
  if (isISO(body?.harvested)) grow.harvested = body.harvested
  grow.updated = now()
  broadcast('grows', { changed: true })
  return { grow: brief(grow) }
}

// ------------------------------------------------------------- routes
export function growplanRoute(method, parts, body) {
  const [, b, id, d, entryId] = parts
  if (!b) return { plans: summaries(), library: clone(library), today: todayISO() }
  if (b === 'library') {
    library = { ...library, ...clone(body || {}) }
    changed(null, true)
    return { library: clone(library) }
  }
  if (b !== 'plans') fail(404, 'Nicht gefunden.')
  if (!id) {
    if (body.room_id && planForRoom(body.room_id)) fail(409, 'Dieses Zelt hat schon einen Growplan.')
    const roomName = body.room_id ? ctx.rooms?.().find((r) => r.id === body.room_id)?.name : null
    const record = create(body.room_id, body.name || roomName, body.data)
    changed(record)
    return { plan: summary(record), log: [] }
  }
  const record = plans.get(id) || fail(404, 'Growplan nicht gefunden.')
  if (!d) {
    if (method === 'GET') return { plan: summary(record), log: sortedLog(logs.get(id)) }
    if (method === 'DELETE') {
      plans.delete(id)
      logs.delete(id)
      delete watering.settings[id]
      delete watering.suggestions[id]
      changed(null)
      return { ok: true }
    }
    if (body.data) record.data = merge(body.data)
    if (body.name) record.name = body.name.trim().slice(0, 60) || record.name
    record.updated = now()
    changed(record)
    return { plan: summary(record) }
  }
  if (d === 'room') {
    if (body.room_id && [...plans.values()].some((p) => p.room_id === body.room_id && p.id !== id)) {
      fail(409, 'Dieses Zelt hat schon einen Growplan. Löse ihn dort zuerst.')
    }
    record.room_id = body.room_id || null
    record.updated = now()
    changed(record)
    return { plan: summary(record) }
  }
  if (d === 'watering') {
    watering.settings[id] = cleanWatering(body)
    wateringChanged()
    return { settings: clone(watering.settings[id]), ...wateringPayload() }
  }
  if (d === 'suggestions') {
    dismiss(id, entryId)
    return wateringPayload()
  }
  if (d === 'archive') return archivePlan(id, record, body || {})
  if (d === 'log') {
    const list = logs.get(id)
    if (!entryId) {
      const deleted = list.length
      logs.set(id, [])
      changed(record)
      return { deleted, plan: summary(record) }
    }
    if (method === 'DELETE') {
      logs.set(id, list.filter((e) => e.id !== entryId))
      changed(record)
      return { ok: true, plan: summary(record) }
    }
    const entry = checkEntry({ ...body, id: entryId })
    logs.set(id, [...list.filter((e) => e.id !== entryId), entry])
    changed(record)
    return { entry, plan: summary(record) }
  }
  if (d === 'export') return exportBackup(id, record)
  if (d === 'import') return importBackup(id, record, body)
  fail(404, 'Nicht gefunden.')
  return null
}

// ------------------------------------------------------ demo history
// Date of the watering before a given day (for the reminder event of the seed).
export function lastWateringBefore(planId, iso) {
  return sortedLog(logs.get(planId) || []).find((e) => isWatering(e) && e.date < iso) || null
}

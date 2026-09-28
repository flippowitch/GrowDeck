// In-browser stand-in for the GrowDeck backend. Only used by the static demo page: it answers
// the same /api requests and live-socket messages as the real server (backend/app/api), starting
// from a snapshot of GrowDeck's own demo mode (demo-data.json, made with demo/snapshot.mjs).
// Everything is kept in memory: changes last until the tab is reloaded. Server texts are the
// backend's German templates, so the page translates them like the real ones.
import { addDays, todayISO } from '../src/growplan/engine.js'
import {
  DATA, HttpError, addEvent, broadcast, clone, ctx, de, deG, fail, hash, localISO, nowS, pad, round, shiftTs, sockets, store,
} from './core.js'
import {
  bandsForRoom, growplanRoute, growsRoute, lastWateringBefore, planForRoom, refreshGrowPhotos, roomDeleted, summaries as growplans,
  targetsForRoom, wateringPayload,
} from './growplan-mock.js'
import { camerasRoute, startCameras } from './cameras-mock.js'

const devices = new Map(clone(DATA.state.devices).map((d) => [d.id, d]))
let rooms = clone(DATA.state.rooms)
let rules = clone(DATA.rules.rules)
const automation = clone(DATA.rules.status || DATA.state.automation)
let alarms = clone(DATA.alarms.alarms)
const alarmStates = {}
const settings = clone(DATA.state.settings)
const integrations = clone(DATA.state.integrations)
const natives = clone(DATA.natives)
const version = DATA.me?.version || '1.6.0'
const startedAt = nowS() - 3 * 86400 - 5 * 3600
const baseline = new Map()
const controlLog = []
let authed = true
let nextId = 1

ctx.rooms = () => rooms
ctx.devices = () => [...devices.values()]

for (const d of devices.values()) {
  d.last_seen = nowS()
  for (const s of d.sensors) {
    s.updated = nowS()
    baseline.set(`${d.id}|${s.key}`, s.value)
  }
}

// ------------------------------------------------------------- helpers
const noise = (seed, t) => {
  const x = Math.sin(seed * 12.9898 + t * 0.0137) * 43758.5453
  return (x - Math.floor(x)) * 2 - 1
}
const minutesOf = (hhmm) => {
  const [h, m] = String(hhmm || '06:00').split(':').map(Number)
  return h * 60 + m
}
function isDay(ts, room) {
  const start = minutesOf(room?.day_start || '06:00')
  const end = minutesOf(room?.day_end || '00:00')
  const date = new Date(ts * 1000)
  const minute = date.getHours() * 60 + date.getMinutes()
  if (start === end) return true
  return start < end ? minute >= start && minute < end : minute >= start || minute < end
}
const svpOf = (t) => 0.6108 * Math.exp((17.27 * t) / (t + 237.3))
const vpdOf = (temp, humi) => Math.max(0, svpOf(temp) * (1 - humi / 100))
const rhForVpd = (t, v) => Math.max(0, Math.min(100, 100 * (1 - v / svpOf(t))))
function setMode(control, key) {
  control.mode = key
  const label = control.modes?.find((m) => m.key === key)?.label
  if (label) control.mode_label = label
}
const roomOf = (device) => rooms.find((r) => r.id === device?.info?.room_id)
const TIME = /^([01]?\d|2[0-3]):[0-5]\d$/
const checkTime = (value, label) => {
  if (value != null && !TIME.test(value)) fail(400, `${label} bitte als HH:MM angeben.`)
}

// ---------------------------------------------------------- synthetic data
function synth(kind, base, ts, end, seed, room) {
  const hour = 3600
  const wave = (period, phase = 0) => Math.sin((2 * Math.PI * (ts + phase)) / period)
  const drift = (t) => 0.5 * Math.sin(t / 1700 + seed * 10) + 0.3 * Math.sin(t / 730 + seed * 20) + 0.2 * Math.sin(t / 290 + seed * 30)
  const dayShape = (t) => {
    let sum = 0
    for (let k = 0; k < 12; k += 1) sum += isDay(t - k * 300, room) ? 1 : -1
    return (sum / 12) * 0.9 + 0.2 * drift(t)
  }
  const f = (t) => {
    switch (kind) {
      case 'temp': return 1.4 * dayShape(t) + 0.25 * drift(t) + 0.04 * noise(seed, t)
      case 'humi': return -4.5 * dayShape(t) + 1.1 * drift(t + 400) + 0.15 * noise(seed, t)
      case 'vpd': return 0.16 * dayShape(t) + 0.03 * drift(t) + 0.004 * noise(seed, t)
      case 'co2': return 70 * Math.sin((2 * Math.PI * t) / (3 * hour) + seed * 5) + 12 * noise(seed, t)
      case 'ppfd':
      case 'light': return ((dayShape(t) - 0.2 * drift(t)) / 0.9 + 1) / 2 * base - base
      case 'soil_moisture': return 11 * ((((end - t) / (9 * hour)) % 1 + 1) % 1)
      case 'soil_temp': return 0.6 * dayShape(t)
      case 'water': return ((end - t) / hour) * 0.6
      case 'rssi': return 2.5 * noise(seed, t)
      case 'leak': return 0
      default: return base ? Math.abs(base) * 0.03 * wave(4 * hour, seed * 1000) : 0
    }
  }
  return base + f(ts) - f(end)
}

function history(q) {
  const deviceId = q.get('device_id')
  const metric = q.get('metric')
  const hours = Math.max(0.25, Math.min(Number(q.get('hours')) || 24, 24 * 400))
  const points = Math.max(20, Math.min(Number(q.get('points')) || 360, 2000))
  const end = Math.floor(nowS() / 60) * 60
  const step = Math.max(10, Math.floor((hours * 3600) / points))
  const out = { device_id: deviceId, metric, start: end - Math.round(hours * 3600), end, bucket: step, t: [], avg: [], min: [], max: [] }
  const device = devices.get(deviceId)
  const sensor = device?.sensors.find((s) => s.key === metric)
  if (!sensor || sensor.value == null) return out
  const seed = hash(deviceId + metric)
  const room = roomOf(device)
  const digits = sensor.kind === 'vpd' ? 3 : 2
  for (let ts = out.start; ts <= end; ts += step) {
    let v = synth(sensor.kind, sensor.value, ts, end, seed, room)
    if (['humi', 'soil_moisture', 'water', 'light'].includes(sensor.kind)) v = Math.min(100, Math.max(0, v))
    if (['ppfd', 'co2', 'vpd'].includes(sensor.kind)) v = Math.max(0, v)
    out.t.push(ts)
    out.avg.push(round(v, digits))
    out.min.push(round(v - Math.abs(v) * 0.01, digits))
    out.max.push(round(v + Math.abs(v) * 0.01, digits))
  }
  return out
}

// Climate history of one tent (overview charts): averaged sensors, VPD and light-off periods.
function climateHistory(q) {
  const hours = Math.max(0.5, Math.min(Number(q.get('hours')) || 24, 24 * 90))
  const points = Math.max(20, Math.min(Number(q.get('points')) || 240, 1000))
  const refs = (key, label) => q.getAll(key).map((raw) => {
    const [deviceId, metric] = raw.split('|')
    if (!deviceId || !metric) fail(400, `Ungültige Quelle für ${label}: „${raw}“.`)
    return [deviceId, metric]
  })
  const tempRefs = refs('temp', 'Temperatur')
  const humiRefs = refs('humi', 'Luftfeuchte')
  const vpdRefs = refs('vpd', 'VPD')
  const lightRefs = refs('light', 'Licht')
  const end = Math.floor(nowS() / 60) * 60
  const bucket = Math.max(120, Math.ceil((hours * 3600) / points))
  const start = Math.floor((end - hours * 3600) / bucket) * bucket
  const grid = []
  for (let ts = start; ts <= end; ts += bucket) grid.push(ts)
  const series = (list) => {
    const used = list.map(([deviceId, metric]) => {
      const device = devices.get(deviceId)
      const sensor = device?.sensors.find((s) => s.key === metric)
      return sensor && sensor.value != null ? { sensor, seed: hash(deviceId + metric), room: roomOf(device) } : null
    }).filter(Boolean)
    const values = grid.map((ts) => {
      if (!used.length) return null
      let sum = 0
      for (const { sensor, seed, room } of used) {
        let v = synth(sensor.kind, sensor.value, ts, end, seed, room)
        if (sensor.kind === 'humi') v = Math.min(100, Math.max(0, v))
        if (sensor.kind === 'vpd') v = Math.max(0, v)
        sum += v
      }
      return sum / used.length
    })
    return { values, count: used.length }
  }
  const temp = series(tempRefs)
  const humi = series(humiRefs)
  const ownVpd = vpdRefs.length ? series(vpdRefs) : null
  const vpd = grid.map((_, i) => (ownVpd ? ownVpd.values[i]
    : temp.values[i] != null && humi.values[i] != null ? vpdOf(temp.values[i], humi.values[i]) : null))
  const schedule = { day_start: q.get('day_start') || '06:00', day_end: q.get('day_end') || '00:00' }
  const nights = []
  let from = null
  for (let ts = start; ts <= end; ts += 60) {
    const night = !isDay(ts, schedule)
    if (night && from == null) from = ts
    if (!night && from != null) {
      nights.push([from, ts])
      from = null
    }
  }
  if (from != null) nights.push([from, end])
  return {
    start, end, bucket, t: grid,
    temp: temp.values.map((v) => (v == null ? null : round(v, 2))),
    humi: humi.values.map((v) => (v == null ? null : round(v, 1))),
    vpd: vpd.map((v) => (v == null ? null : round(v, 3))),
    nights, night_source: lightRefs.length ? 'light' : 'schedule',
    sources: { temp: temp.count, humi: humi.count, vpd: ownVpd ? ownVpd.count : Math.min(temp.count, humi.count) },
  }
}

function seedControlLog() {
  const end = nowS()
  for (const d of devices.values()) {
    for (const c of d.controls) {
      if (!c.features?.includes('on_off')) continue
      const seed = hash(d.id + c.id)
      const count = 2 + Math.floor(seed * 4)
      let state = !c.on
      for (let i = count; i >= 1; i -= 1) {
        const ts = end - (i / (count + 1)) * 47 * 3600 - seed * 1800
        const source = i % 3 === 0 ? 'user' : i % 2 === 0 ? `automation:${rules[0]?.id || 'demo'}` : 'device'
        controlLog.push({ ts: Math.round(ts), device_id: d.id, control_id: c.id, on_state: state ? 1 : 0, level: c.level, source })
        state = !state
      }
    }
  }
}

// ------------------------------------------------------ rules and room control
const ROLE_NAMES = {
  light: 'Licht', exhaust: 'Abluft', circulation: 'Umluft', humidifier: 'Befeuchter',
  dehumidifier: 'Entfeuchter', heater: 'Heizung', cooler: 'Kühlung', co2: 'CO₂',
}
const TYPE_ROLES = {
  light: 'light', exhaust_fan: 'exhaust', circulation_fan: 'circulation', humidifier: 'humidifier',
  dehumidifier: 'dehumidifier', heater: 'heater', air_conditioner: 'cooler',
}
const DEFAULT_RC = {
  enabled: false, sensor_mode: 'source', day_source: 'schedule', humidity_mode: 'rh',
  temp: { day: 26, night: 21, tolerance: 1 }, humi: { day: 60, night: 55, tolerance: 4 },
  vpd: { day: 1.2, night: 0.9, tolerance: 0.15 }, co2: { enabled: false, day: 900, tolerance: 100 }, plan_targets: false, outputs: [],
}
const roomConfigs = {}
for (const [id, rc] of Object.entries(DATA.room_controls || {})) {
  if (DATA.state.room_control?.[id]) roomConfigs[id] = clone(rc.config)
}
const roomConfig = (id) => roomConfigs[id] || clone(DEFAULT_RC)
const roomStatus = {}
const rcMemory = {}
const ruleSent = {}

function managed() {
  const map = {}
  for (const [roomId, cfg] of Object.entries(roomConfigs)) {
    if (!cfg.enabled) continue
    for (const o of cfg.outputs) if (o.role !== 'light') map[`${o.device_id}|${o.control_id}`] = roomId
  }
  return map
}

function actuate(d, c, patch, source) {
  try {
    command(d, c, patch, source)
    return null
  } catch (err) {
    return err.message
  }
}

function satisfied(c, action) {
  if (action.on != null && c.on != null && !!c.on !== !!action.on) return false
  if (action.on === false) return true
  if (action.level != null && c.level != null && Math.abs(c.level - action.level) > 0.5) return false
  if (action.mode != null && c.mode != null && String(c.mode) !== String(action.mode)) return false
  if (action.option != null && c.value != null && String(c.value) !== String(action.option)) return false
  return true
}

function actionLabel(action) {
  if (!action) return 'nichts'
  const parts = []
  if ('on' in action) parts.push(action.on ? 'Ein' : 'Aus')
  if (action.level != null) parts.push(typeof action.level === 'number' ? `Stufe ${deG(action.level).replace(',', '.')}` : String(action.level))
  if (action.mode != null) parts.push(`Modus ${action.mode}`)
  if (action.option != null) parts.push(String(action.option))
  return parts.join(', ') || 'Änderung'
}

// Climate of a tent like backend/app/tent.py: its climate sensor or the average of all.
const tentDevices = (room) => [...devices.values()].filter((d) => !d.info?.hidden && d.info?.room_id === room.id)
const sensorOf = (d, key) => d.sensors.find((s) => s.key === key)
function primary(d, kind, group) {
  const candidates = d.sensors.filter((s) => s.kind === kind && (!group || s.group === group))
  return candidates.find((s) => !s.key.includes('.')) || candidates[0] || d.sensors.find((s) => s.kind === kind && !s.key.includes('.')) || null
}
function climateDevice(room) {
  const inRoom = tentDevices(room).filter((d) => d.online)
  let d = devices.get(room.climate_device_id)
  if (!d || !d.online) {
    d = inRoom.find((x) => sensorOf(x, 'temp') && sensorOf(x, 'humi'))
      || inRoom.find((x) => x.sensors.some((s) => s.kind === 'temp') && x.sensors.some((s) => s.kind === 'humi'))
  }
  return d
}
function roomReadings(room, cfg) {
  const vals = { temp: [], humi: [], co2: [] }
  const sources = []
  if (cfg.sensor_mode === 'average') {
    for (const d of tentDevices(room).filter((x) => x.online)) {
      let used = false
      for (const k of ['temp', 'humi', 'co2']) {
        const s = sensorOf(d, k)
        if (s?.value != null) {
          vals[k].push(s.value)
          if (k !== 'co2') used = true
        }
      }
      if (used) sources.push(d.name)
    }
  } else {
    const d = climateDevice(room)
    if (d?.online) {
      for (const k of ['temp', 'humi', 'co2']) {
        const s = primary(d, k, room.climate_group) || sensorOf(d, k)
        if (s?.value != null) vals[k].push(s.value)
      }
      sources.push(d.name)
    }
  }
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)
  const temp = avg(vals.temp)
  const humi = avg(vals.humi)
  return { temp, humi, co2: avg(vals.co2), vpd: temp != null && humi != null ? vpdOf(temp, humi) : null, sources }
}
function lightStates(cfg) {
  return cfg.outputs.filter((o) => o.role === 'light').map((o) => {
    const d = devices.get(o.device_id)
    const c = d?.controls.find((x) => x.id === o.control_id)
    return d?.online && c && c.on != null ? !!c.on && (c.level == null || c.level > 0) : null
  }).filter((x) => x !== null)
}
function roomDay(room, cfg, t) {
  if (cfg.day_source === 'light') {
    const states = lightStates(cfg)
    if (states.length) return [states.some(Boolean), 'light']
  }
  return [isDay(t, room), 'schedule']
}

function evaluateRoom(room, stored) {
  const t = nowS()
  // with "plan_targets" temperature, humidity and VPD come from the tent's grow plan
  const planTargets = stored.plan_targets ? targetsForRoom(room.id) : null
  const cfg = planTargets ? { ...stored, temp: planTargets.temp, humi: planTargets.humi, vpd: planTargets.vpd } : stored
  const r = roomReadings(room, cfg)
  const [day, dayBy] = roomDay(room, cfg, t)
  const phase = day ? 'day' : 'night'
  const T = r.temp
  const H = r.humi
  const Tt = cfg.temp[phase]
  const tolT = cfg.temp.tolerance
  const targets = { temp: Tt, temp_tolerance: tolT, vpd: null, co2: cfg.co2.enabled ? cfg.co2.day : null }
  let Ht
  let Hhi
  let Hlo
  if (cfg.humidity_mode === 'vpd') {
    const Vt = cfg.vpd[phase]
    const tolV = cfg.vpd.tolerance
    const bt = T ?? Tt
    Ht = rhForVpd(bt, Vt)
    Hhi = rhForVpd(bt, Math.max(0.05, Vt - tolV))
    Hlo = rhForVpd(bt, Vt + tolV)
    targets.vpd = Vt
    targets.vpd_tolerance = tolV
  } else {
    Ht = cfg.humi[phase]
    Hhi = Ht + cfg.humi.tolerance
    Hlo = Ht - cfg.humi.tolerance
  }
  Object.assign(targets, { humi: round(Ht, 1), humi_low: round(Hlo, 1), humi_high: round(Hhi, 1) })
  const status = { enabled: cfg.enabled, day, day_by: dayBy, readings: r, targets, outputs: [], message: null, updated: t }
  status.plan = clone({ sensor_mode: cfg.sensor_mode, day_source: cfg.day_source, humidity_mode: cfg.humidity_mode, temp: cfg.temp, humi: cfg.humi, vpd: cfg.vpd })
  status.plan_source = planTargets ? {
    plan_id: planTargets.plan_id, stage: planTargets.stage, stage_name: planTargets.stage_name, phase: planTargets.phase,
    week: planTargets.week, light_hours: planTargets.light_hours, leaf_offset: planTargets.leaf_offset, leaf_vpd: planTargets.leaf_vpd,
  } : null
  const ok = T != null && H != null
  if (!ok) status.message = 'Keine Messwerte für Temperatur und Luftfeuchte im Raum. Die Ausgänge bleiben, wie sie sind.'
  const order = ['heater', 'cooler', 'dehumidifier', 'humidifier', 'co2', 'circulation', 'exhaust', 'light']
  const indexed = cfg.outputs.map((o, i) => [i, o]).sort((a, b) => order.indexOf(a[1].role) - order.indexOf(b[1].role))
  const decisions = {}
  const running = {}
  const wasOn = (o) => {
    const mem = rcMemory[`${o.device_id}|${o.control_id}`]
    if (mem?.want_on != null) return mem.want_on
    return !!devices.get(o.device_id)?.controls.find((x) => x.id === o.control_id)?.on
  }
  for (const [i, o] of indexed) {
    if (o.role === 'light') { decisions[i] = [null, cfg.day_source === 'light' ? 'bestimmt Tag und Nacht' : 'nur Anzeige']; continue }
    if (!ok) { decisions[i] = [null, 'wartet auf Messwerte']; continue }
    const was = wasOn(o)
    let want
    let reason
    if (o.role === 'heater') {
      want = was ? T < Tt : T < Tt - tolT
      reason = want && !was ? `${de(T)} °C unter ${de(Tt - tolT)} °C` : want ? `heizt bis ${de(Tt)} °C` : 'Temperatur im Zielbereich'
    } else if (o.role === 'cooler') {
      want = was ? T > Tt : T > Tt + tolT
      reason = want && !was ? `${de(T)} °C über ${de(Tt + tolT)} °C` : want ? `kühlt bis ${de(Tt)} °C` : 'Temperatur im Zielbereich'
    } else if (o.role === 'dehumidifier') {
      want = (was ? H > Ht : H > Hhi) && !running.humidifier
      reason = want && !was ? `${de(H, 0)} % über ${de(Hhi, 0)} %` : want ? `entfeuchtet bis ${de(Ht, 0)} %` : 'Luftfeuchte im Zielbereich'
    } else if (o.role === 'humidifier') {
      want = (was ? H < Ht : H < Hlo) && !running.dehumidifier
      reason = want && !was ? `${de(H, 0)} % unter ${de(Hlo, 0)} %` : want ? `befeuchtet bis ${de(Ht, 0)} %` : 'Luftfeuchte im Zielbereich'
      if (want && cfg.humidity_mode === 'vpd' && r.vpd != null) reason += ` (VPD ${de(r.vpd, 2)} kPa)`
    } else if (o.role === 'co2') {
      if (!cfg.co2.enabled) [want, reason] = [false, 'CO₂-Regelung ist aus']
      else if (!day) [want, reason] = [false, 'nachts keine CO₂-Zugabe']
      else if (r.co2 == null) [want, reason] = [false, 'kein CO₂-Messwert']
      else {
        want = was ? r.co2 < cfg.co2.day : r.co2 < cfg.co2.day - cfg.co2.tolerance
        reason = `${de(r.co2, 0)} ppm, Ziel ${de(cfg.co2.day, 0)} ppm`
      }
    } else if (o.role === 'circulation') {
      [want, reason] = [true, day ? 'Tagbetrieb' : 'Nachtbetrieb']
    } else continue
    running[o.role] = running[o.role] || want
    decisions[i] = [{ on: want }, reason]
  }
  for (const [i, o] of indexed) {
    if (o.role !== 'exhaust' || !ok) continue
    const spanH = Math.max(1, Hhi - Ht)
    let demand = Math.max(0, (T - Tt) / (2 * tolT), (H - Ht) / (2 * spanH))
    let reason = 'Grundlüftung'
    if (demand > 0) {
      const parts = []
      if (T > Tt) parts.push(`+${de(T - Tt)} °C`)
      if (H > Ht) parts.push(`+${de(H - Ht, 0)} % Feuchte`)
      reason = `zu warm oder feucht: ${parts.join(', ')}`
    }
    const holders = ['humidifier', 'heater', 'co2'].filter((k) => running[k]).map((k) => ROLE_NAMES[k])
    if (holders.length && T <= Tt + tolT) {
      demand = 0
      reason = `gedrosselt, solange ${holders.join(' und ')} läuft`
    }
    decisions[i] = [{ demand: Math.min(1, demand) }, reason]
  }
  cfg.outputs.forEach((o, i) => {
    const [want, reason] = decisions[i] || [null, '']
    const d = devices.get(o.device_id)
    const c = d?.controls.find((x) => x.id === o.control_id)
    const entry = {
      device_id: o.device_id, control_id: o.control_id, role: o.role, label: c?.label || o.control_id,
      device_name: d?.name || 'Unbekanntes Gerät', vendor: d?.vendor || null, online: !!d?.online,
      on: c?.on ?? null, level: c?.level ?? null, reason, error: null, want: null,
    }
    status.outputs.push(entry)
    if (!c || !d) { entry.error = 'Gerät nicht gefunden.'; return }
    if (!want) return
    const hasLevel = c.features?.includes('level')
    let patch
    if (want.demand != null) {
      if (hasLevel) {
        const lo = o.min_level ?? c.level_min
        const hi = o.max_level ?? c.level_max
        const step = c.level_step || 1
        const level = Math.max(c.level_min, Math.min(c.level_max, Math.round((lo + want.demand * (hi - lo)) / step) * step))
        patch = level > 0 ? { on: true, level } : { on: false }
      } else patch = { on: want.demand >= 0.5 }
    } else if (o.role === 'circulation' && hasLevel) {
      const level = day ? (o.day_level ?? c.level_max) : (o.night_level ?? c.level_min)
      patch = level > 0 ? { on: true, level } : { on: false }
    } else patch = { on: !!want.on }
    entry.want = patch
    const key = `${o.device_id}|${o.control_id}`
    const mem = rcMemory[key] || (rcMemory[key] = { ts: 0 })
    mem.want_on = patch.on
    if (!cfg.enabled || !d.online) return
    const onDiffers = c.on != null && !!c.on !== !!patch.on
    const levelDiffers = patch.on && patch.level != null && c.level != null && Math.abs(c.level - patch.level) >= (c.level_step || 1)
    if (!onDiffers && !levelDiffers) return
    if (t - mem.ts < (onDiffers ? 20 : 8)) return
    mem.ts = t
    const error = actuate(d, c, onDiffers || !patch.on ? patch : { on: true, level: patch.level }, `room:${room.id}`)
    if (error) entry.error = error
    else {
      entry.on = c.on
      entry.level = c.level
      if (onDiffers) {
        addEvent('info', 'automation', `Zeltsteuerung ${room.name}: ${ROLE_NAMES[o.role]} (${c.label}, ${d.name}) ${patch.on ? 'an' : 'aus'}, ${reason}`,
          d.id, { room_id: room.id, role: o.role })
      }
    }
  })
  return status
}

function statusAll() {
  const out = {}
  for (const [id, cfg] of Object.entries(roomConfigs)) {
    out[id] = { ...(roomStatus[id] || { outputs: [], message: 'Wird ausgewertet …' }), enabled: !!cfg.enabled }
  }
  return out
}

// Room control settings checked like backend/app/roomcontrol.py (normalize).
function numberIn(obj, key, dflt, lo, hi, label) {
  const value = obj && key in obj ? obj[key] : dflt
  const n = typeof value === 'number' ? value : value == null || value === '' ? NaN : Number(value)
  if (Number.isNaN(n)) fail(400, `${label}: bitte eine Zahl eingeben.`)
  const edge = (v) => v.toFixed(2).replace('.', ',').replace(/0+$/, '').replace(/,$/, '')
  if (!(n >= lo && n <= hi)) fail(400, `${label} muss zwischen ${edge(lo)} und ${edge(hi)} liegen.`)
  return n
}
function normalizeRoomControl(roomId, body) {
  const cfg = clone(DEFAULT_RC)
  cfg.enabled = !!body.enabled
  cfg.plan_targets = !!body.plan_targets
  for (const [key, allowed] of [['sensor_mode', ['source', 'average']], ['day_source', ['schedule', 'light']], ['humidity_mode', ['rh', 'vpd']]]) {
    const value = key in body ? body[key] : cfg[key]
    if (!allowed.includes(value)) fail(400, `Ungültiger Wert für ${key}.`)
    cfg[key] = value
  }
  const temp = body.temp || {}
  cfg.temp = { day: numberIn(temp, 'day', 26, 5, 40, 'Temperatur Tag'), night: numberIn(temp, 'night', 21, 5, 40, 'Temperatur Nacht'), tolerance: numberIn(temp, 'tolerance', 1, 0.2, 10, 'Temperatur-Toleranz') }
  const humi = body.humi || {}
  cfg.humi = { day: numberIn(humi, 'day', 60, 20, 95, 'Luftfeuchte Tag'), night: numberIn(humi, 'night', 55, 20, 95, 'Luftfeuchte Nacht'), tolerance: numberIn(humi, 'tolerance', 4, 1, 30, 'Feuchte-Toleranz') }
  const vpd = body.vpd || {}
  cfg.vpd = { day: numberIn(vpd, 'day', 1.2, 0.2, 3, 'VPD Tag'), night: numberIn(vpd, 'night', 0.9, 0.2, 3, 'VPD Nacht'), tolerance: numberIn(vpd, 'tolerance', 0.15, 0.02, 1, 'VPD-Toleranz') }
  const co2 = body.co2 || {}
  cfg.co2 = { enabled: !!co2.enabled, day: numberIn(co2, 'day', 900, 300, 3000, 'CO₂-Ziel'), tolerance: numberIn(co2, 'tolerance', 100, 10, 1000, 'CO₂-Toleranz') }
  const seen = new Set()
  const taken = Object.fromEntries(Object.entries(managed()).filter(([, v]) => v !== roomId))
  cfg.outputs = (body.outputs || []).map((raw) => {
    const role = raw.role
    if (!(role in ROLE_NAMES)) fail(400, 'Unbekannte Aufgabe für einen Ausgang.')
    if (!raw.device_id || !raw.control_id) fail(400, `Wähle einen Ausgang für „${ROLE_NAMES[role]}“.`)
    const key = `${raw.device_id}|${raw.control_id}`
    if (seen.has(key)) fail(400, 'Ein Ausgang kann nur eine Aufgabe haben.')
    if (taken[key] && role !== 'light') fail(400, 'Ein Ausgang wird schon von der Zeltsteuerung eines anderen Raums gesteuert.')
    seen.add(key)
    const device = devices.get(raw.device_id)
    const control = device?.controls.find((c) => c.id === raw.control_id)
    if (device && !control) fail(400, `${device.name} hat keinen Ausgang „${raw.control_id}“.`)
    const out = { device_id: raw.device_id, control_id: raw.control_id, role }
    if (control && role !== 'light' && !control.features.includes('on_off') && !control.features.includes('level')) {
      fail(400, `„${control.label}“ an ${device.name} lässt sich nicht schalten.`)
    }
    const hasLevel = control ? control.features.includes('level') : ['min_level', 'max_level', 'day_level', 'night_level'].some((k) => raw[k] != null)
    const lo = control && hasLevel ? control.level_min : 0
    const hi = control && hasLevel ? control.level_max : 100
    if (role === 'exhaust' && hasLevel) {
      out.min_level = numberIn(raw, 'min_level', lo, lo, hi, 'Abluft minimal')
      out.max_level = numberIn(raw, 'max_level', hi, lo, hi, 'Abluft maximal')
      if (out.min_level > out.max_level) fail(400, 'Die minimale Abluft-Stufe liegt über der maximalen.')
    }
    if (role === 'circulation' && hasLevel) {
      out.day_level = numberIn(raw, 'day_level', hi, lo, hi, 'Umluft Tag')
      out.night_level = numberIn(raw, 'night_level', lo, lo, hi, 'Umluft Nacht')
    }
    return out
  })
  if (cfg.outputs.length > 40) fail(400, 'Höchstens 40 Ausgänge pro Raum.')
  return cfg
}

// ---------------------------------------------------------------- alarms
const PLAN_METRICS = {
  temp: { label: 'Temperatur', unit: '°C', words: ['zu kühl', 'zu warm'], margin: 1.0, hyst: 0.3, digits: 1 },
  humi: { label: 'Luftfeuchte', unit: '%', words: ['zu trocken', 'zu feucht'], margin: 5.0, hyst: 1.5, digits: 0 },
  vpd: { label: 'VPD', unit: 'kPa', words: ['zu feucht', 'zu trocken'], margin: 0.15, hyst: 0.04, digits: 2 },
}
const bandText = (band, digits) => band.map((v) => (digits < 2 ? deG(v) : v.toFixed(2).replace(/0+$/, '').replace(/[.,]$/, '').replace('.', ',') || '0')).join('–')

function evaluateSensorAlarm(alarm, t) {
  const state = alarmStates[alarm.id] || (alarmStates[alarm.id] = { firing: false, out_since: null, value: null })
  if (alarm.enabled === false) {
    Object.assign(state, { firing: false, out_since: null })
    return
  }
  const device = devices.get(alarm.device_id)
  const sensor = device?.sensors.find((s) => s.key === alarm.sensor)
  if (!device?.online || sensor?.value == null) return
  const value = Number(sensor.value)
  state.value = value
  const low = alarm.min
  const high = alarm.max
  const margin = 0.02 * Math.max(Math.abs(low || 0), Math.abs(high || 0), 1)
  const out = state.firing
    ? (low != null && value < low + margin) || (high != null && value > high - margin)
    : (low != null && value < low) || (high != null && value > high)
  const name = alarm.name || `${device.name}: ${sensor.label}`
  const unit = sensor.unit ? ` ${sensor.unit}` : ''
  if (out) {
    state.out_since = state.out_since || t
    if (!state.firing && t - state.out_since >= Number(alarm.delay_minutes ?? 5) * 60) {
      state.firing = true
      const limits = [low != null ? `min ${deG(low)}` : null, high != null ? `max ${deG(high)}` : null].filter(Boolean).join(', ')
      addEvent('alarm', 'alarm', `Alarm: ${name} liegt bei ${deG(value)}${unit} (${limits})`, device.id,
        { alarm_id: alarm.id, value, resolved: false, sensor: sensor.label, unit: sensor.unit })
    }
  } else {
    state.out_since = null
    if (state.firing) {
      state.firing = false
      addEvent('info', 'alarm', `Wieder im Bereich: ${name} (${deG(value)}${unit})`, device.id,
        { alarm_id: alarm.id, value, resolved: true, sensor: sensor.label, unit: sensor.unit })
    }
  }
}

function evaluatePlanAlarm(alarm, t, seed = false) {
  const state = alarmStates[alarm.id] || (alarmStates[alarm.id] = { firing: false, value: null, metrics: {}, message: null })
  state.message = null
  const room = rooms.find((r) => r.id === alarm.room_id)
  const bands = room ? bandsForRoom(room.id) : null
  if (alarm.enabled === false || !room || !bands) {
    for (const ms of Object.values(state.metrics)) Object.assign(ms, { firing: false, out_since: null })
    state.firing = false
    if (!room) state.message = 'Das Zelt gibt es nicht mehr.'
    else if (!bands && alarm.enabled !== false) state.message = 'Das Zelt hat keinen Growplan. Der Alarm wartet, bis es einen gibt.'
    return
  }
  const cfg = roomConfig(room.id)
  const [day] = roomDay(room, cfg, t)
  const phase = day ? 'day' : 'night'
  const readings = roomReadings(room, cfg)
  const delay = Number(alarm.delay_minutes ?? 30) * 60
  for (const metric of alarm.metrics || []) {
    const spec = PLAN_METRICS[metric]
    if (!spec) continue
    const ms = state.metrics[metric] || (state.metrics[metric] = { firing: false, out_since: null, value: null, band: null })
    const band = bands[metric][phase]
    Object.assign(ms, { band, phase })
    const value = readings[metric]
    if (value == null) continue
    ms.value = value
    const margin = alarm.strict ? 0 : spec.margin
    const keep = Math.max(0, margin - spec.hyst)
    const out = ms.firing ? value < band[0] - keep || value > band[1] + keep : value < band[0] - margin || value > band[1] + margin
    const shown = `${de(value, spec.digits)} ${spec.unit}`
    const target = `${bandText(band, spec.digits)} ${spec.unit}`
    if (out) {
      // the demo starts with an alarm that has been out for a while, so the page shows one
      ms.out_since = ms.out_since || (seed ? t - delay - 14 * 60 : t)
      if (!ms.firing && t - ms.out_since >= delay) {
        ms.firing = true
        const at = seed ? t - 14 * 60 : t
        const minutes = Math.round((at - ms.out_since) / 60)
        const word = value < band[0] ? spec.words[0] : spec.words[1]
        addEvent('alarm', 'alarm', `${room.name} ${word}: ${spec.label} ${shown} statt ${target} (Growplan, ${bands.stage_name}${minutes >= 1 ? `, seit ${minutes} min` : ''})`,
          null, { alarm_id: alarm.id, room_id: room.id, metric, value, band, resolved: false, unit: spec.unit }, at, seed)
      }
    } else {
      ms.out_since = null
      if (ms.firing) {
        ms.firing = false
        addEvent('info', 'alarm', `${room.name}: ${spec.label} wieder im Ziel (${shown}, Ziel ${target})`, null,
          { alarm_id: alarm.id, room_id: room.id, metric, value, band, resolved: true, unit: spec.unit })
      }
    }
  }
  for (const metric of Object.keys(state.metrics)) if (!(alarm.metrics || []).includes(metric)) delete state.metrics[metric]
  state.firing = Object.values(state.metrics).some((ms) => ms.firing)
}

function evaluateAlarms(seed = false) {
  const t = nowS()
  for (const alarm of alarms) {
    if (alarm.kind === 'growplan') evaluatePlanAlarm(alarm, t, seed)
    else evaluateSensorAlarm(alarm, t)
  }
}
const alarmStatus = () => clone(alarmStates)

function saveAlarm(body, id) {
  const alarm = { ...clone(body), id: id || `a_${Math.floor(hash(String(Date.now() + nextId++)) * 1e12).toString(16).slice(0, 10)}` }
  let clean
  if (alarm.kind === 'growplan') {
    const room = rooms.find((r) => r.id === String(alarm.room_id || ''))
    if (!room) fail(400, 'Wähle das Zelt, dessen Growplan der Alarm folgen soll.')
    const metrics = Object.keys(PLAN_METRICS).filter((m) => (alarm.metrics || []).includes(m))
    if (!metrics.length) fail(400, 'Wähle mindestens einen Messwert: Temperatur, Luftfeuchte oder VPD.')
    const delay = Number(alarm.delay_minutes ?? 30)
    if (Number.isNaN(delay)) fail(400, 'Die Verzögerung muss eine Zahl sein.')
    clean = {
      id: alarm.id, kind: 'growplan', name: String(alarm.name || '').trim().slice(0, 80) || `${room.name}: Growplan-Ziele`, room_id: room.id, metrics,
      delay_minutes: Math.max(0, Math.min(1440, delay)), strict: !!alarm.strict, enabled: alarm.enabled !== false,
    }
  } else {
    delete alarm.kind
    if (!alarm.device_id || !alarm.sensor) fail(400, 'Wähle einen Sensor für den Alarm.')
    const empty = (v) => v == null || v === ''
    if (empty(alarm.min) && empty(alarm.max)) fail(400, 'Gib mindestens eine untere oder obere Grenze an.')
    const low = empty(alarm.min) ? null : Number(alarm.min)
    const high = empty(alarm.max) ? null : Number(alarm.max)
    const delay = Number(alarm.delay_minutes ?? 5) || 0
    if ([low, high].some((v) => v != null && Number.isNaN(v)) || Number.isNaN(delay)) fail(400, 'Grenzen und Verzögerung müssen Zahlen sein.')
    if (low != null && high != null && low >= high) fail(400, 'Die untere Grenze muss kleiner als die obere sein.')
    clean = { ...alarm, min: low, max: high, delay_minutes: Math.max(0, Math.min(1440, delay)) }
    if (clean.enabled === undefined) clean.enabled = true
  }
  alarms = alarms.some((a) => a.id === clean.id) ? alarms.map((a) => (a.id === clean.id ? clean : a)) : [...alarms, clean]
  delete alarmStates[clean.id]
  evaluateAlarms()
  return clean
}

// ------------------------------------------------------------ evaluation
function evaluate() {
  const t = nowS()
  const managedMap = managed()
  for (const rule of rules) {
    const trig = rule.trigger || {}
    const status = automation.rules[rule.id] || (automation.rules[rule.id] = { active: null, value: null, since: t, error: null })
    let active = null
    let value = null
    if (trig.type === 'threshold') {
      const sensor = devices.get(trig.device_id)?.sensors.find((s) => s.key === trig.sensor)
      value = sensor?.value ?? null
      if (value != null) active = trig.op === 'above' ? value > Number(trig.value) : value < Number(trig.value)
    } else if (trig.type === 'schedule') {
      active = isDay(t, { day_start: trig.start, day_end: trig.end })
    } else if (trig.type === 'cycle') {
      const on = Number(trig.on_minutes) * 60
      const off = Number(trig.off_minutes) * 60
      active = t % (on + off) < on
    } else if (trig.type === 'device_state') {
      const d = devices.get(trig.device_id)
      const c = d?.controls.find((x) => x.id === trig.control_id)
      if (d?.online && c && c.on != null) {
        value = c.on ? 1 : 0
        active = !!c.on === (trig.state === 'on')
      }
    }
    if (active !== status.active) status.since = t
    Object.assign(status, { active: rule.enabled === false ? null : active, value, last_eval: t })
    if (rule.enabled === false || active == null || !automation.enabled) continue
    const target = rule.target || {}
    const key = `${target.device_id}|${target.control_id}`
    const action = active ? rule.active_action : rule.inactive_action
    if (!action) continue
    if (managedMap[key]) {
      const room = rooms.find((x) => x.id === managedMap[key])
      status.error = `Wird von der Zeltsteuerung „${room?.name || managedMap[key]}“ gesteuert. Die Regel schaltet diesen Ausgang nicht.`
      continue
    }
    status.error = null
    const signature = `${rule.id}|${JSON.stringify(action)}`
    const d = devices.get(target.device_id)
    const c = d?.controls.find((x) => x.id === target.control_id)
    if (!c || ruleSent[key] === signature) continue
    ruleSent[key] = signature
    if (satisfied(c, action)) continue
    const patch = Object.fromEntries(Object.entries(action).filter(([k, v]) => ['on', 'level', 'mode', 'option'].includes(k) && v != null))
    const error = actuate(d, c, patch, `automation:${rule.id}`)
    if (error) status.error = error
    else addEvent('info', 'automation', `„${rule.name}“ schaltet ${c.label} an ${d.name}: ${actionLabel(action)}`, d.id, { rule_id: rule.id, action })
  }
  for (const room of rooms) {
    const cfg = roomConfigs[room.id]
    if (cfg) roomStatus[room.id] = evaluateRoom(room, cfg)
  }
  evaluateAlarms()
}

function tick() {
  const changed = []
  for (const d of devices.values()) {
    if (!d.online) continue
    const temps = {}
    for (const s of d.sensors) {
      const base = baseline.get(`${d.id}|${s.key}`)
      if (s.value == null || base == null) continue
      const seed = hash(d.id + s.key)
      if (s.kind === 'temp') s.value = round(Math.min(base + 1.2, Math.max(base - 1.2, s.value + (Math.random() - 0.5) * 0.12)), 2)
      else if (s.kind === 'humi') s.value = round(Math.min(base + 4, Math.max(base - 4, s.value + (Math.random() - 0.5) * 0.6)), 1)
      else if (s.kind === 'co2') s.value = Math.round(base + 60 * Math.sin(nowS() / 600 + seed * 6) + (Math.random() - 0.5) * 8)
      else if (s.kind === 'ppfd' && base > 0) s.value = Math.round(base + (Math.random() - 0.5) * 12)
      s.updated = nowS()
      const group = s.group || ''
      if (s.kind === 'temp' || s.kind === 'humi') (temps[group] ||= {})[s.kind] = s.value
    }
    for (const s of d.sensors) {
      const pair = temps[s.group || '']
      if (s.kind === 'vpd' && pair?.temp != null && pair?.humi != null) s.value = round(vpdOf(pair.temp, pair.humi), 2)
    }
    d.last_seen = nowS()
    changed.push(d)
  }
  evaluate()
  if (changed.length) broadcast('devices', changed)
  if (Object.keys(roomConfigs).length) broadcast('room_control', statusAll())
}

// --------------------------------------------------------------- devices
function logControl(d, c, source = 'user') {
  controlLog.push({ ts: Math.round(nowS()), device_id: d.id, control_id: c.id, on_state: c.on ? 1 : 0, level: c.level, source })
}

function command(d, c, patch, source = 'user') {
  if (!d.online) fail(400, `${d.name} ist offline.`)
  if (!c.features?.length) fail(400, 'Dieser Ausgang lässt sich nicht steuern.')
  if (patch.mode != null) setMode(c, String(patch.mode))
  if (patch.option != null) c.value = String(patch.option)
  if (patch.level != null) c.level = Number(patch.level)
  if (patch.on != null) c.on = Boolean(patch.on)
  if (d.vendor === 'spiderfarmer') {
    if ((patch.on != null || patch.level != null) && patch.mode == null && c.modes?.some((m) => m.key === '0')) setMode(c, '0')
    if (patch.level != null && patch.on == null) c.on = Number(patch.level) > 0
  } else if (d.vendor === 'vivosun') {
    if (patch.level != null && patch.on == null) c.on = Number(patch.level) > 0
    // GrowHub A10/A22: switching by hand means manual, like the app does
    if (c.type === 'outlet' && patch.on != null && patch.mode == null && c.mode != null && c.mode !== '0') setMode(c, '0')
    if (c.native?.reported && c.type === 'outlet') c.native.reported = { ...c.native.reported, on: c.on ? 1 : 0, ...(c.mode != null ? { mode: Number(c.mode) } : {}) }
  } else if (d.vendor === 'acinfinity') {
    if (patch.on === true && patch.mode == null) setMode(c, '2')
    if (patch.on === false) setMode(c, '1')
    if (patch.level != null && patch.on == null && c.mode === '1') setMode(c, '2')
    if (c.mode === '2') c.on = true
    if (c.mode === '1') c.on = false
    if (c.extra && c.extra.current_level != null) c.extra.current_level = c.on ? c.level : 0
  }
  for (const key of ['natural_wind', 'oscillate', 'night_mode', 'spectrum', 'target_temp', 'target_humi', 'fan_level', 'close_co2']) {
    if (patch[key] != null) c.extra = { ...c.extra, [key]: patch[key] }
  }
  if (patch.auto) c.extra = { ...c.extra, auto: { ...(c.extra?.auto || {}), ...patch.auto } }
  logControl(d, c, source)
  broadcast('devices', [d])
  return c
}

function native(d, body) {
  const action = body.action || 'get'
  if (Array.isArray(body.keyPath)) {
    const path = body.keyPath.join('/')
    const key = `${d.id}|${path}`
    const control = d.controls.find((c) => (c.native?.keyPath?.join('/') || (c.features?.includes('sf_outlet') ? `outlet/${c.id}` : '')) === path)
    if (action === 'get') {
      const value = natives[key] ?? control?.native?.config
      if (value == null) fail(400, 'Das Gerät hat nicht geantwortet.')
      return { keyPath: body.keyPath, value: clone(value) }
    }
    if (!body.value || typeof body.value !== 'object') fail(400, 'value muss ein Objekt sein.')
    natives[key] = clone(body.value)
    if (control) {
      control.native = { ...control.native, config: clone(body.value) }
      if (body.value?.modeType != null) setMode(control, String(body.value.modeType))
      broadcast('devices', [d])
    }
    return { keyPath: body.keyPath, value: clone(body.value) }
  }
  if (body.control_id) {
    const key = `${d.id}|${body.control_id}`
    const control = d.controls.find((c) => c.id === body.control_id)
    if (!natives[key] || !control) fail(400, 'Für diesen Ausgang gibt es keine erweiterten Einstellungen.')
    if (action === 'get') return clone(natives[key])
    const value = body.value || {}
    if (value.auto?.temp_high != null && (value.auto.temp_high < 0 || value.auto.temp_high > 90)) fail(400, 'Temperatur oben muss zwischen 0 und 90 liegen.')
    natives[key].value = { ...natives[key].value, ...clone(value) }
    if (value.mode) setMode(control, String(value.mode))
    if (value.on_speed != null && control.features.includes('level')) control.level = Number(value.on_speed)
    if (control.mode === '2') control.on = true
    if (control.mode === '1') control.on = false
    broadcast('devices', [d])
    return { ok: true, applied: {} }
  }
  fail(400, 'Für dieses Gerät gibt es keine erweiterten Einstellungen.')
  return null
}

function validateRule(rule) {
  const trig = rule.trigger || {}
  if (!String(rule.name || '').trim()) fail(400, 'Bitte gib der Regel einen Namen.')
  if (!['threshold', 'schedule', 'cycle', 'device_state'].includes(trig.type)) fail(400, 'Unbekannte Bedingung.')
  const target = rule.target || {}
  if (trig.type === 'device_state') {
    if (!trig.device_id || !trig.control_id) fail(400, 'Wähle das Gerät, dessen Zustand die Regel auslöst.')
    if (!['on', 'off'].includes(trig.state)) fail(400, 'Wähle „ist an“ oder „ist aus“.')
    if (trig.device_id === target.device_id && trig.control_id === target.control_id) fail(400, 'Ein Ausgang kann nicht auf sich selbst reagieren.')
  }
  if (trig.type === 'threshold') {
    if (!trig.device_id || !trig.sensor) fail(400, 'Wähle den Sensor, der die Regel auslöst.')
    if (!['above', 'below'].includes(trig.op)) fail(400, 'Wähle „über“ oder „unter“.')
    const bad = (v) => v === null || v === undefined || v === '' || Number.isNaN(Number(v))
    if (bad(trig.value) || (trig.hysteresis != null && trig.hysteresis !== '' && Number.isNaN(Number(trig.hysteresis)))
      || (trig.night_value != null && trig.night_value !== '' && Number.isNaN(Number(trig.night_value)))) fail(400, 'Grenzwerte müssen Zahlen sein.')
  }
  if (trig.type === 'cycle') {
    const on = Number(trig.on_minutes)
    const off = Number(trig.off_minutes)
    if (Number.isNaN(on) || Number.isNaN(off) || trig.on_minutes == null || trig.off_minutes == null) fail(400, 'An- und Aus-Dauer müssen Zahlen sein.')
    if (on <= 0 || off <= 0) fail(400, 'An- und Aus-Dauer müssen größer als 0 sein.')
  }
  if (!target.device_id || !target.control_id) fail(400, 'Wähle das Gerät, das geschaltet werden soll.')
  if (!rule.active_action || typeof rule.active_action !== 'object' || !Object.keys(rule.active_action).length) {
    fail(400, 'Lege fest, was bei erfüllter Bedingung passieren soll.')
  }
}

// ------------------------------------------------- notifications and settings
const GROUP_KEYS = () => Object.keys(settings.notify_group_labels || {})
const telegram = { token: '', bot: '', chat_id: '', chat_name: '', last_error: null }
const DEMO_BOT = { username: 'growdeck_demo_bot', name: 'GrowDeck Demo' }
const DEMO_CHATS = [
  { id: '482915736', name: 'Alex (@alex_grows)', type: 'private' },
  { id: '-1001873344521', name: 'Growzelt Keller', type: 'supergroup' },
]
function telegramStatus() {
  return {
    configured: !!telegram.token, ready: !!(telegram.token && telegram.chat_id), source: telegram.token ? 'app' : 'none',
    token_hint: telegram.token ? telegram.token.slice(-4) : '', bot: telegram.token ? telegram.bot : '',
    chat_id: telegram.chat_id || '', chat_name: telegram.chat_id ? telegram.chat_name : '', last_error: telegram.last_error,
  }
}
const settingsPayload = () => ({ ...clone(settings), telegram: telegramStatus() })
function checkToken(token) {
  const value = String(token || '').trim()
  if (!value || !value.includes(':')) fail(400, 'Der Bot-Token fehlt oder hat nicht das Format 123456789:ABC… von @BotFather.')
  return value
}

function putSettings(body) {
  checkTime(body.day_start, 'Tagbeginn')
  checkTime(body.day_end, 'Tagende')
  if (body.notify_webhook && !/^https?:\/\//.test(body.notify_webhook)) fail(400, 'Die Adresse muss mit http:// oder https:// beginnen.')
  if (body.notify_format != null && !['json', 'text'].includes(body.notify_format)) fail(400, 'Format muss json oder text sein.')
  if (body.notify_groups != null) {
    const unknown = body.notify_groups.filter((g) => !GROUP_KEYS().includes(g))
    if (unknown.length) fail(400, `Unbekannte Meldungsart: ${unknown.join(', ')}`)
    body.notify_groups = GROUP_KEYS().filter((g) => body.notify_groups.includes(g))
  }
  if (body.language != null && !['de', 'en'].includes(body.language)) fail(400, 'Sprache muss de oder en sein.')
  if (body.retention_days != null && !(body.retention_days >= 1 && body.retention_days <= 3650)) fail(400, 'Verlauf: 1 bis 3650 Tage.')
  for (const key of ['day_start', 'day_end', 'retention_days', 'notify_webhook', 'notify_format', 'notify_groups', 'vivosun_poll_seconds', 'acinfinity_poll_seconds', 'language']) {
    if (body[key] != null) settings[key] = clone(body[key])
  }
  return settingsPayload()
}

function testNotification(body) {
  const channel = body?.channel || null
  const results = {}
  if ((channel == null || channel === 'webhook') && (settings.notify_webhook || channel === 'webhook')) {
    results.webhook = settings.notify_webhook ? { ok: true, detail: 'HTTP 200' } : { ok: false, detail: 'Keine Benachrichtigungs-Adresse eingetragen.' }
  }
  if (channel == null || channel === 'telegram') {
    if (telegram.token && telegram.chat_id) results.telegram = { ok: true, detail: 'gesendet' }
    else if (channel === 'telegram') results.telegram = { ok: false, detail: 'Bot-Token und Chat fehlen noch.' }
  }
  if (!Object.keys(results).length) fail(400, 'Es ist noch kein Weg eingerichtet: trag eine Adresse ein oder verbinde Telegram.')
  const failed = Object.entries(results).filter(([, r]) => !r.ok).map(([k, r]) => `${k === 'telegram' ? 'Telegram' : 'Adresse'}: ${r.detail}`)
  if (failed.length && failed.length === Object.keys(results).length) fail(400, `Senden fehlgeschlagen. ${failed.join(' ')}`)
  return { ok: true, results }
}

// ---------------------------------------------------------------- backups
const backup = { enabled: true, time: '03:30', keep: 7, items: [], running: false }
const KIND_LABELS = { '': 'automatisch', manuell: 'von Hand', 'vor-wiederherstellung': 'vor Wiederherstellung', hochgeladen: 'hochgeladen' }
const DB_BYTES = 61_203_456
function backupName(ts, kind) {
  const d = new Date(ts * 1000)
  const base = `growdeck-${localISO(ts)}-${pad(d.getHours())}${pad(d.getMinutes())}${kind ? `-${kind}` : ''}`
  let name = `${base}.sqlite3.gz`
  for (let n = 2; backup.items.some((i) => i.name === name); n += 1) name = `${base}-${n}.sqlite3.gz`
  return name
}
function addBackup(ts, kind, size) {
  const item = { name: backupName(ts, kind), size: Math.round(size), created: Math.round(ts), kind, kind_label: KIND_LABELS[kind] }
  backup.items = [item, ...backup.items].sort((a, b) => b.created - a.created)
  return item
}
function nextBackup() {
  const [h, m] = backup.time.split(':').map(Number)
  const run = new Date()
  run.setHours(h, m, 0, 0)
  if (run.getTime() / 1000 <= nowS()) run.setDate(run.getDate() + 1)
  return Math.round(run.getTime() / 1000)
}
function seedBackups() {
  const first = nextBackup() - 86400
  for (let k = 5; k >= 0; k -= 1) addBackup(first - k * 86400 + 20 + hash(`b${k}`) * 30, '', 14_630_000 - k * 61_000 + hash(`s${k}`) * 20_000)
  addBackup(nowS() - 9 * 86400 - 5 * 3600, 'manuell', 14_020_000)
}
function backupStatus() {
  const lastAuto = backup.items.find((i) => i.kind === '')
  return {
    enabled: backup.enabled, time: backup.time, keep: backup.keep, items: clone(backup.items), running: backup.running, last_error: null,
    last: backup.items[0]?.created ?? null, last_auto: lastAuto?.created ?? null, next: backup.enabled ? nextBackup() : null,
    total_bytes: backup.items.reduce((sum, i) => sum + i.size, 0), database_bytes: DB_BYTES,
  }
}
function saveBackupSettings(raw) {
  if ('enabled' in raw) backup.enabled = !!raw.enabled
  if ('time' in raw) {
    if (typeof raw.time !== 'string' || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(raw.time)) fail(400, 'Die Uhrzeit bitte als HH:MM angeben.')
    backup.time = raw.time
  }
  if ('keep' in raw) {
    const keep = parseInt(raw.keep, 10)
    if (Number.isNaN(keep)) fail(400, 'Anzahl der Sicherungen bitte als Zahl angeben.')
    if (keep < 1 || keep > 60) fail(400, 'Zwischen 1 und 60 Sicherungen aufheben.')
    backup.keep = keep
  }
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function createBackup() {
  backup.running = true
  broadcast('backup', { running: true })
  await wait(900)
  const item = addBackup(nowS(), 'manuell', (backup.items.find((i) => i.kind === '')?.size || 14_600_000) + 12_000)
  backup.running = false
  broadcast('backup', { running: false })
  return { item: clone(item), ...backupStatus() }
}
function backupsRoute(method, parts, body) {
  const [, name, action] = parts
  if (!name) {
    if (method === 'GET') return backupStatus()
    return createBackup()
  }
  if (name === 'settings') {
    saveBackupSettings(body || {})
    return backupStatus()
  }
  if (name === 'upload') {
    const size = Number(body?.size) || 0
    if (!size) fail(400, 'Die Datei ist leer.')
    if (size > 4 * 1024 ** 3) fail(400, 'Die Datei ist zu groß (höchstens 4 GB).')
    const item = addBackup(nowS(), 'hochgeladen', size)
    return { item: { ...clone(item), summary: { readings: 1_843_220, rooms: rooms.length, growplans: growplans().length } }, ...backupStatus() }
  }
  const item = backup.items.find((i) => i.name === name)
  if (!item) fail(404, 'Diese Sicherung gibt es nicht mehr.')
  if (action === 'restore') fail(400, 'In der Demo lässt sich keine Sicherung wiederherstellen.')
  if (method === 'DELETE') {
    backup.items = backup.items.filter((i) => i.name !== name)
    return backupStatus()
  }
  fail(404, 'Unbekannte Sicherung.')
  return null
}

// -------------------------------------------------------- demo history
// Events of the last days with the backend's texts, so the log is not empty.
function seedEvents() {
  const t = nowS()
  const dev = (id) => devices.get(id)
  const name = (id, fallback) => dev(id)?.name || fallback
  const snap = (DATA.events || []).map((e) => ({ ...e, ts: shiftTs(e.ts) }))
  for (const e of snap.reverse()) addEvent(e.level, e.category, e.message, e.device_id, e.data, e.ts, true)
  const add = (hoursAgo, level, category, message, deviceId = null, data = null) => addEvent(level, category, message, deviceId, data, t - hoursAgo * 3600, true)
  const zelt1 = rooms.find((r) => r.id === 'zelt-1')
  const plan = zelt1 ? planForRoom(zelt1.id) : null
  // recognised watering (the pending suggestion) and yesterday's reminder
  for (const s of (plan && wateringPayload().suggestions[plan.id]) || []) {
    addEvent('info', 'water', `${zelt1.name}: Bodenfeuchte von ${de(s.before, 0)} % auf ${de(s.after, 0)} % gestiegen. Gegossen? Im Growplan lässt sich die Gießung mit einem Klick eintragen.`,
      'sf-5ff0cb000001', { room_id: zelt1.id, plan_id: plan.id, suggestion: s.id }, s.ts, true)
  }
  const cfg = plan && wateringPayload().settings[plan.id]
  if (cfg?.days) {
    const yesterday = addDays(todayISO(), -1)
    const last = lastWateringBefore(plan.id, yesterday)
    const days = last ? Math.round((Date.parse(`${yesterday}T12:00:00Z`) - Date.parse(`${last.date}T12:00:00Z`)) / 86400000) : 0
    if (last && days >= cfg.days) {
      const [h, m] = cfg.time.split(':').map(Number)
      const when = `${last.date.slice(8, 10)}.${last.date.slice(5, 7)}.`
      addEvent('info', 'water', `${zelt1.name}: Gießen fällig? Letzte Gießung vor ${days} Tagen (${when}).`, null,
        { room_id: zelt1.id, plan_id: plan.id, reminder: 'days', days }, new Date(`${yesterday}T00:00:00`).getTime() / 1000 + h * 3600 + m * 60 + 25, true)
    }
  }
  add(1.3, 'info', 'automation', `Zeltsteuerung ${zelt1?.name || 'Zelt 1'}: Befeuchter (Befeuchter, ${name('vs-900000000000000102', 'AeroStream H19')}) an, 54 % unter 56 % (VPD 1,41 kPa)`, 'vs-900000000000000102', { room_id: 'zelt-1', role: 'humidifier' })
  add(0.9, 'info', 'automation', `Zeltsteuerung ${zelt1?.name || 'Zelt 1'}: Befeuchter (Befeuchter, ${name('vs-900000000000000102', 'AeroStream H19')}) aus, Luftfeuchte im Zielbereich`, 'vs-900000000000000102', { room_id: 'zelt-1', role: 'humidifier' })
  const rule = rules.find((r) => r.trigger?.type === 'device_state')
  const target = rule && dev(rule.target.device_id)
  const label = target?.controls.find((c) => c.id === rule.target.control_id)?.label
  if (rule && target && label) {
    add(3.2, 'info', 'automation', `„${rule.name}“ schaltet ${label} an ${target.name}: Ein`, target.id, { rule_id: rule.id, action: { on: true } })
    add(2.6, 'info', 'automation', `„${rule.name}“ schaltet ${label} an ${target.name}: Aus`, target.id, { rule_id: rule.id, action: { on: false } })
  }
  const humidifier = name('vs-900000000000000102', 'AeroStream H19')
  add(5.4, 'warning', 'water', `${humidifier}: Wassertank fast leer, bitte nachfüllen.`, 'vs-900000000000000102', { control: 'hmdf', tank: 'low' })
  add(4.9, 'info', 'water', `${humidifier}: Wassertank wieder gefüllt.`, 'vs-900000000000000102', { control: 'hmdf', tank: 'ok', resolved: true })
  const cam = name('vs-900000000000000107', 'GrowCam C4')
  add(9.1, 'warning', 'device', `${cam} sendet keine Daten mehr.`, 'vs-900000000000000107', { online: false })
  add(8.8, 'info', 'device', `${cam} sendet wieder Daten.`, 'vs-900000000000000107', { online: true })
  const sensorAlarm = alarms.find((a) => !a.kind)
  if (sensorAlarm) {
    add(26.2, 'alarm', 'alarm', `Alarm: ${sensorAlarm.name} liegt bei 30,6 °C (min ${deG(sensorAlarm.min)}, max ${deG(sensorAlarm.max)})`, sensorAlarm.device_id, { alarm_id: sensorAlarm.id, value: 30.6, resolved: false, sensor: 'Temperatur', unit: '°C' })
    add(25.5, 'info', 'alarm', `Wieder im Bereich: ${sensorAlarm.name} (29,3 °C)`, sensorAlarm.device_id, { alarm_id: sensorAlarm.id, value: 29.3, resolved: true, sensor: 'Temperatur', unit: '°C' })
  }
  add(30, 'info', 'automation', 'Automationen pausiert.')
  add(29.6, 'info', 'automation', 'Automationen eingeschaltet.')
  add(52, 'info', 'device', `Neues Gerät erkannt: ${name('vs-900000000000000109', 'GrowHub A22')}`, 'vs-900000000000000109')
  for (const e of store.events) if (e.level !== 'info' && t - e.ts > 6 * 3600) e.acknowledged = 1
}

// ------------------------------------------------------------------ routes
async function route(method, url, body) {
  const [pathname, search = ''] = url.replace(/^\/api/, '').split('?')
  const q = new URLSearchParams(search)
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent)
  const [a, b, c, d2] = parts
  const t = nowS()

  if (a === 'health') return { ok: true }
  if (a === 'auth') {
    if (b === 'me') return { authenticated: authed, password_generated: false, version }
    if (b === 'login') {
      if (!body?.password) fail(401, 'Passwort ist falsch.')
      authed = true
      return { ok: true }
    }
    if (b === 'logout') {
      authed = false
      return { ok: true }
    }
  }
  if (!authed) fail(401, 'Bitte anmelden.')

  switch (a) {
    case 'state':
      return {
        devices: [...devices.values()], rooms, integrations, settings: settingsPayload(), automation, room_control: statusAll(), growplans: growplans(),
        watering: wateringPayload(), alarms: alarmStatus(), unread_events: store.events.filter((e) => !e.acknowledged && ['warning', 'alarm'].includes(e.level)).length,
        server_time: t, version,
      }
    case 'devices': {
      if (!b) return [...devices.values()]
      const dev = devices.get(b) || fail(404, 'Gerät nicht gefunden.')
      if (!c) {
        if (method === 'GET') return { ...dev, raw: { hinweis: 'In der Demo gibt es keine Rohdaten. Mit echten Geräten stehen hier die Originalnachrichten.' }, config: {} }
        if (method === 'DELETE') {
          if (dev.online) fail(409, 'Nur Geräte, die offline sind, können entfernt werden.')
          devices.delete(b)
          broadcast('device_removed', { id: b })
          return { ok: true }
        }
        if (body.name != null) dev.name = body.name.trim().slice(0, 80) || dev.info.default_name || dev.model
        if (body.clear_room) dev.info.room_id = null
        else if (body.room_id != null) dev.info.room_id = body.room_id
        if (body.hidden != null) dev.info.hidden = !!body.hidden
        broadcast('devices', [dev])
        return dev
      }
      if (c === 'controls') {
        const control = dev.controls.find((x) => x.id === d2) || fail(404, 'Ausgang nicht gefunden.')
        if (method === 'PATCH') {
          control.label = String(body.label || '').trim().slice(0, 60) || control.extra?.default_label || control.label
          broadcast('devices', [dev])
          return { ok: true }
        }
        return command(dev, control, body || {})
      }
      if (c === 'native') return native(dev, body || {})
      if (c === 'refresh') return { ok: true }
      break
    }
    case 'rooms': {
      if (c === 'control') {
        const room = rooms.find((x) => x.id === b) || fail(404, 'Raum nicht gefunden.')
        if (method === 'GET') {
          return { config: roomConfig(b), status: statusAll()[b] || null, roles: ROLE_NAMES, type_roles: TYPE_ROLES, growplan: targetsForRoom(b) }
        }
        const cfg = normalizeRoomControl(b, body || {})
        roomConfigs[b] = cfg
        roomStatus[b] = evaluateRoom(room, cfg)
        addEvent('info', 'automation', `Zeltsteuerung ${room.name} ${cfg.enabled ? 'ist aktiv' : 'ist gespeichert, aber ausgeschaltet'}.`)
        return { config: clone(cfg), status: statusAll()[b] }
      }
      if (c === 'devices') {
        rooms.find((x) => x.id === b) || fail(404, 'Raum nicht gefunden.')
        const wanted = new Set(body.device_ids || [])
        const changed = []
        for (const dev of devices.values()) {
          if (wanted.has(dev.id) && dev.info.room_id !== b) { dev.info.room_id = b; changed.push(dev) }
          else if (!wanted.has(dev.id) && dev.info.room_id === b) { dev.info.room_id = null; changed.push(dev) }
        }
        if (changed.length) broadcast('devices', changed)
        return { ok: true, devices: [...wanted].sort() }
      }
      if (method === 'GET') return rooms
      if (method === 'POST' || method === 'PUT') {
        if (!String(body.name || '').trim()) fail(400, 'Gib dem Raum einen Namen.')
        checkTime(body.day_start, 'Tagbeginn')
        checkTime(body.day_end, 'Tagende')
        const room = {
          sort: 0, climate_device_id: null, climate_group: null, day_start: '06:00', day_end: '00:00', stage: 'veg', ...body,
          name: String(body.name).trim().slice(0, 60), id: method === 'POST' ? `room-${Math.floor(hash(String(Date.now())) * 0xffffffff).toString(16).padStart(8, '0')}` : b,
        }
        rooms = method === 'POST' ? [...rooms, room] : rooms.map((r) => (r.id === b ? room : r))
        rooms.sort((x, y) => (x.sort ?? 0) - (y.sort ?? 0))
        broadcast('rooms', rooms)
        return room
      }
      if (method === 'DELETE') {
        rooms = rooms.filter((r) => r.id !== b)
        delete roomConfigs[b]
        delete roomStatus[b]
        for (const dev of devices.values()) if (dev.info?.room_id === b) dev.info.room_id = null
        roomDeleted(b)
        broadcast('rooms', rooms)
        broadcast('devices', [...devices.values()])
        return { ok: true }
      }
      break
    }
    case 'growplan':
      return growplanRoute(method, parts, body || {})
    case 'grows':
      return growsRoute(method, parts, body || {})
    case 'cameras':
    case 'photos':
      return camerasRoute(method, parts, body, q)
    case 'history':
      if (b === 'metrics') return [...devices.values()].flatMap((dev) => dev.sensors.map((s) => ({ device_id: dev.id, metric: s.key, n: 500, last: Math.round(t) })))
      return history(q)
    case 'climate':
      if (b === 'history') return climateHistory(q)
      break
    case 'control-log': {
      const since = t - Number(q.get('hours') || 24) * 3600
      return controlLog.filter((r) => (!q.get('device_id') || r.device_id === q.get('device_id')) && r.ts >= since).sort((x, y) => y.ts - x.ts).slice(0, 500)
    }
    case 'rules': {
      if (method === 'GET') return { rules, status: automation }
      if (b === 'order') {
        const order = body.ids || []
        rules = [...rules].sort((x, y) => order.indexOf(x.id) - order.indexOf(y.id))
        return { ok: true }
      }
      if (method === 'POST' || method === 'PUT') {
        const rule = { ...clone(body), id: method === 'POST' ? `r_${Math.floor(hash(String(Date.now() + nextId++)) * 1e12).toString(16).slice(0, 10)}` : b }
        validateRule(rule)
        rules = method === 'POST' ? [...rules, rule] : rules.map((r) => (r.id === b ? rule : r))
        evaluate()
        return rule
      }
      if (method === 'DELETE') {
        rules = rules.filter((r) => r.id !== b)
        delete automation.rules[b]
        return { ok: true }
      }
      break
    }
    case 'automation':
      automation.enabled = !!body.enabled
      addEvent('info', 'automation', automation.enabled ? 'Automationen eingeschaltet.' : 'Automationen pausiert.')
      return automation
    case 'alarms': {
      if (method === 'GET') return { alarms, status: alarmStatus() }
      if (method === 'POST') return saveAlarm(body || {}, null)
      if (method === 'PUT') return saveAlarm(body || {}, b)
      if (method === 'DELETE') {
        alarms = alarms.filter((x) => x.id !== b)
        delete alarmStates[b]
        return { ok: true }
      }
      break
    }
    case 'events': {
      if (b === 'ack') {
        const ids = body?.ids
        for (const e of store.events) if (!ids || ids.includes(e.id)) e.acknowledged = 1
        broadcast('events_ack', { ids: ids || null })
        return { ok: true }
      }
      const limit = Math.max(1, Math.min(Number(q.get('limit')) || 200, 1000))
      return clone(store.events.filter((e) => !q.get('category') || e.category === q.get('category')).slice(0, limit))
    }
    case 'settings':
      if (!b) return method === 'PUT' ? putSettings(body || {}) : settingsPayload()
      if (b === 'test-notification') return testNotification(body)
      if (b === 'telegram') {
        if (c === 'chats') {
          checkToken(String(body?.token || '').trim() || telegram.token)
          return { bot: clone(DEMO_BOT), chats: clone(DEMO_CHATS) }
        }
        if (method === 'DELETE') {
          Object.assign(telegram, { token: '', bot: '', chat_id: '', chat_name: '', last_error: null })
          addEvent('info', 'integration', 'Telegram-Benachrichtigungen entfernt.')
          return settingsPayload()
        }
        const token = String(body?.token || '').trim()
        if (token) {
          telegram.token = checkToken(token)
          telegram.bot = DEMO_BOT.username
        }
        if (body?.chat_id != null) {
          const chatId = String(body.chat_id).trim()
          if (chatId && !/^(-?\d{1,20}|@[A-Za-z0-9_]{5,64})$/.test(chatId)) fail(400, 'Die Chat-ID ist eine Zahl (Gruppen beginnen mit -) oder @kanalname.')
          telegram.chat_id = chatId
          telegram.chat_name = String(body.chat_name || '').trim()
        }
        addEvent('info', 'integration', 'Telegram-Benachrichtigungen eingerichtet.')
        return settingsPayload()
      }
      break
    case 'backups':
      return backupsRoute(method, parts, body)
    case 'integrations':
      if (method === 'GET' || c === 'reconnect' || method === 'DELETE') return integrations
      if (b === 'vivosun') fail(409, 'Im Demo-Modus ist Vivosun simuliert. SIMULATE_VIVOSUN=false setzen, um dein Konto zu verbinden.')
      if (b === 'acinfinity') fail(409, 'Im Demo-Modus ist AC Infinity simuliert. SIMULATE_ACINFINITY=false setzen, um dein Konto zu verbinden.')
      break
    case 'system':
      return {
        version, uptime: t - startedAt, python: DATA.system?.python || '3.12.7', db_size: DB_BYTES, samples_written: Math.round(48213 + (t - startedAt) / 7),
        websocket_clients: sockets.size, mqtt: DATA.system?.mqtt || 'mosquitto:1883', timezone: settings.timezone || 'Europe/Berlin',
        language: settings.language || 'de', demo: { spiderfarmer: true, vivosun: true, acinfinity: true },
      }
    default:
      break
  }
  fail(404, 'Nicht gefunden.')
  return null
}

// ------------------------------------------------------------- live socket
class MockSocket {
  constructor() {
    this.readyState = 0
    sockets.add(this)
    setTimeout(() => {
      this.readyState = 1
      this.onopen?.({})
      this.deliver(JSON.stringify({
        type: 'snapshot',
        data: { devices: [...devices.values()], rooms, growplans: growplans(), watering: wateringPayload(), server_time: nowS() },
      }))
    }, 60)
  }

  deliver(message) {
    if (this.readyState === 1) this.onmessage?.({ data: message })
  }

  send() {}

  close() {
    this.readyState = 3
    sockets.delete(this)
    this.onclose?.({ code: 1000 })
  }
}

// ------------------------------------------------------------ installation
startCameras()
refreshGrowPhotos()
seedControlLog()
seedBackups()
evaluateAlarms(true)
evaluate()
seedEvents()

let ticks = 0
setInterval(() => {
  tick()
  ticks += 1
  if (ticks % 10 === 0) {
    if (integrations.spiderfarmer) integrations.spiderfarmer.messages_in = (integrations.spiderfarmer.messages_in || 0) + 24
    broadcast('ping', { automation, room_control: statusAll(), alarms: alarmStatus(), integrations, server_time: nowS() })
  }
}, 2500)

// Growplan files are plain download links to the server (growplan/Log.jsx asks this flag).
window.GROWDECK_STATIC_DEMO = true

const realFetch = window.fetch.bind(window)
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url || String(input)
  if (!url.startsWith('/api')) return realFetch(input, init)
  const method = (init.method || 'GET').toUpperCase()
  let body = null
  if (typeof init.body === 'string') {
    try {
      body = JSON.parse(init.body)
    } catch {
      body = null
    }
  } else if (init.body != null) body = init.body // an uploaded file: only its size is used
  await new Promise((resolve) => setTimeout(resolve, 40 + Math.random() * 90))
  try {
    const data = await route(method, url, body)
    return new Response(JSON.stringify(data ?? null), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500
    if (!(err instanceof HttpError)) console.warn('demo api', method, url, err) // eslint-disable-line no-console
    return new Response(JSON.stringify({ detail: err.message }), { status, headers: { 'Content-Type': 'application/json' } })
  }
}

const RealWebSocket = window.WebSocket
window.WebSocket = function DemoWebSocket(url, protocols) {
  if (String(url).includes('/api/ws')) return new MockSocket()
  return new RealWebSocket(url, protocols)
}

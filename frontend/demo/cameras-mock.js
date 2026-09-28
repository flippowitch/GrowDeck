// Cameras for the static demo: the demo camera of Zelt 1 and the GrowCam from the Vivosun
// account, their photos, snapshots and time-lapse jobs. The pictures are drawn in the browser
// (a stylised tent whose plants grow with the date of the photo) and handed to the app through
// window.__growdeckDemo.photoUrl, the one hook in src/cameras.js.
import { addDays, daysBetween, isISO, todayISO } from '../src/growplan/engine.js'
import { DATA, broadcast, clone, ctx, fail, hash, localISO, nowS, pad, tsOf } from './core.js'
import { growList, planForRoom } from './growplan-mock.js'

const GROWCAM_ID = 'vs-900000000000000107'
let cameras = (DATA.cameras?.cameras || []).map((c) => {
  const { url_masked: a, photos: b, last_photo_ts: c2, bytes, last_error: e, job, device_name: n, ...rest } = c
  return rest
})
if (!cameras.some((c) => c.source === 'growcam') && DATA.state.devices.some((d) => d.id === GROWCAM_ID)) {
  cameras.push({
    id: 'growcam-c4', name: 'GrowCam C4', source: 'growcam', device_id: GROWCAM_ID, ip: '192.168.178.57', room_id: 'zelt-2',
    times: ['09:00'], only_light: true, enabled: true, keep_days: 90,
  })
}
const jobs = {}
let photos = []

// ------------------------------------------------------------ photos
function photoId(cameraId, ts) {
  const d = new Date(ts * 1000)
  const base = `${cameraId}/${localISO(ts)}/${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  let id = base
  for (let n = 2; photos.some((p) => p.id === id); n += 1) id = `${base}-${n}`
  return id
}
function addPhoto(camera, ts, source) {
  const photo = {
    id: photoId(camera.id, ts), camera_id: camera.id, room_id: camera.room_id || null, ts: Math.round(ts),
    size: Math.round(165000 + hash(`${camera.id}${ts}`) * 90000), source,
  }
  photos.push(photo)
  return photo
}
function seedPhotos() {
  const today = todayISO()
  const noon = (iso, time) => {
    const [h, m] = (time || '12:00').split(':').map(Number)
    return tsOf(iso, h + m / 60) + Math.round(hash(iso) * 4)
  }
  for (const camera of cameras) {
    const days = camera.source === 'growcam' ? 16 : 21
    for (let back = days; back >= 0; back -= 1) {
      const iso = addDays(today, -back)
      const ts = noon(iso, camera.times?.[0])
      if (ts < nowS()) addPhoto(camera, ts, 'auto')
    }
  }
  // the archived grows of Zelt 1: every fourth day
  const demo = cameras.find((c) => c.source === 'demo') || cameras[0]
  for (const grow of growList()) {
    if (!demo || grow.room_id !== demo.room_id || !isISO(grow.started) || !isISO(grow.harvested)) continue
    for (let iso = addDays(grow.started, 3); iso <= grow.harvested; iso = addDays(iso, 4)) addPhoto(demo, noon(iso, demo.times?.[0]), 'auto')
    addPhoto(demo, noon(grow.harvested, '09:00'), 'manual')
  }
  photos.sort((a, b) => b.ts - a.ts)
}

ctx.photosInRange = (roomId, start, end) => photos.filter((p) => p.room_id === roomId && p.ts >= start && p.ts <= end)

function listing() {
  const out = cameras.map((c) => {
    const own = photos.filter((p) => p.camera_id === c.id)
    const device = c.source === 'growcam' ? ctx.devices?.().find((d) => d.id === c.device_id) : null
    return {
      ...clone(c), url_masked: c.url ? c.url.replace(/(:\/\/[^:/@]*:)[^@]*@/, '$1***@') : '',
      photos: own.length, last_photo_ts: own.length ? Math.max(...own.map((p) => p.ts)) : null,
      bytes: own.reduce((sum, p) => sum + p.size, 0), last_error: null, job: jobs[c.id] ? clone(jobs[c.id]) : null,
      ...(c.source === 'growcam' ? { device_name: device?.name || null } : {}),
    }
  })
  const configured = new Set(cameras.filter((c) => c.source === 'growcam').map((c) => c.device_id))
  const growcams = (ctx.devices?.() || []).filter((d) => d.kind === 'camera' && d.vendor === 'vivosun' && !configured.has(d.id))
    .map((d) => ({ device_id: d.id, name: d.name, room_id: d.info?.room_id || null, has_login: !!d.info?.camera?.username }))
  return { cameras: out, growcams, ffmpeg: true, demo: true }
}

function slug(text) {
  const s = String(text).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return s.slice(0, 30) || 'kamera'
}

function cleanCamera(raw, current) {
  const base = { ...(current || {}) }
  const pick = (k, d) => (k in raw ? raw[k] : k in base ? base[k] : d)
  const name = String(pick('name', '') || '').trim().slice(0, 60)
  if (!name) fail(400, 'Bitte einen Namen für die Kamera eingeben.')
  const source = pick('source', 'url')
  if (!['growcam', 'url', 'demo'].includes(source)) fail(400, 'Unbekannte Kameraart.')
  const times = [...new Set((Array.isArray(pick('times', [])) ? pick('times', []) : []).filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)))].sort().slice(0, 6)
  const camera = {
    id: base.id, name, source, room_id: pick('room_id', null) || null, times: times.length ? times : ['12:00'],
    only_light: pick('only_light', true) !== false, enabled: pick('enabled', true) !== false,
    keep_days: Math.max(0, Math.min(3650, parseInt(pick('keep_days', 0), 10) || 0)),
  }
  if (source === 'growcam') {
    const device = ctx.devices?.().find((d) => d.id === pick('device_id', ''))
    if (!device || device.kind !== 'camera') fail(400, 'Diese GrowCam ist im Vivosun-Konto nicht zu finden.')
    const ip = String(pick('ip', '') || '').trim()
    if (!ip || !/^[A-Za-z0-9.-]{1,120}$/.test(ip)) fail(400, 'Bitte die IP-Adresse der GrowCam im Heimnetz eintragen (steht im Router).')
    Object.assign(camera, { device_id: device.id, ip })
  } else if (source === 'url') {
    let url = raw.url
    if (url == null || url === '' || (current && url === listing().cameras.find((c) => c.id === current.id)?.url_masked)) url = base.url
    url = String(url || '').trim()
    if (!/^(rtsps?|https?):\/\/[^/\s]+/i.test(url)) fail(400, 'Die Adresse muss mit rtsp://, http:// oder https:// beginnen.')
    if (url.length > 500) fail(400, 'Die Adresse ist zu lang.')
    camera.url = url
  }
  return camera
}

function getCamera(id) {
  return cameras.find((c) => c.id === id) || fail(400, 'Diese Kamera gibt es nicht.')
}

function timelapse(camera, body) {
  if (jobs[camera.id]?.running) fail(400, 'Für diese Kamera läuft schon ein Zeitraffer.')
  if (!isISO(body.start) || !isISO(body.end)) fail(400, 'Bitte Anfang und Ende als Datum angeben.')
  if (body.end < body.start) fail(400, 'Das Ende liegt vor dem Anfang.')
  const fps = Math.max(2, Math.min(30, parseInt(body.fps, 10) || 8))
  let frames = photos.filter((p) => p.camera_id === camera.id && p.ts >= tsOf(body.start) && p.ts < tsOf(addDays(body.end, 1)))
  if (body.per_day !== false) frames = [...new Set(frames.map((p) => localISO(p.ts)))]
  if (frames.length < 2) fail(400, 'Für einen Zeitraffer braucht es mindestens zwei Fotos in diesem Zeitraum.')
  const job = { running: true, frames: frames.length, file: null, error: null, started: Math.floor(nowS()), name: `zeitraffer-${body.start}-bis-${body.end}-${fps}fps.mp4` }
  jobs[camera.id] = job
  setTimeout(() => {
    Object.assign(job, { running: false, error: 'Zeitraffer-Videos gibt es in der Demo nicht.' })
    broadcast('cameras', { changed: true })
  }, 2600)
  return clone(job)
}

export function camerasRoute(method, parts, body, q) {
  const [a, b, c] = parts
  if (a === 'photos') {
    if (b === 'file') fail(404, 'Das Foto gibt es nicht mehr.')
    if (b) {
      const id = parts.slice(1).join('/')
      if (!photos.some((p) => p.id === id)) fail(404, 'Das Foto gibt es nicht mehr.')
      photos = photos.filter((p) => p.id !== id)
      return { ok: true }
    }
    const num = (k) => (q.get(k) == null || q.get(k) === '' ? null : Number(q.get(k)))
    const limit = Math.max(1, Math.min(num('limit') || 60, 500))
    const list = photos.filter((p) => (!q.get('camera_id') || p.camera_id === q.get('camera_id'))
      && (!q.get('room_id') || p.room_id === q.get('room_id'))
      && (num('start') == null || p.ts >= num('start')) && (num('end') == null || p.ts <= num('end'))
      && (num('before') == null || p.ts < num('before')))
    return { photos: list.slice(0, limit).map((p) => clone(p)) }
  }
  if (!b) {
    if (method === 'GET') return listing()
    if (cameras.length >= 12) fail(400, 'Höchstens 12 Kameras.')
    const camera = cleanCamera(body || {}, null)
    const base = slug(camera.name)
    let id = base
    for (let n = 2; cameras.some((x) => x.id === id); n += 1) id = `${base}-${n}`
    camera.id = id
    cameras.push(camera)
    broadcast('cameras', { changed: true })
    return { camera: id, ...listing() }
  }
  const camera = getCamera(b)
  if (!c) {
    if (method === 'DELETE') {
      cameras = cameras.filter((x) => x.id !== b)
      if (q.get('photos') === 'true') photos = photos.filter((p) => p.camera_id !== b)
      broadcast('cameras', { changed: true })
      return listing()
    }
    const updated = cleanCamera(body || {}, camera)
    updated.id = b
    cameras = cameras.map((x) => (x.id === b ? updated : x))
    for (const p of photos) if (p.camera_id === b) p.room_id = p.room_id || updated.room_id
    broadcast('cameras', { changed: true })
    return listing()
  }
  if (c === 'snapshot') {
    const photo = addPhoto(camera, nowS(), 'manual')
    photos.sort((x, y) => y.ts - x.ts)
    broadcast('photo', { camera_id: camera.id, id: photo.id, ts: photo.ts, room_id: photo.room_id })
    return { photo: clone(photo) }
  }
  if (c === 'timelapse') {
    if (method === 'POST') return timelapse(camera, body || {})
    return { job: jobs[b] ? clone(jobs[b]) : null }
  }
  fail(404, 'Unbekanntes Video.')
  return null
}

// ------------------------------------------------------------ pictures
function rng(seed) {
  let s = Math.floor(seed * 4294967295) >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// What the tent looked like on a day: plants, their age and how far the flowering is.
function scene(roomId, iso) {
  const grow = growList().find((g) => g.room_id === roomId && isISO(g.started) && g.started <= iso && iso <= g.harvested)
  if (grow) {
    const plan = grow.plan || {}
    return {
      key: grow.id,
      plants: (grow.plants?.length ? grow.plants : [{}, {}]).map((p, i) => ({
        start: isISO(p.start) && p.start >= grow.started && p.start <= iso && p.start <= (grow.flower_start || iso) ? p.start : grow.started, auto: p.type === 'auto', i,
      })),
      flower: grow.flower_start, floWeeks: plan.floWeeks || 9,
    }
  }
  const record = planForRoom(roomId)
  if (record) {
    const data = record.data
    const active = (data.plants || []).filter((p) => !p.gone).slice(0, 4)
    const lastHarvest = growList().filter((g) => g.room_id === roomId && g.harvested < iso).map((g) => g.harvested).sort().pop()
    const fallback = lastHarvest && daysBetween(lastHarvest, iso) < 60 ? addDays(lastHarvest, 3) : addDays(iso, -3)
    const starts = active.map((p) => (isISO(p.start) ? p.start : isISO(data.vegStart) ? addDays(data.vegStart, -10) : fallback))
    return {
      key: record.id, plants: active.map((p, i) => ({ start: starts[i], auto: p.type === 'auto', i })),
      flower: isISO(data.floStart) ? data.floStart : null, floWeeks: data.floWeeks || 8,
    }
  }
  // a tent without a plan (Zelt 2): four young plants in the growth phase
  const start = addDays(todayISO(), -34)
  return { key: roomId || 'none', plants: [0, 1, 2, 3].map((i) => ({ start: addDays(start, i % 2), auto: false, i })), flower: null, floWeeks: 8 }
}

function leaf(g, x, y, angle, size, color, fingers) {
  g.save()
  g.translate(x, y)
  g.rotate(angle)
  g.fillStyle = color
  const spread = 1.9
  for (let k = 0; k < fingers; k += 1) {
    const a = -spread / 2 + (spread * k) / (fingers - 1)
    const len = size * (1 - Math.abs(a) * 0.38)
    g.save()
    g.rotate(a)
    g.beginPath()
    g.ellipse(0, -len / 2, len * 0.13, len / 2, 0, 0, Math.PI * 2)
    g.fill()
    g.restore()
  }
  g.restore()
}

function bud(g, x, y, r, ripe, rand) {
  g.fillStyle = '#9ccf6a'
  for (let k = 0; k < 7; k += 1) {
    g.beginPath()
    g.ellipse(x + (rand() - 0.5) * r * 0.9, y + (rand() - 0.5) * r * 1.6, r * 0.55, r * 0.75, 0, 0, Math.PI * 2)
    g.fill()
  }
  g.fillStyle = ripe > 0.6 ? '#d98a3a' : '#f3f1e4'
  for (let k = 0; k < 10; k += 1) g.fillRect(x + (rand() - 0.5) * r * 1.4, y + (rand() - 0.5) * r * 2, 2.2, 2.2)
}

function drawPlant(g, p, x, floorY, iso, sc, keySeed) {
  const rand = rng(hash(`${keySeed}-${p.i}`))
  const age = Math.max(0, daysBetween(p.start, iso))
  const flowerDays = sc.flower && iso >= sc.flower ? daysBetween(sc.flower, iso) : 0
  const flip = sc.flower ? Math.max(0, daysBetween(p.start, sc.flower)) : age
  const vegAge = Math.min(age, flip)
  let height = 14 + 190 * Math.min(1, vegAge / 70) ** 1.15
  height *= 1 + 0.75 * Math.min(1, flowerDays / 21)
  if (p.auto) height *= 0.72
  height = Math.min(height * (0.9 + rand() * 0.2), 300)
  const leafSize = Math.min(64, 10 + Math.min(age, 60) * 0.95)
  const ripe = sc.flower ? flowerDays / (sc.floWeeks * 7) : 0
  const green = ripe > 0.75 ? '#6f9a3a' : ['#3f8f3a', '#4d9c3f', '#3a8544'][p.i % 3]
  // stem
  g.strokeStyle = '#5c7d32'
  g.lineWidth = 2 + Math.min(5, age / 14)
  g.beginPath()
  g.moveTo(x, floorY)
  g.lineTo(x + (rand() - 0.5) * 8, floorY - height)
  g.stroke()
  const nodes = Math.max(1, Math.floor(height / 26))
  const tips = []
  for (let n = 0; n < nodes; n += 1) {
    const y = floorY - 16 - ((height - 16) * (n + 1)) / nodes
    const side = n % 2 ? 1 : -1
    const reach = (height * 0.5 * (1 - n / (nodes + 1))) * (age > 18 ? 1 : 0.4)
    if (age > 20 && n < nodes - 1) {
      g.strokeStyle = '#5c7d32'
      g.lineWidth = 2
      for (const s of [side, -side]) {
        g.beginPath()
        g.moveTo(x, y)
        g.quadraticCurveTo(x + s * reach * 0.6, y, x + s * reach, y - reach * 0.7)
        g.stroke()
        tips.push([x + s * reach, y - reach * 0.7])
      }
    }
    const size = leafSize * (0.55 + 0.45 * (1 - n / (nodes + 1)))
    const fingers = age < 10 ? 3 : age < 22 ? 5 : 7
    leaf(g, x, y, side * (0.9 + rand() * 0.4), size, green, fingers)
    leaf(g, x, y, -side * (0.9 + rand() * 0.4), size * 0.9, green, fingers)
    if (ripe > 0.7 && rand() < 0.35) leaf(g, x + side * 6, y + 4, side * 1.4, size * 0.8, '#c9b24a', fingers)
  }
  tips.push([x, floorY - height])
  if (flowerDays > 12) {
    const r = Math.min(20, 3 + (flowerDays - 12) * 0.32) * (p.auto ? 0.8 : 1)
    for (const [tx, ty] of tips) {
      leaf(g, tx, ty + r, (rand() - 0.5) * 0.6, leafSize * 0.45, green, 5)
      bud(g, tx, ty, r * (tx === x ? 1.3 : 0.85), ripe, rand)
    }
  } else {
    for (const [tx, ty] of tips) leaf(g, tx, ty, (rand() - 0.5) * 0.5, leafSize * 0.5, '#6fbf4f', 5)
  }
}

function roomOf(id) {
  return ctx.rooms?.().find((r) => r.id === id) || null
}
function lightOn(room, ts) {
  const d = new Date(ts * 1000)
  const minutes = d.getHours() * 60 + d.getMinutes()
  const m = (hhmm, dflt) => {
    const [h, mm] = String(hhmm || dflt).split(':').map(Number)
    return h * 60 + mm
  }
  const start = m(room?.day_start, '06:00')
  const end = m(room?.day_end, '00:00')
  if (start === end) return true
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end
}

let canvas = null
const cache = new Map()
// a photo keeps the tent it showed when it was first drawn, even if the plan changes later
const scenes = new Map()

function render(photo, thumb) {
  const camera = cameras.find((c) => c.id === photo.camera_id) || { name: photo.camera_id, source: 'demo' }
  const W = thumb ? 400 : 1280
  const H = Math.round((W * 9) / 16)
  canvas ||= document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const g = canvas.getContext('2d')
  g.setTransform(W / 960, 0, 0, W / 960, 0, 0)
  const iso = localISO(photo.ts)
  const room = roomOf(photo.room_id || camera.room_id)
  if (!scenes.has(photo.id)) scenes.set(photo.id, scene(photo.room_id || camera.room_id, iso))
  const sc = scenes.get(photo.id)
  const on = lightOn(room, photo.ts)
  const cool = camera.source === 'growcam'
  const rand = rng(hash(`${sc.key}walls`))
  // walls, ceiling and floor of a mylar tent
  const wall = (points, color) => {
    g.fillStyle = color
    g.beginPath()
    points.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)))
    g.closePath()
    g.fill()
  }
  wall([[0, 0], [960, 0], [960, 540], [0, 540]], '#9aa0a2')
  wall([[220, 70], [740, 70], [740, 400], [220, 400]], cool ? '#c9d1d6' : '#d5d3cc')
  wall([[0, 0], [220, 70], [220, 400], [0, 540]], cool ? '#aeb8bd' : '#bdb9b0')
  wall([[960, 0], [740, 70], [740, 400], [960, 540]], cool ? '#a7b1b6' : '#b5b1a7')
  wall([[0, 0], [960, 0], [740, 70], [220, 70]], '#7d8285')
  wall([[0, 540], [220, 400], [740, 400], [960, 540]], '#4b4f4c')
  g.globalAlpha = 0.18
  for (let k = 0; k < 26; k += 1) {
    const x = 230 + rand() * 500
    g.fillStyle = rand() < 0.5 ? '#ffffff' : '#6d7275'
    g.fillRect(x, 72, 2 + rand() * 5, 326)
  }
  g.globalAlpha = 1
  // lamp with bars
  g.fillStyle = '#2b2e30'
  g.fillRect(300, 22, 360, 16)
  for (let k = 0; k < 6; k += 1) {
    g.fillStyle = on ? '#fff6e4' : '#3a3d3f'
    g.fillRect(308 + k * 58, 34, 46, 8)
  }
  // pots and plants
  const n = sc.plants.length || 1
  sc.plants.forEach((p, i) => {
    const x = 480 + (i - (n - 1) / 2) * Math.min(170, 560 / n)
    const floorY = 450
    g.fillStyle = '#1f2220'
    g.beginPath()
    g.moveTo(x - 52, floorY - 4)
    g.lineTo(x + 52, floorY - 4)
    g.lineTo(x + 44, floorY + 58)
    g.lineTo(x - 44, floorY + 58)
    g.closePath()
    g.fill()
    g.fillStyle = '#3b2c20'
    g.fillRect(x - 50, floorY - 8, 100, 8)
    if (daysBetween(p.start, iso) >= 0) drawPlant(g, p, x, floorY - 6, iso, sc, sc.key)
  })
  // light and colour of the camera
  g.setTransform(1, 0, 0, 1, 0, 0)
  if (on) {
    const glow = g.createRadialGradient(W / 2, 0, 10, W / 2, 0, W * 0.75)
    glow.addColorStop(0, cool ? 'rgba(235,245,255,0.35)' : 'rgba(255,236,214,0.4)')
    glow.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = glow
    g.fillRect(0, 0, W, H)
  } else {
    g.fillStyle = 'rgba(12,22,16,0.78)'
    g.fillRect(0, 0, W, H)
  }
  const vignette = g.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.7)
  vignette.addColorStop(0, 'rgba(0,0,0,0)')
  vignette.addColorStop(1, cool ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.4)')
  g.fillStyle = vignette
  g.fillRect(0, 0, W, H)
  // on-screen display like a camera
  const d = new Date(photo.ts * 1000)
  const stamp = `${iso} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  const font = Math.round(W / 42)
  g.font = `600 ${font}px ui-monospace, Menlo, Consolas, monospace`
  g.fillStyle = 'rgba(0,0,0,0.55)'
  g.fillText(camera.name, font * 0.8 + 1, font * 1.6 + 1)
  g.fillText(stamp, W - g.measureText(stamp).width - font * 0.8 + 1, H - font * 0.8 + 1)
  g.fillStyle = cool ? '#fff7a8' : '#ffffff'
  g.fillText(camera.name, font * 0.8, font * 1.6)
  g.fillText(stamp, W - g.measureText(stamp).width - font * 0.8, H - font * 0.8)
  return canvas.toDataURL('image/jpeg', thumb ? 0.72 : 0.85)
}

// Transparent pixel for photos that are gone (the app shows the img anyway).
const EMPTY = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='

function photoUrl(id, thumb = false) {
  const key = `${id}|${thumb ? 1 : 0}`
  if (cache.has(key)) return cache.get(key)
  let photo = photos.find((p) => p.id === id)
  if (!photo) {
    // a photo that is still referenced (log entry, archive) but deleted: draw it from its id
    const m = /^([^/]+)\/(\d{4}-\d{2}-\d{2})\/(\d{2})(\d{2})(\d{2})/.exec(id)
    if (!m) return EMPTY
    const camera = cameras.find((c) => c.id === m[1])
    photo = { id, camera_id: m[1], room_id: camera?.room_id || null, ts: tsOf(m[2], Number(m[3]) + Number(m[4]) / 60 + Number(m[5]) / 3600) }
  }
  let url = EMPTY
  try {
    url = render(photo, thumb)
  } catch {
    /* no canvas (very old browser) */
  }
  if (cache.size > 400) cache.delete(cache.keys().next().value)
  cache.set(key, url)
  return url
}

window.__growdeckDemo = { ...(window.__growdeckDemo || {}), photoUrl }

export function startCameras() {
  seedPhotos()
}

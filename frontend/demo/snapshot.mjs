// Takes a snapshot of a GrowDeck backend in demo mode for the static demo (demo-data.json).
//
// Start the backend with simulated devices (DEMO_MODE=1, a local MQTT broker for the
// Spider Farmer simulation), wait a minute until the demo is seeded, then run
//
//   node demo/snapshot.mjs [http://127.0.0.1:8088] [password]
//
// (defaults: http://127.0.0.1:8088 and GROWDECK_PASSWORD or "test"). The script logs in,
// reads everything the in-browser mock (demo/mock.js) starts from and writes
// demo/demo-data.json. Histories are not stored: the mock synthesises them from the values.
import { writeFileSync } from 'node:fs'

const base = (process.argv[2] || 'http://127.0.0.1:8088').replace(/\/$/, '')
const password = process.argv[3] || process.env.GROWDECK_PASSWORD || 'test'

const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
})
if (!login.ok) throw new Error(`login failed: ${login.status}`)
const cookie = (login.headers.get('set-cookie') || '').split(';')[0]

async function get(path, init = {}) {
  const res = await fetch(`${base}/api${path}`, { ...init, headers: { cookie, 'Content-Type': 'application/json', ...(init.headers || {}) } })
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return res.json()
}
const post = (path, body) => get(path, { method: 'POST', body: JSON.stringify(body) })

const state = await get('/state')
const out = {
  snapshot: { server_time: state.server_time, date: new Date(state.server_time * 1000).toLocaleDateString('sv-SE', { timeZone: state.settings.timezone || 'Europe/Berlin' }) },
  me: await get('/auth/me'),
  state,
  rules: await get('/rules'),
  alarms: await get('/alarms'),
  events: (await get('/events?limit=150')).map(({ id, ts, level, category, message, device_id, data, acknowledged }) => ({ id, ts, level, category, message, device_id, data, acknowledged })),
  system: await get('/system'),
  backups: await get('/backups'),
  cameras: await get('/cameras'),
  photos: (await get('/photos?limit=500')).photos,
  growplan: await get('/growplan'),
  growplan_logs: {},
  grows: [],
  room_controls: {},
  natives: {},
}

for (const plan of out.growplan.plans) out.growplan_logs[plan.id] = (await get(`/growplan/plans/${plan.id}`)).log
for (const grow of (await get('/grows')).grows) out.grows.push((await get(`/grows/${grow.id}`)).grow)
for (const room of state.rooms) out.room_controls[room.id] = await get(`/rooms/${room.id}/control`)

// device settings behind the editors (Spider Farmer config paths, AC Infinity ports)
for (const device of state.devices) {
  const keyPaths = []
  if (device.vendor === 'spiderfarmer') {
    for (const c of device.controls) {
      if (c.features.includes('sf_schedule') || c.features.includes('sf_outlet')) keyPaths.push(c.native?.keyPath || ['outlet', c.id])
    }
    if (['cb', 'ps5', 'ps10', 'ss'].includes(device.info?.type)) keyPaths.push(['target'], ['plan'])
  }
  for (const keyPath of keyPaths) {
    try {
      out.natives[`${device.id}|${keyPath.join('/')}`] = (await post(`/devices/${device.id}/native`, { action: 'get', keyPath })).value
    } catch (err) {
      console.warn(`skip ${device.id} ${keyPath.join('/')}: ${err.message}`)
    }
  }
  for (const c of device.controls) {
    if (!c.features.includes('aci_port')) continue
    out.natives[`${device.id}|${c.id}`] = await post(`/devices/${device.id}/native`, { action: 'get', control_id: c.id })
  }
}

const text = JSON.stringify(out)
writeFileSync(new URL('./demo-data.json', import.meta.url), `${text}\n`)
console.log(`demo/demo-data.json: ${Math.round(text.length / 1024)} KB, ${state.devices.length} devices, ${out.photos.length} photos, ${out.grows.length} archived grows`)

// Shared state of the in-browser demo backend: snapshot data, time shift, live socket,
// events and small helpers. The other demo modules register their getters in `ctx`.
import RAW from './demo-data.json'
import { addDays, daysBetween, isISO, todayISO } from '../src/growplan/engine.js'
import { lang } from '../src/i18n.js'

// The snapshot comes from a German demo. On the English page the names a user would have
// typed (rooms, rules, plants, notes …) are English too; texts GrowDeck generates stay
// German, exactly like the real server sends them, and the page translates them.
const ENGLISH_NAMES = [
  ['Zusatzlüfter, solange der Entfeuchter läuft', 'Extra fan while the dehumidifier runs'],
  ['Umluft-Intervall an Steckdose 6', 'Circulation fan interval on outlet 6'],
  ['Untere Triebe entfernt, Blüten bilden sich gleichmäßig.', 'Removed lower shoots, buds are forming evenly.'],
  ['Gleichmäßige Blüten, Amnesia etwas luftig. Nächstes Mal früher entlauben.', 'Even buds, Amnesia a bit airy. Defoliate earlier next time.'],
  ['Frühjahr: Northern Lights', 'Spring: Northern Lights'],
  ['Zelt 1 zu warm', 'Tent 1 too warm'],
  ['Zelt 1 Kamera', 'Tent 1 camera'],
  ['"Links"', '"Left"'],
  ['"Mitte"', '"Middle"'],
  ['"Rechts"', '"Right"'],
  ['"Trocknung"', '"Drying"'],
  ['"Wasserpumpe"', '"Water pump"'],
  ['"CO₂-Regler"', '"CO₂ controller"'],
  ['"Heizmatte"', '"Heat mat"'],
]
function englishNames(data) {
  let text = JSON.stringify(data)
  for (const [de, en] of ENGLISH_NAMES) text = text.split(de).join(en)
  return JSON.parse(text.replace(/Zelt (\d)/g, 'Tent $1'))
}
export const DATA = lang === 'en' ? englishNames(RAW) : RAW
export const ctx = {}

export const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
export const nowS = () => Date.now() / 1000
export const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d

export function hash(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return (h >>> 0) / 4294967295
}

// Numbers as the backend writes them into its German texts: de(31.24, 1) -> "31,2".
export const de = (v, d = 1) => Number(v).toFixed(d).replace('.', ',')
// Python's format(round(v, 2), "g") with a decimal comma: 30 -> "30", 1.5 -> "1,5".
export const deG = (v) => String(Math.round(Number(v) * 100) / 100).replace('.', ',')

export const pad = (n) => String(n).padStart(2, '0')
export const localISO = (ts) => todayISO(new Date(ts * 1000))
export const localHHMM = (ts) => {
  const d = new Date(ts * 1000)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
// Local midnight of an ISO date plus hours, as unix seconds.
export const tsOf = (iso, hours = 0) => new Date(`${iso}T00:00:00`).getTime() / 1000 + hours * 3600

// The snapshot was taken on another day: timestamps move by the elapsed time, dates by whole days.
const SNAP = DATA.snapshot || { server_time: nowS(), date: todayISO() }
export const SHIFT = nowS() - SNAP.server_time
export const DAY_SHIFT = daysBetween(SNAP.date, todayISO())
export const shiftTs = (ts) => (typeof ts === 'number' ? ts + SHIFT : ts)
export const shiftISO = (iso) => (isISO(iso) ? addDays(iso, DAY_SHIFT) : iso)

export class HttpError extends Error {
  constructor(status, detail) {
    super(detail)
    this.status = status
  }
}
export const fail = (status, detail) => {
  throw new HttpError(status, detail)
}

// ------------------------------------------------------------ live socket
export const sockets = new Set()
export function broadcast(type, data) {
  const message = JSON.stringify({ type, data })
  for (const socket of sockets) socket.deliver(message)
}

// ----------------------------------------------------------------- events
export const store = { events: [], nextId: 1000 }
export function addEvent(level, category, message, deviceId = null, data = null, ts = nowS(), quiet = false) {
  const event = {
    id: store.nextId++, ts, level, category, message, device_id: deviceId, data,
    acknowledged: level === 'info' ? 1 : 0,
  }
  store.events = [event, ...store.events].sort((a, b) => b.ts - a.ts).slice(0, 400)
  if (!quiet) broadcast('event', event)
  return event
}

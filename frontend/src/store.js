// Global client state: one small external store fed by REST + websocket.
import { useSyncExternalStore } from 'react'
import { t } from './i18n.js'

const listeners = new Set()
let state = {
  auth: 'unknown', // unknown | anonymous | ok
  passwordGenerated: false,
  version: '',
  connection: 'offline', // offline | connecting | live
  devices: {},
  rooms: [],
  integrations: {},
  settings: {},
  automation: { enabled: true, rules: {} },
  alarmStatus: {},
  events: [],
  unread: 0,
  roomControl: {},
  growplans: [], // plan summaries (settings + status), one per tent
  growplanLibrary: null, // own schedules, adjusted schedules, checklist (loaded by the Growplan page)
  watering: { settings: {}, suggestions: {} }, // reminders and recognised waterings per plan
  photoTick: 0, // counts new photos and camera changes, pages reload their photos on change
  growTick: 0, // counts changes of the grow archive
  backupRunning: false,
  toasts: [],
  serverOffset: 0,
}

function emit() {
  for (const l of listeners) l()
}

export function setState(patch) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
  emit()
}

export function getState() {
  return state
}

function subscribe(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useStore(selector = (s) => s) {
  const snapshot = () => selector(state)
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

// ------------------------------------------------------------------- toasts
let toastId = 0
export function toast(message, tone = 'info', ms = 4200) {
  const id = ++toastId
  setState((s) => ({ toasts: [...s.toasts, { id, message, tone }] }))
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms)
}

// ---------------------------------------------------------------------- api
export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

export async function api(path, { method = 'GET', body, quiet = false } = {}) {
  let response
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    const err = new ApiError(t('GrowDeck ist nicht erreichbar. Läuft der Container?'), 0)
    if (!quiet) toast(err.message, 'alert')
    throw err
  }
  let data = null
  const text = await response.text()
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = { detail: text }
    }
  }
  if (response.status === 401 && path !== '/auth/login') {
    setState({ auth: 'anonymous' })
    disconnectLive()
    throw new ApiError(t('Bitte anmelden.'), 401)
  }
  if (!response.ok) {
    let detail = data?.detail
    if (Array.isArray(detail)) detail = detail.map((d) => d.msg).join(', ')
    const err = new ApiError(detail ? t(String(detail)) : t('Fehler {status}', { status: response.status }), response.status)
    if (!quiet) toast(err.message, 'alert')
    throw err
  }
  return data
}

// ------------------------------------------------------------------- loading
export async function checkAuth() {
  try {
    const me = await api('/auth/me', { quiet: true })
    setState({ passwordGenerated: me.password_generated, version: me.version })
    if (me.authenticated) {
      await loadState()
      setState({ auth: 'ok' })
      connectLive()
    } else {
      setState({ auth: 'anonymous' })
    }
  } catch {
    setState({ auth: 'anonymous' })
  }
}

export async function loadState() {
  const data = await api('/state')
  const devices = {}
  for (const d of data.devices) devices[d.id] = d
  setState({
    devices,
    rooms: data.rooms,
    integrations: data.integrations,
    settings: data.settings,
    automation: data.automation,
    roomControl: data.room_control || {},
    growplans: data.growplans || [],
    watering: data.watering || { settings: {}, suggestions: {} },
    alarmStatus: data.alarms,
    unread: data.unread_events,
    serverOffset: data.server_time * 1000 - Date.now(),
  })
  loadEvents()
}

export async function loadEvents() {
  try {
    const events = await api('/events?limit=150', { quiet: true })
    setState({ events, unread: events.filter((e) => !e.acknowledged && e.level !== 'info').length })
  } catch {
    /* ignore */
  }
}

export async function login(password) {
  await api('/auth/login', { method: 'POST', body: { password } })
  await checkAuth()
}

export async function logout() {
  await api('/auth/logout', { method: 'POST', quiet: true }).catch(() => {})
  disconnectLive()
  setState({ auth: 'anonymous', devices: {}, rooms: [] })
}

// ----------------------------------------------------------------- commands
export async function sendCommand(deviceId, controlId, patch) {
  const control = await api(`/devices/${deviceId}/controls/${encodeURIComponent(controlId)}`, {
    method: 'POST',
    body: patch,
  })
  // Merge the returned control right away; the websocket confirms shortly after.
  setState((s) => {
    const device = s.devices[deviceId]
    if (!device) return {}
    const controls = device.controls.map((c) => (c.id === control.id ? control : c))
    return { devices: { ...s.devices, [deviceId]: { ...device, controls } } }
  })
  return control
}

// ------------------------------------------------------------------ websocket
let socket = null
let retry = 1000
let retryTimer = null
let wanted = false

export function connectLive() {
  wanted = true
  if (socket && (socket.readyState === 0 || socket.readyState === 1)) return
  clearTimeout(retryTimer)
  setState({ connection: 'connecting' })
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  socket = new WebSocket(`${proto}://${location.host}/api/ws`)
  socket.onopen = () => {
    retry = 1000
    setState({ connection: 'live' })
  }
  socket.onmessage = (ev) => {
    let msg
    try {
      msg = JSON.parse(ev.data)
    } catch {
      return
    }
    handleMessage(msg)
  }
  socket.onclose = (ev) => {
    socket = null
    setState({ connection: 'offline' })
    if (ev.code === 4401) {
      setState({ auth: 'anonymous' })
      return
    }
    if (wanted) {
      retryTimer = setTimeout(connectLive, retry)
      retry = Math.min(retry * 2, 20000)
    }
  }
}

export function disconnectLive() {
  wanted = false
  clearTimeout(retryTimer)
  if (socket) socket.close()
  socket = null
}

function handleMessage(msg) {
  const { type, data } = msg
  if (type === 'snapshot') {
    const devices = {}
    for (const d of data.devices) devices[d.id] = d
    setState({
      devices, rooms: data.rooms, serverOffset: data.server_time * 1000 - Date.now(),
      ...(data.growplans ? { growplans: data.growplans } : {}),
      ...(data.watering ? { watering: data.watering } : {}),
    })
  } else if (type === 'devices') {
    setState((s) => {
      const devices = { ...s.devices }
      for (const d of data) devices[d.id] = d
      return { devices }
    })
  } else if (type === 'device_removed') {
    setState((s) => {
      const devices = { ...s.devices }
      delete devices[data.id]
      return { devices }
    })
  } else if (type === 'rooms') {
    setState({ rooms: data })
  } else if (type === 'room_control') {
    setState({ roomControl: data })
  } else if (type === 'growplan') {
    setState(data.library ? { growplans: data.plans, growplanLibrary: data.library } : { growplans: data.plans })
  } else if (type === 'event') {
    setState((s) => ({
      events: [data, ...s.events].slice(0, 300),
      unread: s.unread + (data.level === 'info' ? 0 : 1),
    }))
    if (data.level === 'alarm') toast(t(data.message), 'alert', 8000)
    else if (data.level === 'warning') toast(t(data.message), 'warn', 6000)
  } else if (type === 'watering') {
    setState({ watering: data })
  } else if (type === 'photo' || type === 'cameras') {
    setState((s) => ({ photoTick: s.photoTick + 1 }))
  } else if (type === 'grows') {
    setState((s) => ({ growTick: s.growTick + 1 }))
  } else if (type === 'backup') {
    setState({ backupRunning: !!data.running })
  } else if (type === 'events_ack') {
    loadEvents()
  } else if (type === 'ping') {
    setState({
      automation: data.automation,
      roomControl: data.room_control || {},
      alarmStatus: data.alarms,
      integrations: data.integrations,
      serverOffset: data.server_time * 1000 - Date.now(),
    })
  }
}

// Keep the socket alive when the tab comes back from background (phones).
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wanted && !socket) connectLive()
  })
}

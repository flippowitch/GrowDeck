// Loading and saving of one grow plan with its watering log, plus the shared library.
// Settings are saved shortly after the last change; log entries right away.
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, getState, setState as setStore, useStore } from '../store.js'
import { t } from '../i18n.js'
import { emptyLibrary } from './engine.js'

const SAVE_DELAY = 600

export function putSummary(summary) {
  setStore((s) => {
    const others = s.growplans.filter((p) => p.id !== summary.id)
    return { growplans: [...others, summary].sort((a, b) => a.created - b.created) }
  })
}

export function useLibrary() {
  const library = useStore((s) => s.growplanLibrary)
  useEffect(() => {
    if (getState().growplanLibrary) return
    api('/growplan', { quiet: true })
      .then((r) => setStore({ growplans: r.plans, growplanLibrary: r.library }))
      .catch(() => setStore({ growplanLibrary: emptyLibrary() }))
  }, [])
  const save = useCallback(async (patch) => {
    const before = getState().growplanLibrary || emptyLibrary()
    setStore({ growplanLibrary: { ...before, ...patch } })
    try {
      const r = await api('/growplan/library', { method: 'PUT', body: patch })
      setStore({ growplanLibrary: r.library })
      return r.library
    } catch (err) {
      setStore({ growplanLibrary: before })
      throw err
    }
  }, [])
  return [library, save]
}

export function usePlan(planId) {
  const [state, setState] = useState({ plan: null, log: [], loading: !!planId, error: '' })
  const dataRef = useRef(null)
  const timer = useRef(null)
  const pending = useRef(false) // local changes not sent yet
  const busy = useRef(0) // own requests on their way
  const knownRev = useRef(null)
  const seq = useRef(0)
  const summary = useStore((s) => s.growplans.find((p) => p.id === planId))
  const path = `/growplan/plans/${encodeURIComponent(planId || '')}`

  const load = useCallback(async () => {
    if (!planId) return
    try {
      const r = await api(path, { quiet: true })
      knownRev.current = r.plan.rev
      if ((pending.current || busy.current) && dataRef.current) {
        // own changes are on their way: keep them, take the rest
        setState((s) => ({ ...s, plan: { ...r.plan, data: dataRef.current }, log: r.log, loading: false, error: '' }))
      } else {
        dataRef.current = r.plan.data
        setState({ plan: r.plan, log: r.log, loading: false, error: '' })
      }
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: err.message }))
    }
  }, [planId, path])

  // after own requests: pick up changes made elsewhere in the meantime
  const recheck = useCallback(() => {
    const current = getState().growplans.find((p) => p.id === planId)
    if (current && knownRev.current != null && current.rev !== knownRev.current && !pending.current && !busy.current) load()
  }, [planId, load])

  const own = useCallback(async (fn) => {
    busy.current += 1
    try {
      return await fn()
    } finally {
      busy.current -= 1
      if (!busy.current) setTimeout(recheck, 0)
    }
  }, [recheck])

  const flush = useCallback(async () => {
    clearTimeout(timer.current)
    if (!pending.current || !planId) return
    pending.current = false
    const mine = ++seq.current
    await own(async () => {
      try {
        const r = await api(path, { method: 'PUT', body: { data: dataRef.current } })
        knownRev.current = r.plan.rev
        putSummary(pending.current ? { ...r.plan, data: dataRef.current } : r.plan)
        if (mine === seq.current && !pending.current) {
          dataRef.current = r.plan.data
          setState((s) => ({ ...s, plan: r.plan }))
        }
      } catch {
        /* toast shown by api() */
      }
    })
  }, [planId, path, own])

  useEffect(() => {
    setState({ plan: null, log: [], loading: !!planId, error: '' })
    knownRev.current = null
    dataRef.current = null
    load()
    // save right away when the tab goes to the background or the page is left
    const hide = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    document.addEventListener('visibilitychange', hide)
    return () => {
      document.removeEventListener('visibilitychange', hide)
      flush()
    }
  }, [planId, load, flush])

  // changes from another device or tab
  useEffect(() => {
    if (!summary || knownRev.current == null) return
    if (summary.rev !== knownRev.current && !pending.current && !busy.current) load()
  }, [summary, load])

  const update = useCallback((patch) => {
    const next = { ...dataRef.current, ...(typeof patch === 'function' ? patch(dataRef.current) : patch) }
    dataRef.current = next
    pending.current = true
    setState((s) => (s.plan ? { ...s, plan: { ...s.plan, data: next } } : s))
    clearTimeout(timer.current)
    timer.current = setTimeout(() => flush(), SAVE_DELAY)
  }, [flush])

  const afterLog = useCallback((r) => {
    knownRev.current = r.plan.rev
    putSummary(pending.current ? { ...r.plan, data: dataRef.current } : r.plan)
  }, [])

  const saveEntry = useCallback((entry) => own(async () => {
    const r = await api(`${path}/log/${encodeURIComponent(entry.id)}`, { method: 'PUT', body: entry })
    afterLog(r)
    setState((s) => ({ ...s, log: [r.entry, ...s.log.filter((e) => e.id !== r.entry.id)] }))
    return r.entry
  }), [path, own, afterLog])

  const deleteEntry = useCallback((id) => own(async () => {
    const r = await api(`${path}/log/${encodeURIComponent(id)}`, { method: 'DELETE' })
    afterLog(r)
    setState((s) => ({ ...s, log: s.log.filter((e) => e.id !== id) }))
  }), [path, own, afterLog])

  const clearLog = useCallback(() => own(async () => {
    const r = await api(`${path}/log`, { method: 'DELETE' })
    afterLog(r)
    setState((s) => ({ ...s, log: [] }))
    return r.deleted
  }), [path, own, afterLog])

  const importBackup = useCallback(async (backup) => {
    await flush()
    return own(async () => {
      const r = await api(`${path}/import`, { method: 'POST', body: backup })
      knownRev.current = r.plan.rev
      dataRef.current = r.plan.data
      putSummary(r.plan)
      setStore({ growplanLibrary: r.library })
      setState({ plan: r.plan, log: r.log, loading: false, error: '' })
      return r.result
    })
  }, [path, flush, own])

  const hasPending = useCallback(() => pending.current || busy.current > 0, [])

  const rename = useCallback((name) => own(async () => {
    const r = await api(path, { method: 'PUT', body: { name } })
    knownRev.current = r.plan.rev
    putSummary(pending.current ? { ...r.plan, data: dataRef.current } : r.plan)
    setState((s) => ({ ...s, plan: { ...r.plan, data: dataRef.current } }))
  }), [path, own])

  return { ...state, update, flush, hasPending, saveEntry, deleteEntry, clearLog, importBackup, rename, reload: load }
}

export async function createPlan({ roomId = null, name, data } = {}) {
  const r = await api('/growplan/plans', { method: 'POST', body: { room_id: roomId, name, data } })
  putSummary(r.plan)
  return r.plan
}

export async function assignPlan(planId, roomId) {
  const r = await api(`/growplan/plans/${encodeURIComponent(planId)}/room`, { method: 'PUT', body: { room_id: roomId } })
  putSummary(r.plan)
  return r.plan
}

export async function deletePlan(planId) {
  await api(`/growplan/plans/${encodeURIComponent(planId)}`, { method: 'DELETE' })
  setStore((s) => ({ growplans: s.growplans.filter((p) => p.id !== planId) }))
}

// A new plan filled from a backup of the Growplan app.
export async function importIntoNewPlan({ roomId = null, name, data, backup }) {
  const plan = await createPlan({ roomId, name, data })
  const r = await api(`/growplan/plans/${encodeURIComponent(plan.id)}/import`, { method: 'POST', body: backup })
  putSummary(r.plan)
  setStore({ growplanLibrary: r.library })
  return { plan: r.plan, result: r.result }
}

export function importMessage(result) {
  const parts = [result.added === 1 ? t('{n} Eintrag importiert', { n: result.added }) : t('{n} Einträge importiert', { n: result.added })]
  if (result.updated) parts.push(t('{n} aktualisiert', { n: result.updated }))
  if (result.settings) parts.push(t('Einstellungen übernommen'))
  if (result.custom || result.ovr) {
    const n = result.custom + result.ovr
    parts.push(n === 1 ? t('{n} Schema', { n }) : t('{n} Schemata', { n }))
  }
  return parts.join(', ')
}

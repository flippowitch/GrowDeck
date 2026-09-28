// Cameras and photos: addresses, loading hooks and a snapshot helper shared by the gallery,
// the options, the Growplan and the archive.
import { useEffect, useState } from 'react'
import { api, toast, useStore } from './store.js'
import { LOCALE } from './format.js'
import { t } from './i18n.js'

export function photoUrl(id, thumb = false) {
  // the static demo draws its photos in the browser
  if (typeof window !== 'undefined' && window.__growdeckDemo?.photoUrl) return window.__growdeckDemo.photoUrl(id, thumb)
  return `/api/photos/file/${id.split('/').map(encodeURIComponent).join('/')}${thumb ? '?thumb=1' : ''}`
}

export function photoDate(ts, withTime = true) {
  const d = new Date(ts * 1000)
  const day = d.toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' })
  return withTime ? `${day}, ${d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })}` : day
}

// All cameras (reloads when photos arrive or cameras change).
export function useCameras() {
  const tick = useStore((s) => s.photoTick)
  const [data, setData] = useState(null)
  useEffect(() => {
    let alive = true
    api('/cameras', { quiet: true }).then((d) => alive && setData(d)).catch(() => {})
    return () => {
      alive = false
    }
  }, [tick])
  return [data, setData]
}

// Latest photos of a camera or a tent.
export function usePhotos({ cameraId, roomId, limit = 12, start, end }) {
  const tick = useStore((s) => s.photoTick)
  const [photos, setPhotos] = useState(null)
  useEffect(() => {
    if (!cameraId && !roomId) {
      setPhotos([])
      return undefined
    }
    let alive = true
    const q = new URLSearchParams({ limit: String(limit) })
    if (cameraId) q.set('camera_id', cameraId)
    if (roomId) q.set('room_id', roomId)
    if (start) q.set('start', String(start))
    if (end) q.set('end', String(end))
    api(`/photos?${q}`, { quiet: true }).then((d) => alive && setPhotos(d.photos)).catch(() => alive && setPhotos([]))
    return () => {
      alive = false
    }
  }, [cameraId, roomId, limit, start, end, tick])
  return photos
}

export async function takePhoto(camera) {
  try {
    const { photo } = await api(`/cameras/${encodeURIComponent(camera.id)}/snapshot`, { method: 'POST' })
    toast(t('Foto von {name} aufgenommen.', { name: camera.name }))
    return photo
  } catch {
    return null
  }
}

export function formatBytes(bytes) {
  if (!bytes) return '0 MB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toLocaleString(LOCALE, { maximumFractionDigits: 1 })} MB`
  return `${(bytes / 1024 ** 3).toLocaleString(LOCALE, { maximumFractionDigits: 2 })} GB`
}

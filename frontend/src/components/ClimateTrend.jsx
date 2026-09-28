// Overview charts for one tent: temperature, humidity and VPD over time.
// Three aligned charts share one time axis, one crosshair and one tooltip
// (instead of one chart with two y-scales). Shaded backgrounds mark periods with
// the lights off; each chart with a target (Growplan, room control or the phase's
// VPD band) shows it as a band for day and night and how long the value stayed
// inside it. A table view offers the same values without a chart.
import { useEffect, useMemo, useRef, useState } from 'react'
import uPlot from 'uplot'
import { api } from '../store.js'
import { fmt, LOCALE } from '../format.js'
import { t } from '../i18n.js'
import { judge, pairText } from '../targets.js'

export const TREND_RANGES = [
  {
    key: '6', label: t('{n} Std.', { n: 6 }), hours: 6, points: 180, refresh: 120000, table: 900,
    title: t('Verlauf der letzten 6 Stunden'), caption: t('der letzten 6 Stunden'), tableLabel: t('Mittelwerte je 15 Minuten'),
  },
  {
    key: '24', label: t('{n} Std.', { n: 24 }), hours: 24, points: 240, refresh: 300000, table: 3600,
    title: t('Verlauf der letzten 24 Stunden'), caption: t('der letzten 24 Stunden'), tableLabel: t('Mittelwerte je Stunde'),
  },
  {
    key: '168', label: t('{n} Tage', { n: 7 }), hours: 168, points: 336, refresh: 600000, table: 21600,
    title: t('Verlauf der letzten 7 Tage'), caption: t('der letzten 7 Tage'), tableLabel: t('Mittelwerte je 6 Stunden'),
  },
]
const RANGE_STORAGE = 'gd-trend-range'
const WEEKDAYS = [t('So'), t('Mo'), t('Di'), t('Mi'), t('Do'), t('Fr'), t('Sa')]

export function rangeOf(key) {
  return TREND_RANGES.find((r) => r.key === key) || TREND_RANGES[1]
}

export function loadTrendRange() {
  try {
    const stored = localStorage.getItem(RANGE_STORAGE)
    if (TREND_RANGES.some((r) => r.key === stored)) return stored
  } catch {
    /* storage unavailable */
  }
  return '24'
}

export function saveTrendRange(key) {
  try {
    localStorage.setItem(RANGE_STORAGE, key)
  } catch {
    /* storage unavailable */
  }
}

// Which sensors and lights make up a tent's climate. Mirrors the readouts above the
// charts: the climate sensor of the tent, or all sensors when the tent averages them.
export function trendSources({ roomDevices, source, averaged, control }) {
  const refs = { temp: [], humi: [], vpd: [], light: [] }
  if (averaged) {
    for (const d of roomDevices) {
      if (d.sensors.some((s) => s.key === 'temp')) refs.temp.push(`${d.id}|temp`)
      if (d.sensors.some((s) => s.key === 'humi')) refs.humi.push(`${d.id}|humi`)
    }
  } else if (source?.device) {
    const id = source.device.id
    if (source.temp) refs.temp.push(`${id}|${source.temp.key}`)
    if (source.humi) refs.humi.push(`${id}|${source.humi.key}`)
    if (source.vpd) refs.vpd.push(`${id}|${source.vpd.key}`)
  }
  const configured = (control?.outputs || []).filter((o) => o.role === 'light')
  if (configured.length) {
    refs.light = configured.map((o) => `${o.device_id}|${o.control_id}`)
  } else {
    for (const d of roomDevices) for (const c of d.controls) if (c.type === 'light') refs.light.push(`${d.id}|${c.id}`)
  }
  return refs
}

export function trendQuery(refs, room) {
  if (!refs.temp.length && !refs.humi.length) return ''
  const params = new URLSearchParams()
  for (const key of ['temp', 'humi', 'vpd', 'light']) {
    for (const ref of [...new Set(refs[key])].sort()) params.append(key, ref)
  }
  params.set('day_start', room.day_start || '06:00')
  params.set('day_end', room.day_end || '00:00')
  return params.toString()
}

export function useClimateHistory(query, rangeKey) {
  const range = rangeOf(rangeKey)
  const [state, setState] = useState({ data: null, loading: false, error: null })
  useEffect(() => {
    if (!query) {
      setState({ data: null, loading: false, error: null })
      return undefined
    }
    let alive = true
    const load = async () => {
      setState((s) => ({ ...s, loading: true }))
      try {
        const data = await api(`/climate/history?${query}&hours=${range.hours}&points=${range.points}`, { quiet: true })
        if (alive) setState({ data, loading: false, error: null })
      } catch (err) {
        if (alive) setState((s) => ({ ...s, loading: false, error: err.message }))
      }
    }
    load()
    const timer = setInterval(load, range.refresh)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [query, range.hours, range.points, range.refresh])
  return state
}

// Recent temperature/humidity pairs for the trail in the VPD diagram.
export function trailFrom(data, hours = 6, maxPoints = 72) {
  if (!data) return []
  const cutoff = data.end - hours * 3600
  const points = []
  data.t.forEach((ts, i) => {
    if (ts >= cutoff && data.temp[i] != null && data.humi[i] != null) points.push([data.temp[i], data.humi[i]])
  })
  if (points.length <= maxPoints) return points
  const step = (points.length - 1) / (maxPoints - 1)
  return Array.from({ length: maxPoints }, (_, k) => points[Math.round(k * step)])
}

// ------------------------------------------------------------------ helpers
function inNight(ts, nights) {
  for (const [a, b] of nights || []) {
    if (ts < a) return false
    if (ts < b) return true
  }
  return false
}

function bandAt(pair, night) {
  return (night ? pair?.night : pair?.day) || null
}

function summarize(data, key, pair) {
  let n = 0
  let sum = 0
  let min = Infinity
  let max = -Infinity
  const phase = { day: [0, 0], night: [0, 0] }
  let banded = 0
  let inside = 0
  data.t.forEach((ts, i) => {
    const v = data[key][i]
    if (v == null) return
    const night = inNight(ts, data.nights)
    n += 1
    sum += v
    min = Math.min(min, v)
    max = Math.max(max, v)
    phase[night ? 'night' : 'day'][0] += v
    phase[night ? 'night' : 'day'][1] += 1
    const band = pair ? bandAt(pair, night) : null
    if (band) {
      banded += 1
      if (v >= band[0] - 1e-9 && v <= band[1] + 1e-9) inside += 1
    }
  })
  return {
    n,
    avg: n ? sum / n : null,
    min: n ? min : null,
    max: n ? max : null,
    day: phase.day[1] ? phase.day[0] / phase.day[1] : null,
    night: phase.night[1] ? phase.night[0] / phase.night[1] : null,
    share: banded ? inside / banded : null,
  }
}

function css(name, fallback = '#888') {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

function dayLabel(d) {
  return `${WEEKDAYS[d.getDay()]} ${d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'numeric' })}`
}

function timeLabel(ts) {
  const d = new Date(ts * 1000)
  return `${dayLabel(d)}, ${d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })}`
}

function axisTimes(u, splits) {
  const span = (u.scales.x.max ?? 0) - (u.scales.x.min ?? 0)
  return splits.map((ts) => {
    const d = new Date(ts * 1000)
    const time = d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })
    if (span <= 2 * 86400) return time
    // week view: the day at midnight, the time otherwise (on narrow screens splits can fall mid-day)
    return d.getHours() === 0 && d.getMinutes() === 0 ? t('{weekday} {day}.', { weekday: WEEKDAYS[d.getDay()], day: d.getDate() }) : time
  })
}

function axisValues(u, splits) {
  const step = splits.length > 1 ? Math.abs(splits[1] - splits[0]) : 1
  // as many decimals as the step needs (2,5 steps show 17,5 · 20 · 22,5)
  const exact = (d) => Math.abs(step * 10 ** d - Math.round(step * 10 ** d)) < 1e-6
  const digits = exact(0) ? 0 : exact(1) ? 1 : 2
  return splits.map((v) => fmt(v, digits))
}

function yRange(spec, min, max, pair) {
  let lo = Number.isFinite(min) ? min : null
  let hi = Number.isFinite(max) ? max : null
  for (const band of [pair?.day, pair?.night]) {
    if (!band) continue
    lo = lo == null ? band[0] : Math.min(lo, band[0])
    hi = hi == null ? band[1] : Math.max(hi, band[1])
  }
  if (lo == null || hi == null) [lo, hi] = spec.fallback
  const span = Math.max(hi - lo, spec.minSpan)
  const mid = (lo + hi) / 2
  let a = mid - span / 2 - span * 0.12
  let b = mid + span / 2 + span * 0.12
  if (spec.lo != null && a < spec.lo) {
    b += spec.lo - a
    a = spec.lo
  }
  if (spec.hi != null && b > spec.hi) {
    a = Math.max(spec.lo ?? -Infinity, a - (b - spec.hi))
    b = spec.hi
  }
  return [a, b]
}

function phaseSegments(min, max, nights) {
  const segments = []
  let cursor = min
  for (const [a, b] of nights || []) {
    if (b <= min || a >= max) continue
    if (a > cursor) segments.push([cursor, a, false])
    segments.push([Math.max(a, min), Math.min(b, max), true])
    cursor = Math.min(b, max)
  }
  if (cursor < max) segments.push([cursor, max, false])
  return segments
}

export function useThemeKey() {
  const [key, setKey] = useState(0)
  useEffect(() => {
    const bump = () => setKey((k) => k + 1)
    const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null
    media?.addEventListener?.('change', bump)
    const observer = new MutationObserver(bump)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      media?.removeEventListener?.('change', bump)
      observer.disconnect()
    }
  }, [])
  return key
}

const PLOTS = [
  { key: 'temp', title: t('Temperatur'), unit: '°C', digits: 1, color: '--chart-temp', height: 124, minSpan: 3, fallback: [18, 28] },
  { key: 'humi', title: t('Luftfeuchte'), unit: '%', digits: 0, color: '--chart-humi', height: 124, minSpan: 10, lo: 0, hi: 100, fallback: [40, 80] },
  { key: 'vpd', title: 'VPD', unit: 'kPa', digits: 2, color: '--chart-vpd', height: 178, minSpan: 0.6, lo: 0, fallback: [0.4, 1.6], axis: true },
]

function valueText(spec, v) {
  return v == null ? '–' : `${fmt(v, spec.digits)} ${spec.unit}`
}

// "zu warm" / "im Ziel": the state in words next to the value
function statusText(key, v, band) {
  const j = judge(key, v, band)
  if (!j) return ''
  return j.inside ? t('im Ziel') : j.word
}

// -------------------------------------------------------------- one chart
function TrendPlot({ spec, shared, data, themeKey, targetsKey, ariaLabel }) {
  const box = useRef(null)
  const plotRef = useRef(null)

  useEffect(() => {
    const el = box.current
    if (!el) return undefined
    const color = {
      line: css(spec.color),
      grid: css('--line'),
      text: css('--muted'),
      surface: css('--panel', '#fff'),
      night: css('--chart-night', 'rgba(0,0,0,0.06)'),
      band: css('--chart-band', 'rgba(47,125,79,0.16)'),
      bandEdge: css('--chart-band-edge', 'rgba(47,125,79,0.45)'),
    }
    const font = `12px ${css('--font', 'sans-serif')}`
    const initial = shared.data.current
    const plot = new uPlot(
      {
        width: Math.max(260, el.clientWidth),
        height: spec.height,
        padding: [10, 14, 0, 0],
        legend: { show: false },
        cursor: {
          x: true,
          y: false,
          drag: { x: false, y: false, setScale: false },
          focus: { prox: -1 },
          sync: { key: shared.syncKey, scales: ['x', null] },
          points: { size: () => 10, width: () => 2, fill: () => color.line, stroke: () => color.surface },
        },
        scales: {
          x: { time: true, range: (u, min, max) => (shared.data.current ? [shared.data.current.start, shared.data.current.end] : [min, max]) },
          y: { range: (u, min, max) => yRange(spec, min, max, shared.targets.current?.[spec.key]) },
        },
        axes: [
          {
            stroke: color.text,
            font,
            grid: { stroke: color.grid, width: 1 },
            ticks: { show: false },
            // one label per day in the week view, every few hours otherwise
            space: (u, axisIdx, min, max) => (max - min > 2 * 86400 ? 96 : 64),
            gap: 6,
            size: spec.axis ? 28 : 2,
            values: spec.axis ? axisTimes : (u, splits) => splits.map(() => ''),
          },
          {
            stroke: color.text,
            font,
            grid: { stroke: color.grid, width: 1 },
            ticks: { show: false },
            space: 26,
            gap: 6,
            size: 46,
            values: axisValues,
          },
        ],
        series: [
          {},
          { stroke: color.line, width: 2, spanGaps: false, points: { show: false } },
        ],
        hooks: {
          drawClear: [
            (u) => {
              const d = shared.data.current
              if (!d) return
              const { ctx } = u
              const { left, top, width, height } = u.bbox
              ctx.save()
              ctx.beginPath()
              ctx.rect(left, top, width, height)
              ctx.clip()
              ctx.fillStyle = color.night
              for (const [a, b] of d.nights || []) {
                const x0 = u.valToPos(a, 'x', true)
                const x1 = u.valToPos(b, 'x', true)
                if (x1 > left && x0 < left + width) ctx.fillRect(x0, top, x1 - x0, height)
              }
              const pair = shared.targets.current?.[spec.key]
              if (pair) {
                const px = uPlot.pxRatio
                for (const [a, b, night] of phaseSegments(u.scales.x.min, u.scales.x.max, d.nights)) {
                  const band = bandAt(pair, night)
                  if (!band) continue
                  const x0 = u.valToPos(a, 'x', true)
                  const x1 = u.valToPos(b, 'x', true)
                  const y0 = u.valToPos(band[1], 'y', true)
                  const y1 = u.valToPos(band[0], 'y', true)
                  ctx.fillStyle = color.band
                  ctx.fillRect(x0, y0, x1 - x0, y1 - y0)
                  ctx.fillStyle = color.bandEdge
                  ctx.fillRect(x0, y0, x1 - x0, px)
                  ctx.fillRect(x0, y1 - px, x1 - x0, px)
                }
              }
              ctx.restore()
            },
          ],
          draw: [
            (u) => {
              // mark the latest value with a dot (surface ring keeps it apart from the line)
              const ys = u.data[1]
              let i = ys.length - 1
              while (i >= 0 && ys[i] == null) i -= 1
              if (i < 0) return
              const x = u.valToPos(u.data[0][i], 'x', true)
              const y = u.valToPos(ys[i], 'y', true)
              const r = 4 * uPlot.pxRatio
              const { ctx } = u
              ctx.save()
              ctx.beginPath()
              ctx.arc(x, y, r + 2 * uPlot.pxRatio, 0, 2 * Math.PI)
              ctx.fillStyle = color.surface
              ctx.fill()
              ctx.beginPath()
              ctx.arc(x, y, r, 0, 2 * Math.PI)
              ctx.fillStyle = color.line
              ctx.fill()
              ctx.restore()
            },
          ],
          setCursor: [(u) => shared.onCursor(u, spec.key)],
        },
      },
      [initial ? initial.t : [], initial ? initial[spec.key] : []],
      el,
    )
    plotRef.current = plot
    shared.plots.current[spec.key] = plot
    const observer = new ResizeObserver(() => {
      const width = Math.max(260, el.clientWidth)
      if (width !== plot.width) plot.setSize({ width, height: spec.height })
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      delete shared.plots.current[spec.key]
      plot.destroy()
      plotRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeKey, shared.syncKey])

  useEffect(() => {
    const plot = plotRef.current
    if (plot && data) plot.setData([data.t, data[spec.key]])
  }, [data, targetsKey, spec.key])

  const onKeyDown = (e) => {
    const plot = plotRef.current
    const d = shared.data.current
    if (!plot || !d?.t.length) return
    const last = d.t.length - 1
    let idx = plot.cursor.idx ?? last
    if (e.key === 'ArrowLeft') idx -= e.shiftKey ? 10 : 1
    else if (e.key === 'ArrowRight') idx += e.shiftKey ? 10 : 1
    else if (e.key === 'Home') idx = 0
    else if (e.key === 'End') idx = last
    else if (e.key === 'Escape') {
      shared.hide()
      return
    } else return
    e.preventDefault()
    shared.viaKey.current = true
    shared.moveTo(plot, Math.min(last, Math.max(0, idx)))
  }

  return (
    <div
      ref={box}
      className="trend-plot"
      tabIndex={0}
      role="img"
      aria-label={ariaLabel}
      onPointerEnter={() => {
        shared.active.current = spec.key
        shared.viaKey.current = false
      }}
      onPointerLeave={(e) => {
        if (e.pointerType !== 'touch') shared.hide()
      }}
      onFocus={() => {
        shared.active.current = spec.key
        const plot = plotRef.current
        const d = shared.data.current
        if (plot && d?.t.length && plot.cursor.idx == null) {
          shared.viaKey.current = true
          shared.moveTo(plot, d.t.length - 1)
        }
      }}
      onBlur={() => shared.hide()}
      onKeyDown={onKeyDown}
    />
  )
}

// ------------------------------------------------------------- the panel
// targets: {temp, humi, vpd}, each {day: [lo, hi], night: [lo, hi]} or null;
// targetNote: where they come from, for the legend.
export default function ClimateTrend({ data, loading, error, rangeKey, targets, targetNote, syncKey, historyHref }) {
  const range = rangeOf(rangeKey)
  const themeKey = useThemeKey()
  const wrap = useRef(null)
  const tipRef = useRef(null)
  const liveRef = useRef(null)
  const shown = useMemo(() => {
    const out = {}
    for (const spec of PLOTS) if (targets?.[spec.key]) out[spec.key] = targets[spec.key]
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(targets || null)])
  const targetsKey = JSON.stringify(shown)

  // Shared, render-independent state for the three charts (read from uPlot hooks).
  const shared = useRef(null)
  if (!shared.current) {
    shared.current = {
      syncKey,
      data: { current: data },
      targets: { current: shown },
      plots: { current: {} },
      active: { current: null },
      viaKey: { current: false },
    }
  }
  const s = shared.current
  s.syncKey = syncKey
  s.data.current = data
  s.targets.current = shown

  s.hide = () => {
    s.active.current = null
    if (tipRef.current) tipRef.current.hidden = true
    for (const plot of Object.values(s.plots.current)) {
      if (plot.cursor.left >= 0) plot.setCursor({ left: -10, top: -10 }, false, false)
    }
  }
  s.moveTo = (plot, idx) => {
    const d = s.data.current
    plot.setCursor({ left: plot.valToPos(d.t[idx], 'x'), top: plot.bbox.height / uPlot.pxRatio / 2 }, true, true)
  }
  s.onCursor = (u, key) => {
    const tip = tipRef.current
    const box = wrap.current
    const d = s.data.current
    if (!tip || !box || !d || s.active.current !== key) return
    const idx = u.cursor.idx
    if (idx == null || u.cursor.left == null || u.cursor.left < 0) {
      tip.hidden = true
      return
    }
    const ts = d.t[idx]
    const night = inNight(ts, d.nights)
    const lines = [timeLabel(ts)]
    tip.querySelector('time').textContent = lines[0]
    const light = tip.querySelector('.tip-light')
    light.textContent = night ? t('Licht aus') : ''
    light.hidden = !night
    for (const spec of PLOTS) {
      const row = tip.querySelector(`[data-k="${spec.key}"]`)
      const v = d[spec.key][idx]
      const status = statusText(spec.key, v, bandAt(s.targets.current[spec.key], night))
      row.querySelector('b').textContent = valueText(spec, v)
      row.querySelector('span').textContent = status ? `${spec.title}, ${status}` : spec.title
      lines.push(`${spec.title} ${valueText(spec, v)}${status ? `, ${status}` : ''}`)
    }
    tip.hidden = false
    const boxRect = box.getBoundingClientRect()
    const over = u.over.getBoundingClientRect()
    const x = over.left - boxRect.left + u.cursor.left
    const width = tip.offsetWidth
    const left = x + 14 + width > boxRect.width ? x - 14 - width : x + 14
    tip.style.left = `${Math.max(0, left)}px`
    tip.style.top = `${Math.max(0, over.top - boxRect.top + 4)}px`
    if (s.viaKey.current && liveRef.current) liveRef.current.textContent = lines.join(', ')
  }

  const stats = useMemo(() => {
    if (!data) return null
    return {
      temp: summarize(data, 'temp', shown.temp),
      humi: summarize(data, 'humi', shown.humi),
      vpd: summarize(data, 'vpd', shown.vpd),
    }
  }, [data, shown])

  const hasValues = !!stats && (stats.temp.n > 0 || stats.humi.n > 0)
  const nightsShown = !!data?.nights?.length

  const statItems = (spec) => {
    const st = stats?.[spec.key]
    if (!st || !st.n) return [['', t('keine Messwerte')]]
    const v = (x) => valueText(spec, x)
    if (st.share != null) {
      return [[t('Im Ziel'), t('{pct} % der Zeit', { pct: fmt(st.share * 100, 0) })], ['Ø', v(st.avg)]]
    }
    if (st.day != null && st.night != null) return [[t('Tag Ø'), v(st.day)], [t('Nacht Ø'), v(st.night)]]
    return [['Ø', v(st.avg)], [t('Spanne'), `${fmt(st.min, spec.digits)}–${v(st.max)}`]]
  }

  const aria = (spec) => {
    const items = statItems(spec).map(([label, value]) => `${label} ${value}`.trim()).join(', ')
    const vars = { title: spec.title, period: range.caption, items }
    if (!shown[spec.key]) return t('{title} {period}: {items}. Mit den Pfeiltasten einzelne Werte anzeigen.', vars)
    return t('{title} {period}: {items}, Ziel {target}. Mit den Pfeiltasten einzelne Werte anzeigen.', {
      ...vars, target: pairText(spec.key, shown[spec.key]),
    })
  }

  const table = useMemo(() => {
    if (!data || !hasValues) return []
    const groups = new Map()
    data.t.forEach((ts, i) => {
      const key = Math.floor(ts / range.table) * range.table
      let g = groups.get(key)
      if (!g) groups.set(key, (g = { ts: key, temp: [], humi: [], vpd: [], night: 0, n: 0 }))
      for (const k of ['temp', 'humi', 'vpd']) if (data[k][i] != null) g[k].push(data[k][i])
      g.n += 1
      if (inNight(ts, data.nights)) g.night += 1
    })
    const avg = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null)
    return [...groups.values()]
      .filter((g) => g.temp.length || g.humi.length)
      .map((g) => ({ ts: g.ts, temp: avg(g.temp), humi: avg(g.humi), vpd: avg(g.vpd), dark: g.night * 2 > g.n }))
      .reverse()
  }, [data, hasValues, range.table])

  return (
    <div className={`panel trend ${loading && data ? 'is-loading' : ''}`} ref={wrap}>
      <div className="trend-head">
        <h3>{range.title}</h3>
        {historyHref ? <a className="small" href={historyHref}>{t('Einzelne Sensoren im Verlauf öffnen')}</a> : null}
      </div>
      {error && !data ? <p className="muted small trend-note">{t('Der Verlauf ließ sich nicht laden: {error}', { error })}</p> : null}
      {!data && !error ? <p className="muted small trend-note">{t('Lade Verlauf …')}</p> : null}
      {data && !hasValues ? (
        <p className="muted small trend-note">
          {t('Für diesen Zeitraum gibt es noch keine gespeicherten Messwerte. GrowDeck speichert sie jede Minute, der Verlauf füllt sich ab jetzt.')}
        </p>
      ) : null}
      {data && hasValues ? (
        <div className="trend-body">
          {PLOTS.map((spec) => (
            <div className="trend-row" key={spec.key}>
              <div className="trend-row-head">
                <span className="trend-title">
                  <i className="trend-key" style={{ background: `var(${spec.color})` }} aria-hidden="true" />
                  {spec.title}
                </span>
                <span className="trend-stats">
                  {statItems(spec).map(([label, value]) => (
                    <span key={label || value}>{label ? `${label} ` : ''}<b>{value}</b></span>
                  ))}
                  {shown[spec.key] ? (
                    <span className="trend-target"><i className="swatch band" aria-hidden="true" />{t('Ziel {value}', { value: pairText(spec.key, shown[spec.key]) })}</span>
                  ) : null}
                </span>
              </div>
              <TrendPlot spec={spec} shared={s} data={data} themeKey={themeKey} targetsKey={targetsKey} ariaLabel={aria(spec)} />
            </div>
          ))}
          <div className="trend-foot">
            {nightsShown ? (
              <span><i className="swatch night" aria-hidden="true" />{data.night_source === 'schedule' ? t('Licht aus (nach den Lichtzeiten)') : t('Licht aus')}</span>
            ) : null}
            {Object.keys(shown).length && targetNote ? (
              <span><i className="swatch band" aria-hidden="true" />{targetNote}</span>
            ) : null}
          </div>
          <details className="trend-table">
            <summary>{t('Werte als Tabelle ({interval})', { interval: range.tableLabel })}</summary>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>{t('Zeit')}</th><th>{t('Temperatur')}</th><th>{t('Luftfeuchte')}</th><th>VPD</th><th>{t('Licht')}</th></tr>
                </thead>
                <tbody>
                  {table.map((row) => (
                    <tr key={row.ts}>
                      <td>{timeLabel(row.ts)}</td>
                      {PLOTS.map((spec) => {
                        const j = judge(spec.key, row[spec.key], bandAt(shown[spec.key], row.dark))
                        return (
                          <td className="num" key={spec.key}>
                            {valueText(spec, row[spec.key])}
                            {j && !j.inside ? <span className="cell-note"> {j.word}</span> : null}
                          </td>
                        )
                      })}
                      <td>{row.dark ? t('aus') : t('an')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <div className="trend-tip" ref={tipRef} hidden aria-hidden="true">
            <time />
            <div className="tip-light" hidden />
            {PLOTS.map((spec) => (
              <div className="tip-row" key={spec.key} data-k={spec.key}>
                <i style={{ background: `var(${spec.color})` }} />
                <b />
                <span />
              </div>
            ))}
          </div>
          <div className="visually-hidden" aria-live="polite" ref={liveRef} />
        </div>
      ) : null}
    </div>
  )
}

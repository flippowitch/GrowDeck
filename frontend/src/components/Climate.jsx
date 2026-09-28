import { useMemo } from 'react'
import { duration, fmt, fmtBand, hhmmToMinutes, minutesToHhmm, vpd } from '../format.js'
import { t } from '../i18n.js'

export function Readout({ label, value, digits = 1, unit, tone, hint, compact, text }) {
  return (
    <div className={`readout ${compact ? 'compact' : ''}`}>
      <span className="label">{label}</span>
      <span className={`value num ${tone || ''}`}>
        {text ?? fmt(value, digits)}
        {unit && text == null ? <small>{unit}</small> : null}
      </span>
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  )
}

// ---------------------------------------------------------------- VPD chart
const RH_MIN = 30
const RH_MAX = 90
const T_MIN = 16
const T_MAX = 34
const W = 420
const H = 290
const M = { l: 34, r: 12, t: 14, b: 28 }

const svp = (t) => 0.6108 * Math.exp((17.27 * t) / (t + 237.3))
const x = (rh) => M.l + ((rh - RH_MIN) / (RH_MAX - RH_MIN)) * (W - M.l - M.r)
const y = (t) => H - M.b - ((t - T_MIN) / (T_MAX - T_MIN)) * (H - M.t - M.b)
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

const rhAt = (v, t) => 100 * (1 - v / svp(t))
const toPath = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('')

// Area where vLo <= VPD <= vHi, clipped to the plot rectangle.
function zonePath(vLo, vHi) {
  const low = []
  const high = []
  for (let t = T_MIN; t <= T_MAX + 1e-9; t += 0.25) {
    const a = vHi === Infinity ? RH_MIN : clamp(rhAt(vHi, t), RH_MIN, RH_MAX)
    const b = vLo <= 0 ? RH_MAX : clamp(rhAt(vLo, t), RH_MIN, RH_MAX)
    low.push([x(a), y(t)])
    high.push([x(b), y(t)])
  }
  return `${toPath([...low, ...high.reverse()])}Z`
}

export function VpdChart({ temp, humi, band, trail = [] }) {
  const zones = useMemo(() => [
    { key: 'humid', d: zonePath(0, 0.4), fill: 'var(--frost-tint)' },
    ...(band ? [{ key: 'band', d: zonePath(band[0], band[1]), fill: 'var(--leaf-tint)' }] : []),
    { key: 'dry', d: zonePath(1.8, Infinity), fill: 'var(--alert-tint)' },
  ], [band])

  const isoLines = useMemo(() => [0.4, 0.8, 1.2, 1.6].map((level) => {
    const pts = []
    for (let t = T_MIN; t <= T_MAX + 1e-9; t += 0.25) {
      const rh = rhAt(level, t)
      if (rh >= RH_MIN && rh <= RH_MAX) pts.push([x(rh), y(t)])
    }
    const top = pts[pts.length - 1]
    let label = null
    if (top) {
      const nearRight = top[0] > W - M.r - 30
      label = { x: nearRight ? top[0] - 5 : top[0] + 4, y: nearRight ? top[1] + 14 : Math.max(M.t + 11, top[1] + 11), anchor: nearRight ? 'end' : 'start' }
    }
    return { level, d: toPath(pts), label }
  }), [])

  const hasPoint = temp != null && humi != null
  const px = hasPoint ? x(clamp(humi, RH_MIN, RH_MAX)) : 0
  const py = hasPoint ? y(clamp(temp, T_MIN, T_MAX)) : 0
  const trailPath = trail
    .filter((p) => p[0] != null && p[1] != null)
    .map((p, i) => `${i ? 'L' : 'M'}${x(clamp(p[1], RH_MIN, RH_MAX)).toFixed(1)},${y(clamp(p[0], T_MIN, T_MAX)).toFixed(1)}`)
    .join('')
  const current = hasPoint ? vpd(temp, humi) : null
  const inBand = band && current != null && current >= band[0] && current <= band[1]

  return (
    <figure className="vpd-chart" style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={hasPoint
          ? t('VPD-Diagramm: {temp} Grad, {humi} Prozent, VPD {vpd} Kilopascal', { temp: fmt(temp, 1), humi: fmt(humi, 0), vpd: fmt(current, 2) })
          : t('VPD-Diagramm ohne aktuelle Werte')}>
        <rect x={M.l} y={M.t} width={W - M.l - M.r} height={H - M.t - M.b} style={{ fill: 'var(--panel)' }} />
        {zones.map((z) => <path key={z.key} d={z.d} style={{ fill: z.fill }} />)}
        <rect x={M.l} y={M.t} width={W - M.l - M.r} height={H - M.t - M.b} fill="none" stroke="var(--line-strong)" />
        {isoLines.map((l) => (
          <g key={l.level}>
            <path className="iso" d={l.d} />
            {l.label ? <text className="iso-label" x={l.label.x} y={l.label.y} textAnchor={l.label.anchor}>{fmt(l.level, 1)}</text> : null}
          </g>
        ))}
        <g className="axis">
          {[30, 40, 50, 60, 70, 80, 90].map((rh) => (
            <text key={rh} x={x(rh)} y={H - 9} textAnchor="middle">{rh} %</text>
          ))}
          {[16, 20, 24, 28, 32].map((t) => (
            <text key={t} x={M.l - 6} y={y(t) + 4} textAnchor="end">{t}°</text>
          ))}
        </g>
        {trailPath ? <path className="trail" d={trailPath} /> : null}
        {hasPoint ? (
          <g>
            <line x1={px} x2={px} y1={M.t} y2={H - M.b} stroke="var(--ink)" strokeOpacity="0.25" />
            <line x1={M.l} x2={W - M.r} y1={py} y2={py} stroke="var(--ink)" strokeOpacity="0.25" />
            <circle className="point" cx={px} cy={py} r="6.5" />
          </g>
        ) : null}
      </svg>
      <figcaption className="caption">
        <span>{band ? t('Zielbereich {low}–{high} kPa', { low: fmtBand(band[0]), high: fmtBand(band[1]) }) : t('Kein VPD-Ziel in dieser Phase')}</span>
        <span>
          {current == null ? t('Keine Messwerte') : inBand ? t('Im Zielbereich') : band ? (current < band[0] ? t('Zu feucht für die Phase') : t('Zu trocken für die Phase')) : ''}
        </span>
      </figcaption>
    </figure>
  )
}

// ---------------------------------------------------------- photoperiod bar
export function Photoperiod({ dayStart = '06:00', dayEnd = '00:00', nowMs, actualDay }) {
  const start = hhmmToMinutes(dayStart)
  const end = hhmmToMinutes(dayEnd)
  const now = new Date(nowMs)
  const minute = now.getHours() * 60 + now.getMinutes()
  const always = start === end
  const dayLen = always ? 1440 : (end - start + 1440) % 1440
  const segments = always
    ? [[0, 1440]]
    : start < end
      ? [[start, end]]
      : [[start, 1440], [0, end]]
  const isDay = always || (start < end ? minute >= start && minute < end : minute >= start || minute < end)
  let caption
  if (always) caption = t('Licht dauerhaft an (24/0)')
  else if (isDay) caption = t('Tag, Licht aus in {time}', { time: duration(((end - minute + 1440) % 1440) * 60) })
  else caption = t('Nacht, Licht an in {time}', { time: duration(((start - minute + 1440) % 1440) * 60) })
  if (actualDay !== undefined && actualDay !== isDay) caption = actualDay ? t('Licht ist an, laut Plan wäre Nacht') : t('Licht ist aus, laut Plan wäre Tag')
  const ratio = `${Math.round(dayLen / 60)}/${24 - Math.round(dayLen / 60)}`
  return (
    <div className="photoperiod">
      <div className="spread">
        <span className="caption">{caption}</span>
        <span className="chip amber num">{ratio}</span>
      </div>
      <div className="bar" role="img" aria-label={t('Tag von {start} bis {end}', { start: minutesToHhmm(start), end: minutesToHhmm(end) })}>
        {segments.map(([a, b]) => (
          <span key={a} className="day" style={{ left: `${(a / 1440) * 100}%`, width: `${((b - a) / 1440) * 100}%` }} />
        ))}
        <span className="now" style={{ left: `calc(${(minute / 1440) * 100}% - 1px)` }} />
      </div>
      <div className="ticks">
        <span>0</span><span>6</span><span>12</span><span>18</span><span>24</span>
      </div>
    </div>
  )
}

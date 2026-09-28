// Building blocks of the Growplan page: cells, rows, inputs, dialogs, charts and the
// link to the tent (live values, lights, probes) the plan belongs to.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store.js'
import { fmt, hhmmToMinutes, vpd } from '../format.js'
import { t } from '../i18n.js'
import { climateSource } from '../pages/Overview.jsx'
import { Modal } from '../components/ui.jsx'
import {
  colFor, f1, f2, mixFor, num, numIn, parseNum, prodColor, rowAt, unitOf,
} from './engine.js'

// Bold parts ("<b>…</b>") in the texts taken over from the app, rendered as React elements
export function Rich({ text }) {
  const parts = String(text).split(/(<b>.*?<\/b>)/g)
  return parts.map((part, i) => (part.startsWith('<b>')
    ? <b key={i}>{part.slice(3, -4)}</b>
    : <Fragment key={i}>{part}</Fragment>))
}

export const Dot = ({ color }) => <span className="gp-dot" style={{ background: color }} aria-hidden="true" />

export function Block({ title, hint, children, id, className = '' }) {
  return (
    <section className={`gp-block ${className}`} id={id}>
      <div className="gp-blockhead">
        <h2>{title}</h2>
        {hint ? <span className="small muted">{hint}</span> : null}
      </div>
      {children}
    </section>
  )
}

// One value cell of the target grids. `live` = measured value in the tent with its tone.
export function Cell({ label, value, unit, note, live }) {
  return (
    <div className="gp-cell">
      <div className="gp-lab">{label}</div>
      <div className="gp-val num">{value}{unit ? <small>{unit}</small> : null}</div>
      {note ? <div className="gp-note">{note}</div> : null}
      {live ? <div className={`gp-live ${live.tone || ''}`}>{live.text}</div> : null}
    </div>
  )
}

// "zu warm", "zu feucht" … so the state does not depend on color alone
export function liveText(text, value, range, [low, high], margin = 0) {
  const tone = toneFor(value, range, margin)
  if (!tone || tone === 'good') return { text, tone }
  return { text: `${text}, ${value < range[0] ? low : high}`, tone }
}

export function toneFor(value, range, margin = 0) {
  if (value == null || !range) return ''
  if (value >= range[0] && value <= range[1]) return 'good'
  if (value >= range[0] - margin && value <= range[1] + margin) return 'warn'
  return 'bad'
}

// Text field for numbers with German decimal comma: keeps what is typed, reports numbers.
export function DecimalInput({ value, onValue, valid = () => true, className = 'input', ...rest }) {
  const [text, setText] = useState(numIn(value))
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setText(numIn(value))
  }, [value])
  return (
    <input
      type="text"
      inputMode="decimal"
      className={className}
      value={text}
      onFocus={() => { focused.current = true }}
      onBlur={() => {
        focused.current = false
        setText(numIn(value))
      }}
      onChange={(e) => {
        setText(e.target.value)
        const n = parseNum(e.target.value)
        if (n != null && valid(n)) onValue(n)
      }}
      {...rest}
    />
  )
}

export function ConfirmDialog({ title, text, okLabel, onOk, onClose }) {
  const [busy, setBusy] = useState(false)
  return (
    <Modal title={title} onClose={onClose}
      actions={<>
        <button type="button" className="btn ghost" onClick={onClose}>{t('Abbrechen')}</button>
        <button type="button" className="btn danger" disabled={busy} onClick={async () => {
          setBusy(true)
          try {
            await onOk()
          } finally {
            setBusy(false)
          }
        }}>{okLabel}</button>
      </>}>
      <p className="muted" style={{ margin: 0 }}>{text}</p>
    </Modal>
  )
}

// Watering can for one week: products and amounts for the chosen water and strength.
export function MixRows({ plan, sched, pos }) {
  const m = mixFor(sched, plan, pos.phase, pos.week)
  const f = plan.strength / 100
  const ec = rowAt(sched, 'ec', m.col)
  const note = rowAt(sched, 'notes', m.col)
  return (
    <div className="gp-rows">
      {m.water ? (
        <div className="gp-row flush">
          <div className="gp-nm">
            <b>{t('Nur klares Wasser')}</b>
            <span>{m.col.seed ? (sched.seed === 'water' ? t('{brand}: erst ab 10–15 cm Höhe düngen', { brand: t(sched.brand) }) : '')
              : m.col.flush ? t('Spülphase – kein Dünger') : t('Das Schema sieht diese Woche nichts vor')}</span>
          </div>
          <div className="gp-dose num">{num(plan.liters, 2)} L</div>
        </div>
      ) : m.items.map(({ p, v }) => {
        const u = unitOf(p)
        const cls = p.k === 'base' ? 'base' : p.k === 'flush' ? 'flush' : ''
        if (v < 0) {
          return (
            <div className={`gp-row miss ${cls}`} key={p.n}>
              <Dot color={prodColor(sched, p)} />
              <div className="gp-nm"><b>{t(p.n)}</b><span>{t('Wert fehlt – im Dünger-Tab über „Schema anpassen“ ergänzen')}</span></div>
              <div className="gp-dose num">? {u}<small>{t('{unit}/L unbekannt', { unit: u })}</small></div>
            </div>
          )
        }
        const perL = v * f
        const total = perL * plan.liters
        return (
          <div className={`gp-row ${cls}`} key={p.n}>
            <Dot color={prodColor(sched, p)} />
            <div className="gp-nm"><b>{t(p.n)}</b><span>{t(p.t)}</span></div>
            <div className="gp-dose num">{num(total, total < 10 ? 2 : 1)} {u}<small>{num(perL, 2)} {u}/L</small></div>
          </div>
        )
      })}
      {!m.water && m.col.flush ? <div className="gp-tip">{t('Letzte Woche: kein Basisdünger, nur die aufgeführten Spülprodukte.')}</div> : null}
      {ec != null ? (
        <div className="gp-row">
          <div className="gp-nm"><b>{t('Ziel-EC')}</b><span>{t('aus deinem Schema')}</span></div>
          <div className="gp-dose num">{f2(ec)}<small>mS/cm</small></div>
        </div>
      ) : null}
      {note ? <div className="gp-tip"><b>{t('Kommentar zur Woche:')}</b> {note}</div> : null}
    </div>
  )
}

export function weekColumn(sched, plan, pos) {
  return colFor(sched, pos.phase, pos.week, plan.floWeeks)
}

// --------------------------------------------------------------- the tent
function inWindow(minute, start, end) {
  const a = hhmmToMinutes(start)
  const b = hhmmToMinutes(end)
  if (a === b) return true
  return a < b ? minute >= a && minute < b : minute >= a || minute < b
}

export function lightHours(start, end) {
  const a = hhmmToMinutes(start)
  const b = hhmmToMinutes(end)
  return a === b ? 24 : Math.round((((b - a + 1440) % 1440) / 60) * 10) / 10
}

// Everything GrowDeck knows about the tent of a plan: room, devices, live climate,
// lights that can be dimmed and pH/EC probes.
export function useTent(summary, nowMs) {
  const rooms = useStore((s) => s.rooms)
  const devices = useStore((s) => s.devices)
  const roomControl = useStore((s) => s.roomControl)
  const settings = useStore((s) => s.settings)
  return useMemo(() => {
    const room = summary?.room_id ? rooms.find((r) => r.id === summary.room_id) || null : null
    // A plan without a tent stands for all devices while no room exists.
    const implicit = !!summary && !room && !rooms.length
    const tentRoom = room || (implicit ? {
      id: 'alle', name: t('Alle Geräte'), climate_device_id: null, climate_group: null,
      day_start: settings.day_start || '06:00', day_end: settings.day_end || '00:00',
    } : null)
    const list = Object.values(devices).filter((d) => !d.info?.hidden)
    const tentDevices = room ? list.filter((d) => d.info?.room_id === room.id) : implicit ? list : []
    const control = room ? roomControl?.[room.id] || null : null
    const source = tentRoom ? climateSource(tentRoom, devices, tentDevices) : { device: null }
    const averaged = control?.readings?.sources?.length > 1 ? control.readings : null
    const temp = averaged?.temp ?? source.temp?.value ?? null
    const humi = averaged?.humi ?? source.humi?.value ?? null
    const vpdValue = averaged ? vpd(temp, humi) : source.vpd?.value ?? vpd(temp, humi)
    const now = new Date(nowMs)
    const minute = now.getHours() * 60 + now.getMinutes()
    const day = control?.enabled && control.day_by === 'light' ? !!control.day
      : tentRoom ? inWindow(minute, tentRoom.day_start, tentRoom.day_end) : true
    // lights the room control knows come first; ports without a device are left out
    const known = new Set((control?.outputs || []).filter((o) => o.role === 'light').map((o) => `${o.device_id}|${o.control_id}`))
    const lights = []
    const probes = { ph: null, ec: null }
    for (const d of tentDevices) {
      for (const c of d.controls) {
        if (c.type === 'light' && !c.extra?.empty) lights.push({ device: d, control: c, known: known.has(`${d.id}|${c.id}`) })
      }
      for (const s of d.sensors) {
        if ((s.kind === 'ph' || s.kind === 'ec') && s.value != null && !probes[s.kind]) probes[s.kind] = { value: s.value, device: d }
      }
    }
    lights.sort((a, b) => Number(b.known) - Number(a.known))
    return {
      room, tentRoom, implicit, devices: tentDevices, control,
      live: {
        temp, humi, vpd: vpdValue, ppfd: source.ppfd?.value ?? null, day, device: source.device,
        online: !!source.device?.online, averaged: !!averaged,
      },
      lights, probes,
    }
  }, [summary, rooms, devices, roomControl, settings, nowMs])
}

export function levelFromPercent(control, pct) {
  const lo = Number(control.level_min ?? 0)
  const hi = Number(control.level_max ?? 100)
  const step = Number(control.level_step || 1)
  const raw = lo + (pct / 100) * (hi - lo)
  return Math.max(lo, Math.min(hi, Math.round(raw / step) * step))
}

export function percentOfLevel(control) {
  if (control.level == null) return null
  const lo = Number(control.level_min ?? 0)
  const hi = Number(control.level_max ?? 100)
  return hi > lo ? Math.round(((control.level - lo) / (hi - lo)) * 100) : null
}

// ---------------------------------------------------------------- charts
// EC or pH of the last measurements. Gießwasser and Drain keep their colors in both charts.
const CW = 520
const CH = 170
const CM = { l: 36, r: 12, t: 12, b: 24 }

export function MeasureChart({ labels, series, yMin, yMax, band, digits, unit, title }) {
  const [hover, setHover] = useState(null)
  const n = labels.length
  const hi = yMax <= yMin ? yMin + 1 : yMax
  const x = (i) => CM.l + (n <= 1 ? (CW - CM.l - CM.r) / 2 : (i * (CW - CM.l - CM.r)) / (n - 1))
  const y = (v) => CM.t + (1 - (v - yMin) / (hi - yMin)) * (CH - CM.t - CM.b)
  const ticks = [yMin, (yMin + hi) / 2, hi]
  const pick = (e) => {
    const box = e.currentTarget.getBoundingClientRect()
    const px = ((e.clientX - box.left) / box.width) * CW
    let best = 0
    for (let i = 1; i < n; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i
    setHover(best)
  }
  const tip = hover != null ? series.filter((s) => s.vals[hover] != null) : []
  return (
    <figure className="gp-chart">
      <figcaption className="small muted">{title}</figcaption>
      <div className="gp-chart-box">
        <svg viewBox={`0 0 ${CW} ${CH}`} role="img" aria-label={title}
          onPointerMove={pick} onPointerLeave={() => setHover(null)}>
          {band ? (() => {
            const top = y(Math.min(band[1], hi))
            const bottom = y(Math.max(band[0], yMin))
            return bottom > top ? <rect className="gp-band" x={CM.l} y={top} width={CW - CM.l - CM.r} height={bottom - top} /> : null
          })() : null}
          {ticks.map((v) => (
            <g key={v}>
              <line className="gp-gridline" x1={CM.l} x2={CW - CM.r} y1={y(v)} y2={y(v)} />
              <text className="gp-axis" x={CM.l - 6} y={y(v) + 4} textAnchor="end">{num(v, 2)}</text>
            </g>
          ))}
          {series.map((s) => {
            let d = ''
            s.vals.forEach((v, i) => {
              if (v == null) return
              d += `${d ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `
            })
            return (
              <g key={s.key} style={{ color: s.color }}>
                {d ? <path className="gp-line" d={d} /> : null}
                {s.vals.map((v, i) => (v == null ? null : <circle key={i} className="gp-pt" cx={x(i)} cy={y(v)} r={hover === i ? 5 : 3.5} />))}
              </g>
            )
          })}
          {hover != null ? <line className="gp-cross" x1={x(hover)} x2={x(hover)} y1={CM.t} y2={CH - CM.b} /> : null}
          {n ? <text className="gp-axis" x={CM.l} y={CH - 6}>{labels[0]}</text> : null}
          {n > 1 ? <text className="gp-axis" x={CW - CM.r} y={CH - 6} textAnchor="end">{labels[n - 1]}</text> : null}
        </svg>
        {hover != null && tip.length ? (
          <div className="gp-chart-tip" style={{ left: `${Math.min(84, Math.max(16, (x(hover) / CW) * 100))}%` }}>
            <b>{labels[hover]}</b>
            {tip.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label} {fmt(s.vals[hover], digits)}{unit ? ` ${unit}` : ''}</span>)}
          </div>
        ) : null}
      </div>
    </figure>
  )
}

export { f1, f2 }

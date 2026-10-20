// Calendar of a grow: one start date per phase (seedlings, veg, bloom) and the harvest,
// each adjustable on its own. Changing a date can move the later phases along, the whole
// plan can be shifted by days, and every phase can start "today" with one tap.
import { useState } from 'react'
import { t } from '../i18n.js'
import { PHASE_LBL } from './data.js'
import {
  addDays, autoPosition, clampInt, daysBetween, dateProblems, fmtDate, harvestISO, isISO, PHASE_DATES, phaseTimeline, setPhaseDate,
  setPhaseWeeks, shiftPlan,
} from './engine.js'

const SHIFT_KEY = 'gd-gp-shift-later'

function loadShift() {
  try {
    return localStorage.getItem(SHIFT_KEY) !== '0'
  } catch {
    return true
  }
}

// Weeks field that applies its value when left.
function Weeks({ value, min, max, onCommit, label }) {
  const [text, setText] = useState(null)
  const commit = () => {
    if (text == null) return
    const next = clampInt(text, min, max, value)
    setText(null)
    if (next !== value) onCommit(next)
  }
  return (
    <span className="gp-weeks">
      <input type="number" className="input" min={min} max={max} value={text ?? value} aria-label={label}
        onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
      <span className="muted small">{t('Wo.')}</span>
    </span>
  )
}

function spanText(start, end) {
  if (!isISO(start) || !isISO(end)) return ''
  const days = daysBetween(start, end)
  if (days <= 0) return ''
  const weeks = Math.floor(days / 7)
  const rest = days % 7
  if (!weeks) return days === 1 ? t('1 Tag') : t('{n} Tage', { n: days })
  if (!rest) return weeks === 1 ? t('1 Woche') : t('{n} Wochen', { n: weeks })
  return t('{weeks} Wo. {days} T.', { weeks, days: rest })
}

// Bar with the phases in proportion and a marker for today.
function TimelineBar({ plan, today }) {
  const phases = phaseTimeline(plan).filter((p) => isISO(p.start) && isISO(p.end) && p.end > p.start)
  if (!phases.length) return null
  const first = phases[0].start
  const last = phases[phases.length - 1].end
  const total = Math.max(1, daysBetween(first, last))
  const at = (iso) => `${Math.max(0, Math.min(100, (daysBetween(first, iso) / total) * 100))}%`
  const inside = today >= first && today <= last
  return (
    <div className="gp-timeline" role="img"
      aria-label={phases.map((p) => `${PHASE_LBL[p.key]} ${fmtDate(p.start)} – ${fmtDate(p.end)}`).join(', ')}>
      <div className="gp-tl-bar">
        {phases.map((p) => (
          <span key={p.key} className={`gp-tl-${p.key}`}
            style={{ left: at(p.start), width: `calc(${at(p.end)} - ${at(p.start)})` }}>
            <b>{PHASE_LBL[p.key]}</b>
          </span>
        ))}
        {inside ? <i className="gp-tl-today" style={{ left: at(today) }} title={t('Heute')} /> : null}
      </div>
      <div className="gp-tl-ends small muted">
        <span>{fmtDate(first)}</span>
        <span>{fmtDate(last)}</span>
      </div>
    </div>
  )
}

export default function PhaseDates({ g }) {
  const { plan, update, today } = g
  const [shiftLater, setShiftLater] = useState(loadShift)
  const [shiftBy, setShiftBy] = useState(7)
  const toggleShift = (on) => {
    setShiftLater(on)
    try {
      localStorage.setItem(SHIFT_KEY, on ? '1' : '0')
    } catch {
      /* storage unavailable */
    }
  }
  // without manual position the plan follows the dates; keep phase and week in step with them
  const settle = (next) => {
    const auto = autoPosition(next, today)
    return auto ? { ...next, phase: auto.phase, week: auto.week } : next
  }
  const setDate = (key, value) => update((d) => settle(setPhaseDate(d, key, value, shiftLater)))
  const timeline = phaseTimeline(plan)
  const harvest = harvestISO(plan)
  const problems = dateProblems(plan)
  const anyDate = timeline.some((p) => isISO(p.start)) || isISO(plan.harvestDate)

  const row = (phase, label, extra) => {
    const p = timeline.find((x) => x.key === phase)
    const running = isISO(p.start) && p.start <= today && (!isISO(p.end) || today < p.end)
    // "today" makes no sense for a phase that a later one already followed
    const later = PHASE_DATES.slice(PHASE_DATES.indexOf(p.field) + 1)
    const canStartToday = p.start !== today && !later.some((k) => isISO(plan[k]) && plan[k] <= today)
    return (
      <div className={`gp-pd-row ${running ? 'now' : ''}`} key={phase}>
        <div className="gp-pd-name">
          <span className={`gp-pd-dot gp-tl-${phase}`} aria-hidden="true" />
          <b>{label}</b>
          {running ? <span className="chip leaf">{t('läuft')}</span> : null}
        </div>
        <label className="gp-pd-date">
          <span className="muted small">{t('Start')}</span>
          <input type="date" className="input" value={p.start} onChange={(e) => setDate(p.field, e.target.value)}
            aria-label={t('Start {phase}', { phase: label })} />
        </label>
        <div className="gp-pd-len">
          {extra}
          {spanText(p.start, p.end) ? <span className="muted small">{t('Dauer {span}', { span: spanText(p.start, p.end) })}</span> : null}
        </div>
        <div className="gp-pd-acts">
          {canStartToday ? (
            <button type="button" className="btn small" onClick={() => setDate(p.field, today)}>{t('Heute')}</button>
          ) : null}
          {p.start ? (
            <button type="button" className="btn small ghost" onClick={() => setDate(p.field, '')}
              aria-label={t('Datum {phase} löschen', { phase: label })}>{t('Leeren')}</button>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className="stack">
      <TimelineBar plan={plan} today={today} />
      <div className="gp-pd">
        {row('seed', PHASE_LBL.seed, null)}
        {row('veg', PHASE_LBL.veg,
          <Weeks label={t('Wachstum in Wochen')} value={plan.vegWeeks} min={1} max={12}
            onCommit={(weeks) => update((d) => settle(setPhaseWeeks(d, 'veg', weeks, today)))} />)}
        {row('flower', t('Blüte (12/12)'),
          <Weeks label={t('Blüte in Wochen')} value={plan.floWeeks} min={4} max={16}
            onCommit={(weeks) => update((d) => settle(setPhaseWeeks(d, 'flower', weeks, today)))} />)}
        <div className="gp-pd-row">
          <div className="gp-pd-name">
            <span className="gp-pd-dot gp-tl-harvest" aria-hidden="true" />
            <b>{t('Ernte')}</b>
          </div>
          <label className="gp-pd-date">
            <span className="muted small">{isISO(plan.harvestDate) ? t('Eigenes Datum') : t('Berechnet')}</span>
            <input type="date" className="input" value={harvest} onChange={(e) => setDate('harvestDate', e.target.value)}
              aria-label={t('Erntedatum')} />
          </label>
          <div className="gp-pd-len">
            {isISO(harvest) && harvest >= today ? (
              <span className="muted small">{daysBetween(today, harvest) === 0 ? t('heute') : t('in {n} Tagen', { n: daysBetween(today, harvest) })}</span>
            ) : null}
          </div>
          <div className="gp-pd-acts">
            {isISO(plan.harvestDate) ? (
              <button type="button" className="btn small ghost" onClick={() => update((d) => settle({ ...d, harvestDate: '' }))}
                title={t('Ernte wieder aus Blütestart und Blütewochen berechnen')}>{t('Berechnen')}</button>
            ) : null}
          </div>
        </div>
      </div>

      {problems.length ? <div className="notice">{problems.join(' ')}</div> : null}

      <label className="check small">
        <input type="checkbox" checked={shiftLater} onChange={(e) => toggleShift(e.target.checked)} />
        {t('Spätere Phasen mitverschieben, wenn ich ein Datum ändere')}
      </label>

      {anyDate ? (
        <div className="row gp-shift">
          <span className="small muted">{t('Ganzen Plan verschieben')}</span>
          <select className="input" value={shiftBy} onChange={(e) => setShiftBy(Number(e.target.value))} aria-label={t('Tage')}>
            {[1, 2, 3, 7, 14].map((n) => <option key={n} value={n}>{n === 1 ? t('1 Tag') : t('{n} Tage', { n })}</option>)}
          </select>
          <button type="button" className="btn small" onClick={() => update((d) => settle(shiftPlan(d, -shiftBy)))}>{t('früher')}</button>
          <button type="button" className="btn small" onClick={() => update((d) => settle(shiftPlan(d, shiftBy)))}>{t('später')}</button>
        </div>
      ) : null}

      <p className="small muted" style={{ margin: 0 }}>
        {anyDate
          ? t('Phase und Woche ergeben sich aus den Daten – auch für Übersicht, Alarme und Zeltsteuerung. Liegen zwei Daten fest, passt GrowDeck die Wochen dazwischen an.')
          : t('Trag die Starttage ein, dann bestimmt GrowDeck Phase und Woche selbst. Ohne Daten gilt die Woche, die du oben einstellst.')}
        {isISO(plan.vegStart) && !isISO(plan.floStart) ? ` ${t('Blüte voraussichtlich ab {date}.', { date: fmtDate(addDays(plan.vegStart, plan.vegWeeks * 7)) })}` : ''}
      </p>
    </div>
  )
}

// Tab "Heute": targets of the week next to the live values of the tent, the watering
// can, safety checklist, plants and the setup of the grow.
import { useState } from 'react'
import { toast } from '../store.js'
import { fmt } from '../format.js'
import { t } from '../i18n.js'
import { Field, Segmented } from '../components/ui.jsx'
import { CHECK_GROUPS, MEDIUM_LBL, PHASE_LBL, PLANT_TYPES } from './data.js'
import {
  activePlants, agoText, autoPosition, checkDone, checkItems, clampInt, clampWeek, currentSched, daysBetween, dimForPPFD,
  dli, envAdj, envOf, f1, fmtDate, hasMissing, klxRange, lastWatering, mid, newPlant, num, phTarget, rng, rngV, shortLamp,
  stageKey, vpdOf,
} from './engine.js'
import { Block, Cell, DecimalInput, lightHours, liveText, MixRows, percentOfLevel, Rich } from './parts.jsx'
import { CameraTile, WateringNotices } from './extras.jsx'

const TENTS = [['0.36', '60 × 60 cm'], ['0.49', '70 × 70 cm'], ['0.64', '80 × 80 cm'], ['0.81', '90 × 90 cm'],
  ['1.00', '100 × 100 cm'], ['1.20', '100 × 120 cm'], ['1.44', '120 × 120 cm']]

export function tentOptions(tent) {
  const value = Number(tent).toFixed(2)
  return TENTS.some(([v]) => v === value) ? TENTS : [...TENTS, [value, `${num(Number(tent), 2)} m²`]]
}

// Weeks field that applies its value when left, like the number fields of the app.
function WeeksInput({ value, min, max, onCommit, label }) {
  const [text, setText] = useState(String(value))
  const [shown, setShown] = useState(value)
  if (shown !== value) {
    setShown(value)
    setText(String(value))
  }
  const commit = () => {
    const next = clampInt(text, min, max, value)
    setText(String(next))
    if (next !== value) onCommit(next)
  }
  return (
    <input type="number" className="input" min={min} max={max} value={text} aria-label={label}
      onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
  )
}

export function liveCells(g, e) {
  const { tent, pos, current } = g
  const live = tent.live
  const out = {}
  if (tent.tentRoom) {
    const hours = lightHours(tent.tentRoom.day_start, tent.tentRoom.day_end)
    out.light = { text: t('Zelt {start}–{end} ({hours} h)', { start: tent.tentRoom.day_start, end: tent.tentRoom.day_end, hours: num(hours) }), tone: Math.abs(hours - e.h) < 0.5 ? 'good' : 'warn' }
  }
  if (pos.phase !== current.phase || pos.week !== current.week) return out
  const dimmable = tent.lights.find((l) => l.control.features?.includes('level'))
  if (dimmable) {
    const pct = percentOfLevel(dimmable.control)
    out.dim = { text: dimmable.control.on === false ? t('Licht ist gerade aus') : pct != null ? t('Licht jetzt {pct} %', { pct }) : '' }
  }
  if (!live.device) return out
  if (live.temp != null) {
    const temp = fmt(live.temp, 1)
    out.temp = liveText(live.day ? t('jetzt {temp} °C (Tag)', { temp }) : t('jetzt {temp} °C (Nacht)', { temp }), live.temp, live.day ? e.tag : e.nacht, [t('zu kühl'), t('zu warm')], 1)
  }
  if (live.humi != null) out.humi = liveText(t('jetzt {humi} %', { humi: fmt(live.humi, 0) }), live.humi, e.rh, [t('zu trocken'), t('zu feucht')], 5)
  if (live.temp != null && live.humi != null) {
    // Growplan's VPD targets are leaf VPD: by day the leaf is cooler (offset of the VPD calculator)
    const leaf = vpdOf(live.temp, live.humi, live.day ? g.plan.leafOff : 0)
    out.vpd = live.day
      ? liveText(t('Blatt jetzt {vpd} kPa', { vpd: fmt(leaf, 2) }), leaf, e.vpd, [t('zu feucht'), t('zu trocken')], 0.15)
      : { text: t('Blatt jetzt {vpd} kPa (Nacht)', { vpd: fmt(leaf, 2) }) }
  }
  if (live.ppfd != null && live.day) out.ppfd = liveText(t('gemessen {ppfd}', { ppfd: fmt(live.ppfd, 0) }), live.ppfd, e.ppfd, [t('zu wenig'), t('zu viel')], e.ppfd[0] * 0.1)
  return out
}

const liveSource = (live) => (live.averaged ? t('Mittelwert der Geräte im Zelt') : live.device.name)

function Targets({ g }) {
  const { plan, lib, pos, log, today, tent } = g
  const sched = currentSched(lib, plan)
  const k = stageKey(pos.phase, pos.week, plan.floWeeks)
  const e = envOf(plan, k)
  const p = Math.round(mid(e.ppfd))
  const ph = phTarget(sched, plan.medium)
  const last = lastWatering(log)
  const live = liveCells(g, e)
  const probe = tent.probes.ph && pos.phase === g.current.phase && pos.week === g.current.week
    ? liveText(t('Sonde {value}', { value: f1(tent.probes.ph.value) }), tent.probes.ph.value, ph, [t('zu sauer'), t('zu basisch')], 0.2) : null
  return (
    <Block title={t('Sollwerte diese Woche')} hint={envAdj(plan, k) ? t('deine angepassten Werte') : t('Richtwerte')}>
      <div className="gp-grid">
        <Cell label={t('PPFD am Blatt')} value={rng(e.ppfd)} unit="µmol/m²s" note={`≈ ${klxRange(plan, e.ppfd)} klx (Lux)`} live={live.ppfd} />
        <Cell label={`Dimmer ${shortLamp(plan)}`} value={dimForPPFD(plan, p)} unit="%" note={t('Höhe {range}', { range: rng(e.hoehe, 'cm') })} live={live.dim} />
        <Cell label={t('Temperatur Tag')} value={rng(e.tag)} unit="°C" note={t('Nacht {range}', { range: rng(e.nacht, '°C') })} live={live.temp} />
        <Cell label={t('Luftfeuchte')} value={rng(e.rh)} unit="%" note={t('relativ')} live={live.humi} />
        <Cell label="VPD" value={rngV(e.vpd)} unit="kPa" note={t('Blatt zu Luft')} live={live.vpd} />
        <Cell label={t('pH Gießwasser')} value={`${f1(ph[0])}–${f1(ph[1])}`} note={sched.phRange ? t('laut Hersteller') : MEDIUM_LBL[plan.medium]} live={probe} />
        <Cell label={t('Beleuchtung')} value={`${e.h}/${24 - e.h}`} unit="h" note={t('DLI ca. {dli} mol/m²·Tag', { dli: num(dli(p, e.h), 0) })} live={live.light} />
        <Cell label={t('Zuletzt gegossen')} value={last ? agoText(last.date, today) : '–'}
          note={last ? `${fmtDate(last.date)}${last.liters ? ` · ${num(last.liters, 2)} L` : ''}` : t('noch kein Eintrag')} />
      </div>
      {tent.live.device ? (
        <p className="small muted gp-source">
          {pos.phase === g.current.phase && pos.week === g.current.week
            ? (tent.live.online ? t('Messwerte: {source}.', { source: liveSource(tent.live) }) : t('Messwerte: {source} (offline).', { source: liveSource(tent.live) }))
            : t('Vorschau auf eine andere Woche – Messwerte erscheinen nur bei der aktuellen Woche.')}
        </p>
      ) : null}
    </Block>
  )
}

function MixBlock({ g }) {
  const { plan, lib, pos, today, update } = g
  const sched = currentSched(lib, plan)
  const items = checkItems(lib)
  const done = checkDone(lib, today)
  const doneCount = items.filter((c) => done.includes(c.id)).length
  const all = items.length > 0 && doneCount === items.length
  return (
    <Block title={t('Kanne mischen')} hint={`${num(plan.liters, 2)} L · ${plan.strength} %`}>
      <div className="panel">
        <button type="button" className="gp-chkline" onClick={() => document.getElementById('gp-check')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
          <span className={`gp-box ${all ? 'full' : ''}`} aria-hidden="true">{all ? '✓' : ''}</span>
          <span>{all ? t('Sicherheits-Checkliste heute erledigt') : t('Sicherheits-Checkliste: {done} von {total} erledigt', { done: doneCount, total: items.length })}</span>
          <span className="gp-go" aria-hidden="true">›</span>
        </button>
        <div className="gp-pad gp-form2">
          <Field label={t('Wassermenge (Liter)')}>
            <DecimalInput value={plan.liters} valid={(v) => v > 0 && v <= 500} onValue={(liters) => update({ liters })} />
          </Field>
          <label className="field">
            <span>{t('Dosierstärke {value}', { value: <b className="num">{plan.strength} %</b> })}</span>
            <input type="range" min={25} max={100} step={5} value={plan.strength} aria-label={t('Dosierstärke')}
              style={{ '--fill': `${((plan.strength - 25) / 75) * 100}%` }}
              onChange={(ev) => update({ strength: parseInt(ev.target.value, 10) })} />
          </label>
        </div>
        <MixRows plan={plan} sched={sched} pos={pos} />
        <div className="gp-pad gp-foot">
          <button type="button" className="btn primary gp-wide" onClick={() => g.newEntry()}>{t('Als Gießung eintragen')}</button>
        </div>
      </div>
      {hasMissing(sched) ? <div className="notice gp-gap">{t('Im gewählten Schema fehlen noch Werte (?). Ergänze sie im Dünger-Tab über „Schema anpassen“.')}</div> : null}
    </Block>
  )
}

function Checklist({ g }) {
  const { lib, today, saveLibrary } = g
  const items = checkItems(lib)
  const done = checkDone(lib, today)
  const doneCount = items.filter((c) => done.includes(c.id)).length
  const toggle = (id) => saveLibrary({ check: { date: today, done: done.includes(id) ? done.filter((x) => x !== id) : [...done, id] } }).catch(() => {})
  return (
    <Block id="gp-check" title={t('Sicherheits-Checkliste')} hint={items.length ? t('{done} von {total} erledigt', { done: doneCount, total: items.length }) : ''}>
      <div className="panel">
        {CHECK_GROUPS.map(([group, label]) => {
          const its = items.filter((c) => c.g === group)
          if (!its.length) return null
          return (
            <div key={group}>
              <div className="gp-chkgroup">{label}</div>
              {its.map((c) => {
                const on = done.includes(c.id)
                return (
                  <button type="button" key={c.id} className={`gp-chk ${on ? 'on done' : ''}`} aria-pressed={on} onClick={() => toggle(c.id)}>
                    <span className="gp-box" aria-hidden="true">{on ? '✓' : ''}</span><span className="gp-ct">{t(c.t)}</span>
                  </button>
                )
              })}
            </div>
          )
        })}
        {!items.length ? <div className="gp-pad muted">{t('Alle Punkte sind ausgeblendet – über „Liste anpassen“ wieder einblenden.')}</div> : null}
        <div className="gp-tip">
          <Rich text={t('<b>Wenn doch etwas passiert:</b> Haut mit viel Wasser abspülen. Spritzer ins Auge einige Minuten behutsam mit Wasser ausspülen und bei Beschwerden zum Arzt. Verschluckt: Mund ausspülen und den Giftnotruf anrufen, im Notfall 112. Die Häkchen setzen sich jeden Tag automatisch zurück.')} />
        </div>
        <div className="gp-pad gp-foot row">
          <button type="button" className="btn small" onClick={() => saveLibrary({ check: { date: today, done: [] } }).then(() => toast(t('Häkchen zurückgesetzt'))).catch(() => {})}>{t('Häkchen zurücksetzen')}</button>
          <button type="button" className="btn small" onClick={() => g.open({ kind: 'check' })}>{t('Liste anpassen')}</button>
        </div>
      </div>
    </Block>
  )
}

function plantAge(p, today) {
  if (!p.start) return ''
  const d = daysBetween(p.start, today)
  if (d < 0) return t('Start {date}', { date: fmtDate(p.start) })
  return t('Tag {day} (Woche {week})', { day: d + 1, week: Math.floor(d / 7) + 1 })
}

function Plants({ g }) {
  const { plan, today } = g
  const ps = activePlants(plan)
  return (
    <Block title={t('Pflanzen')} hint={ps.length === 1 ? t('{n} Pflanze', { n: ps.length }) : t('{n} Pflanzen', { n: ps.length })}>
      {ps.length ? (
        <div className="gp-entries">
          {ps.map((p) => {
            const sub = [p.strain, PLANT_TYPES[p.type], p.pot ? t('{size} L Topf', { size: num(p.pot, 1) }) : '', plantAge(p, today)].filter(Boolean).join(' · ')
            return (
              <button type="button" className="gp-entry" key={p.id} onClick={() => g.open({ kind: 'plant', plant: p, isNew: false })}>
                <div className="gp-l1"><span className="gp-d">{p.name}</span>{p.type === 'auto' ? <span className="chip amber">{t('Auto')}</span> : null}</div>
                <div className="gp-l2">{sub || t('Antippen, um Sorte, Typ, Topfgröße und Startdatum einzutragen')}</div>
                {p.note ? <div className="gp-l2">{p.note}</div> : null}
              </button>
            )
          })}
        </div>
      ) : <div className="panel gp-pad muted">{t('Noch keine Pflanzen angelegt.')}</div>}
      <button type="button" className="btn gp-wide gp-gap" disabled={ps.length >= 12}
        onClick={() => (ps.length >= 12 ? toast(t('Maximal 12 Pflanzen'), 'warn') : g.open({ kind: 'plant', plant: newPlant(t('Pflanze {n}', { n: ps.length + 1 })), isNew: true }))}>
        + {t('Pflanze hinzufügen')}
      </button>
    </Block>
  )
}

function Setup({ g }) {
  const { plan, pos, update } = g
  const setDate = (key) => (ev) => update((d) => {
    const next = { ...d, [key]: ev.target.value }
    const auto = autoPosition(next, g.today)
    return auto ? { ...next, phase: auto.phase, week: auto.week } : next
  })
  return (
    <Block title={t('Setup')}>
      <div className="panel gp-pad stack">
        <div className="gp-form2">
          <Field label={t('Start Wachstum')}><input type="date" className="input" value={plan.vegStart} onChange={setDate('vegStart')} /></Field>
          <Field label={t('Umstellung 12/12')}><input type="date" className="input" value={plan.floStart} onChange={setDate('floStart')} /></Field>
        </div>
        <div className="gp-form3">
          <Field label={t('Wachstum (Wo.)')}>
            <WeeksInput label={t('Wachstum in Wochen')} value={plan.vegWeeks} min={1} max={12} onCommit={(vegWeeks) => update((d) => clampWeek({ ...d, vegWeeks }))} />
          </Field>
          <Field label={t('Blüte inkl. Spülen')}>
            <WeeksInput label={t('Blüte in Wochen')} value={plan.floWeeks} min={4} max={16} onCommit={(floWeeks) => update((d) => clampWeek({ ...d, floWeeks }))} />
          </Field>
          <Field label={t('Fläche')}>
            <select className="input" value={Number(plan.tent).toFixed(2)} onChange={(ev) => update({ tent: parseFloat(ev.target.value) })}>
              {tentOptions(plan.tent).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </Field>
        </div>
        <div className="field">
          <span>{t('Medium')}</span>
          <Segmented label={t('Medium')} value={plan.medium} onChange={(medium) => update({ medium })}
            options={Object.entries(MEDIUM_LBL).map(([key, label]) => ({ key, label }))} />
        </div>
        <div className="field">
          <span>{t('Phase manuell setzen')}</span>
          <Segmented label={t('Phase')} value={pos.phase} onChange={(phase) => g.setPhase(phase)}
            options={[{ key: 'seed', label: t('Sämling') }, { key: 'veg', label: PHASE_LBL.veg }, { key: 'flower', label: PHASE_LBL.flower }]} />
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          {t('Mit eingetragenen Daten bestimmt GrowDeck Phase und Woche automatisch – auch für die Übersicht und die Zeltsteuerung. Ohne Daten gilt die Woche, die du oben einstellst. Der Plan liegt in GrowDeck und ist auf allen Geräten gleich.')}
        </p>
      </div>
    </Block>
  )
}

export default function Today({ g, extra }) {
  return (
    <div className="gp-cols">
      <div className="gp-col">
        <WateringNotices g={g} />
        <Targets g={g} />
        <MixBlock g={g} />
      </div>
      <div className="gp-col">
        <CameraTile g={g} />
        <Checklist g={g} />
        <Plants g={g} />
        <Setup g={g} />
        {extra}
      </div>
    </div>
  )
}

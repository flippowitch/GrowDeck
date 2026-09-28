// Tab "Licht": dimmer and height for the week, dimmer calculator with the lights of the
// tent, lux conversion, table per phase, lamp data and the light times of the tent.
import { useState } from 'react'
import { api, loadState, sendCommand, toast, useStore } from '../store.js'
import { sliderLock } from '../controlLock.js'
import { fmt, minutesToHhmm, hhmmToMinutes, VENDORS } from '../format.js'
import { t } from '../i18n.js'
import { ENV, ENV_KEYS, LAMP_DEFAULT } from './data.js'
import {
  dimForPPFD, dli, envAdj, envOf, fmtInt, klx, klxRange, luxOf, luxR, luxRange, mid, num, parseNum, ppfdForDim, rng,
  shortLamp, stageKey,
} from './engine.js'
import { liveCells } from './Today.jsx'
import { Block, Cell, lightHours, levelFromPercent, percentOfLevel } from './parts.jsx'

function LuxCheck({ g, e, nm }) {
  const { plan, update } = g
  const raw = parseNum(plan.luxIn)
  let result = null
  if (raw != null && raw > 0) {
    const ppfd = raw / plan.lamp.luxF
    const [lo, hi] = e.ppfd
    const sug = Math.max(10, Math.min(100, Math.round((plan.dim * mid(e.ppfd)) / ppfd / 5) * 5))
    const base = `≈ ${fmtInt(ppfd)} µmol/m²s. `
    const range = rng(e.ppfd)
    let cls
    let text
    if (ppfd < lo * 0.9) {
      cls = 'bad'
      const advice = sug > plan.dim
        ? t('Dimmer von {from} % auf etwa {to} % erhöhen oder die Lampe tiefer hängen.', { from: plan.dim, to: sug })
        : t('Lampe tiefer hängen – der Dimmer steht schon hoch.')
      text = `${base}${t('Zu wenig Licht für {stage} (Ziel {range}).', { stage: nm, range })} ${advice}`
    } else if (ppfd < lo) {
      cls = 'warn'
      text = `${base}${t('Knapp unter dem Ziel {range} – etwas mehr Licht wäre gut.', { range })}`
    } else if (ppfd <= hi) {
      cls = 'good'
      text = `${base}${t('Im Zielbereich für {stage} ({range}). Passt.', { stage: nm, range })}`
    } else if (ppfd <= hi * 1.1) {
      cls = 'warn'
      text = `${base}${t('Leicht über dem Ziel {range} – auf helle, nach oben gewölbte Blätter achten.', { range })}`
    } else {
      cls = 'bad'
      text = `${base}${t('Zu viel Licht für {stage} (Ziel {range}). Dimmer von {from} % auf etwa {to} % senken oder die Lampe höher hängen.', { stage: nm, range, from: plan.dim, to: sug })}`
    }
    result = { value: fmtInt(ppfd), cls, text }
  }
  return (
    <Block title={t('Lux-Messung umrechnen')} hint={t('Faktor {factor} lx je µmol/m²s', { factor: num(plan.lamp.luxF, 1) })}>
      <div className="panel">
        <div className="gp-pad">
          <label className="field"><span>{t('Gemessen auf Höhe der obersten Blätter (Lux)')}</span>
            <input className="input" inputMode="numeric" placeholder={t('z. B. 40000')} value={plan.luxIn} maxLength={12}
              onChange={(ev) => update({ luxIn: ev.target.value.slice(0, 12) })} />
          </label>
        </div>
        <div className="gp-verdict">
          <div className={`gp-big num ${result?.cls || ''}`}>{result ? result.value : '–'}</div>
          <div className="small muted">
            {result ? result.text : t('Miss mit einem Luxmeter auf Höhe der obersten Blätter und trag den Wert ein – GrowDeck rechnet ihn in PPFD um und vergleicht mit dem Ziel für {stage}.', { stage: nm })}
          </div>
        </div>
        <div className="gp-tip">
          {t('Lux beschreibt die Helligkeit fürs menschliche Auge, PPFD das Licht, das die Pflanze nutzt. Die Umrechnung hängt vom Spektrum ab und bleibt eine Schätzung (±10–15 %). Handy-Apps messen oft ungenau – ein einfaches Luxmeter ist zuverlässiger. Die Dimmer-Empfehlung bezieht sich auf den Wert im Dimmer-Rechner.')}
        </div>
      </div>
    </Block>
  )
}

function Dimmer({ g, e, recommended }) {
  const { plan, update, tent } = g
  const [busy, setBusy] = useState('')
  const roomControl = useStore((s) => s.roomControl)
  const l = plan.lamp
  const est = ppfdForDim(plan, plan.dim)
  const kwhDay = (l.watt * plan.dim) / 100 * e.h / 1000
  const all = tent.lights.filter((x) => x.control.features?.includes('level'))
  // with lights assigned in the room control only those, otherwise every dimmable light in the tent
  const dimmable = all.some((x) => x.known) ? all.filter((x) => x.known) : all
  const apply = async ({ device, control }) => {
    const level = levelFromPercent(control, plan.dim)
    setBusy(`${device.id}|${control.id}`)
    try {
      await sendCommand(device.id, control.id, { level })
      toast(t('{control} ({device}) auf {pct} % gestellt.', { control: t(control.label), device: device.name, pct: plan.dim }))
    } catch {
      /* toast shown */
    } finally {
      setBusy('')
    }
  }
  return (
    <Block title={t('Dimmer-Rechner')} hint={t('Schätzung ±15 %')}>
      <div className="panel">
        <div className="gp-pad">
          <label className="field">
            <span>{t('Dimmer {value}', { value: <b className="num">{plan.dim} %</b> })}</span>
            <input type="range" className="light" min={10} max={100} step={5} value={plan.dim} aria-label={t('Dimmer')}
              style={{ '--fill': `${((plan.dim - 10) / 90) * 100}%` }}
              onChange={(ev) => update({ dim: parseInt(ev.target.value, 10) })} />
          </label>
          {plan.dim !== recommended ? (
            <button type="button" className="btn small gp-gap" onClick={() => update({ dim: recommended })}>{t('Empfehlung für diese Woche einsetzen ({pct} %)', { pct: recommended })}</button>
          ) : null}
        </div>
        <div className="gp-grid flat">
          <Cell label={t('PPFD geschätzt')} value={est} unit="µmol/m²s" note={t('Durchschnitt über die Fläche')} />
          <Cell label={t('Lux geschätzt')} value={fmtInt(luxR(luxOf(plan, est)))} unit="lx" note={`≈ ${klx(luxOf(plan, est))} klx`} />
          <Cell label="DLI" value={num(dli(est, e.h), 0)} unit="mol/m²·d" note={t('bei {h} h', { h: e.h })} />
          <Cell label={t('Leistung')} value={Math.round((l.watt * plan.dim) / 100)} unit="W" note={t('ca. am Netz')} />
          <Cell label={t('Verbrauch')} value={num(kwhDay, 2)} unit={t('kWh/Tag')} note={t('{kwh} kWh im Monat', { kwh: num(kwhDay * 30, 1) })} />
          <Cell label={t('Stromkosten')} value={num(kwhDay * 30 * l.price, 2)} unit={t('€/Monat')} note={t('bei {price} €/kWh', { price: num(l.price, 2) })} />
        </div>
        <div className="gp-tip">
          {t('Geschätzt aus {ppf} µmol/s PPF, {util} % Nutzung im Zelt und deiner Fläche, Lux mit {factor} lx pro µmol/m²s umgerechnet. Ein PAR-Messgerät ist genauer – nutze die Zahlen als Startpunkt.', { ppf: fmtInt(l.ppf), util: num(l.util, 0), factor: num(l.luxF, 1) })}
        </div>
        {dimmable.length ? (
          <div className="gp-pad gp-foot stack">
            <span className="small muted">{t('Dimmbares Licht im Zelt')}</span>
            {dimmable.map((x) => {
              const pct = percentOfLevel(x.control)
              const key = `${x.device.id}|${x.control.id}`
              // a light running its own program (schedule, PPFD automatic) is dimmed there, not here
              const lock = sliderLock(x.device, x.control, roomControl)
              return (
                <div className="spread" key={key}>
                  <span className="small">
                    <b>{t(x.control.label)}</b> · {x.device.name} ({VENDORS[x.device.vendor]}) ·{' '}
                    {x.control.on === false ? t('aus') : pct != null ? t('jetzt {pct} %', { pct }) : t('an')}
                    {lock ? <span className="muted"> · {lock.text}</span> : null}
                  </span>
                  <button type="button" className="btn small" disabled={!x.device.online || busy === key || pct === plan.dim || !!lock} onClick={() => apply(x)}>
                    {pct === plan.dim ? t('steht auf {pct} %', { pct: plan.dim }) : lock ? t('gesperrt') : t('Auf {pct} % stellen', { pct: plan.dim })}
                  </button>
                </div>
              )
            })}
          </div>
        ) : null}
      </div>
    </Block>
  )
}

// Light window of the tent (GrowDeck uses it for day and night) against the hours of the plan.
function LightTimes({ g, e }) {
  const { tent } = g
  const [busy, setBusy] = useState(false)
  if (!tent.tentRoom) return null
  const room = tent.tentRoom
  const hours = lightHours(room.day_start, room.day_end)
  const matches = Math.abs(hours - e.h) < 0.5
  const end = minutesToHhmm(hhmmToMinutes(room.day_start) + e.h * 60)
  const apply = async () => {
    setBusy(true)
    try {
      if (tent.room) {
        const r = tent.room
        await api(`/rooms/${r.id}`, {
          method: 'PUT',
          body: { name: r.name, sort: r.sort, climate_device_id: r.climate_device_id, climate_group: r.climate_group, day_start: r.day_start, day_end: end, stage: r.stage },
        })
      } else {
        await api('/settings', { method: 'PUT', body: { day_start: room.day_start, day_end: end } })
        await loadState()
      }
      toast(t('Lichtzeiten auf {start}–{end} gesetzt.', { start: room.day_start, end }))
    } catch {
      /* toast shown */
    } finally {
      setBusy(false)
    }
  }
  return (
    <Block title={t('Lichtzeiten im Zelt')}>
      <div className="panel gp-pad stack">
        <p className="small" style={{ margin: 0 }}>
          {t('Laut Plan {day}/{night} h Licht.', { day: e.h, night: 24 - e.h })}{' '}
          {matches
            ? t('{name} rechnet mit {start}–{end} ({hours} h Licht) – das passt.', { name: tent.room ? tent.room.name : 'GrowDeck', start: room.day_start, end: room.day_end, hours: num(hours) })
            : t('{name} rechnet mit {start}–{end} ({hours} h Licht).', { name: tent.room ? tent.room.name : 'GrowDeck', start: room.day_start, end: room.day_end, hours: num(hours) })}{' '}
          {t('Tag und Nacht bestimmen die Verläufe in der Übersicht und die Zeltsteuerung.')}
        </p>
        {!matches && e.h > 0 ? (
          <div className="row">
            <button type="button" className="btn small" disabled={busy} onClick={apply}>{t('Auf {start}–{end} setzen', { start: room.day_start, end })}</button>
            <span className="small muted">{t('Die Schaltzeiten der Lampe selbst stellst du am Gerät oder in der Hersteller-App ein.')}</span>
          </div>
        ) : null}
      </div>
    </Block>
  )
}

export default function Light({ g }) {
  const { plan, pos } = g
  const k = stageKey(pos.phase, pos.week, plan.floWeeks)
  const e = envOf(plan, k)
  const p = Math.round(mid(e.ppfd))
  const d = dimForPPFD(plan, p)
  const side = Math.round(Math.sqrt(plan.tent) * 100)
  const nm = t(ENV[k].n).toLowerCase()
  const live = liveCells(g, e)
  const l = plan.lamp
  const kwhDay = (l.watt * plan.dim) / 100 * e.h / 1000
  const isDefault = l.name === LAMP_DEFAULT.name
  return (
    <div className="gp-cols">
      <div className="gp-col">
        <Block title={t('{lamp} diese Woche', { lamp: shortLamp(plan) })} hint={`${plan.tent === 1.2 ? '100 × 120' : `${side} × ${side}`} cm`}>
          <div className="gp-grid">
            <Cell label={t('Dimmer')} value={d} unit="%" note={t('für ca. {ppfd} µmol/m²s', { ppfd: p })} live={live.dim} />
            <Cell label={t('Abstand')} value={rng(e.hoehe)} unit="cm" note={t('Unterkante bis Blatt')} />
            <Cell label={t('Ziel-PPFD')} value={rng(e.ppfd)} unit="µmol/m²s" note={t('am Blatt')} live={live.ppfd} />
            <Cell label={t('Ziel in Lux')} value={klxRange(plan, e.ppfd)} unit="klx" note={`≈ ${luxRange(plan, e.ppfd)} lx`} />
            <Cell label={t('Beleuchtung')} value={`${e.h}/${24 - e.h}`} unit="h" note={t('Licht / Dunkel')} live={live.light} />
            <Cell label="DLI" value={num(dli(p, e.h), 0)} unit="mol/m²·d" note={t('bei {h} h Licht', { h: e.h })} />
          </div>
        </Block>
        <Dimmer g={g} e={e} recommended={d} />
        <LightTimes g={g} e={e} />
      </div>
      <div className="gp-col">
        <LuxCheck g={g} e={e} nm={nm} />
        <Block title={t('Höhe & Leistung je Phase')}>
          <div className="panel">
            <div className="table-wrap gp-scroll">
              <table className="gp-table">
                <thead><tr><th className="gp-p">{t('Phase')}</th><th>{t('Höhe cm')}</th><th>{t('Dimmer %')}</th><th>PPFD</th><th>Lux (klx)</th><th>{t('Licht h')}</th><th>DLI</th></tr></thead>
                <tbody>
                  {ENV_KEYS.map((key) => {
                    const x = envOf(plan, key)
                    const pm = Math.round(mid(x.ppfd))
                    return (
                      <tr key={key} className={key === k ? 'cur' : ''}>
                        <td className="gp-p">{t(ENV[key].n)}{envAdj(plan, key) ? ' •' : ''}</td>
                        <td>{rng(x.hoehe)}</td><td>{dimForPPFD(plan, pm)}</td><td>{rng(x.ppfd)}</td>
                        <td>{klxRange(plan, x.ppfd)}</td><td>{x.h}/{24 - x.h}</td><td>{num(dli(pm, x.h), 0)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="gp-tip">
              {t('Abstand von der Lampenunterkante bis zur obersten Blattspitze messen. Lieber zu hoch starten und in 2–3-cm-Schritten senken. • = von dir angepasst.')}
            </div>
            <div className="gp-pad gp-foot row">
              <button type="button" className="btn small" onClick={() => g.open({ kind: 'env' })}>{t('Lichtwerte anpassen')}</button>
              <button type="button" className="btn small" onClick={() => g.open({ kind: 'lamp' })}>{t('Lampe & Umrechnung')}</button>
            </div>
          </div>
        </Block>
        <Block title={t('Datenblatt {lamp}', { lamp: isDefault ? 'Spider Farmer G3000' : l.name })}>
          <div className="panel gp-rows">
            {isDefault ? (
              <>
                <div className="gp-row"><div className="gp-nm"><b>{t('Leistung')}</b><span>{t('Herstellerangabe')}</span></div><div className="gp-dose num">300 W<small>±5 %</small></div></div>
                <div className="gp-row"><div className="gp-nm"><b>PPF</b><span>{t('Photonenstrom gesamt')}</span></div><div className="gp-dose num">852<small>µmol/s</small></div></div>
                <div className="gp-row"><div className="gp-nm"><b>{t('Effizienz')}</b><span>PPE</span></div><div className="gp-dose num">{num(2.8, 1)}<small>µmol/J</small></div></div>
                <div className="gp-row"><div className="gp-nm"><b>{t('Fläche')}</b><span>{t('Kern / maximal')}</span></div><div className="gp-dose num">60 / 90<small>{t('cm Kantenlänge')}</small></div></div>
                <div className="gp-row"><div className="gp-nm"><b>{t('Spektrum')}</b><span>{t('Vollspektrum mit Tiefrot')}</span></div><div className="gp-dose num">660<small>{t('nm Anteil')}</small></div></div>
                <div className="gp-row"><div className="gp-nm"><b>{t('Dimmung')}</b><span>{t('Regler, 0–10 V oder Spider-Farmer-App')}</span></div><div className="gp-dose num">10–100<small>%</small></div></div>
              </>
            ) : (
              <>
                <div className="gp-row"><div className="gp-nm"><b>{t('Leistung')}</b><span>{t('deine Angabe')}</span></div><div className="gp-dose num">{fmt(l.watt, 0)} W</div></div>
                <div className="gp-row"><div className="gp-nm"><b>PPF</b><span>{t('Photonenstrom gesamt')}</span></div><div className="gp-dose num">{fmtInt(l.ppf)}<small>µmol/s</small></div></div>
                <div className="gp-row"><div className="gp-nm"><b>{t('Effizienz')}</b><span>{t('PPF je Watt')}</span></div><div className="gp-dose num">{num(l.ppf / l.watt, 1)}<small>µmol/J</small></div></div>
                <div className="gp-row"><div className="gp-nm"><b>{t('Nutzung im Zelt')}</b><span>{t('Anteil, der auf der Fläche ankommt')}</span></div><div className="gp-dose num">{num(l.util, 0)}<small>%</small></div></div>
                <div className="gp-row"><div className="gp-nm"><b>{t('Umrechnung')}</b><span>{t('Lux je µmol/m²s')}</span></div><div className="gp-dose num">{num(l.luxF, 1)}</div></div>
              </>
            )}
            <div className="gp-tip">
              {t('{title} bei {dim} % und {h} h Licht rund {kwh} kWh pro Monat – bei {price} €/kWh etwa {cost} € monatlich.', {
                title: <b>{t('Stromkosten:')}</b>, dim: plan.dim, h: e.h, kwh: num(kwhDay * 30, 1), price: num(l.price, 2), cost: num(kwhDay * 30 * l.price, 2),
              })}
            </div>
          </div>
        </Block>
      </div>
    </div>
  )
}

// Tab "Klima": VPD calculator, targets per phase and the link to the room control.
import { useState } from 'react'
import { api, toast } from '../store.js'
import { href } from '../router.js'
import { fmt } from '../format.js'
import { ENV, ENV_KEYS } from './data.js'
import { controlTargets, envAdj, envOf, f2, num, rng, rngV, roundTo, stageKey, vpdOf } from './engine.js'
import { Block, DecimalInput } from './parts.jsx'
import { PlanAlarmBlock } from './extras.jsx'
import { dec, t } from '../i18n.js'

function VpdCalculator({ g }) {
  const { plan, pos, update, tent } = g
  const k = stageKey(pos.phase, pos.week, plan.floWeeks)
  const e = envOf(plan, k)
  const v = vpdOf(plan.tAir, plan.rh, plan.leafOff)
  const [lo, hi] = e.vpd
  const nm = t(ENV[k].n).toLowerCase()
  const range = rngV(e.vpd, 'kPa')
  let cls
  let txt
  if (v < lo - 0.15) {
    cls = 'bad'
    txt = t('Zu niedrig für {stage} ({range}). Die Pflanze verdunstet zu wenig – Feuchte senken oder Temperatur anheben.', { stage: nm, range })
  } else if (v < lo) {
    cls = 'warn'
    txt = t('Knapp unter dem Zielband {range} – etwas trockener wäre besser.', { range })
  } else if (v <= hi) {
    cls = 'good'
    txt = t('Im Zielband für {stage} ({range}). Passt.', { stage: nm, range })
  } else if (v <= hi + 0.2) {
    cls = 'warn'
    txt = t('Leicht über dem Zielband {range} – Feuchte etwas anheben.', { range })
  } else {
    cls = 'bad'
    txt = t('Zu hoch für {stage} ({range}). Die Pflanze schließt die Spaltöffnungen – befeuchten oder kühler fahren.', { stage: nm, range })
  }
  const pct = (x) => Math.max(0, Math.min(100, ((x - 0.2) / 1.8) * 100))
  const live = tent.live
  const canTake = live.temp != null && live.humi != null
  return (
    <Block title={t('VPD-Rechner')} hint={t('Blatt zu Luft')}>
      <div className="panel">
        <div className="gp-pad gp-form3">
          <label className="field"><span>{t('Temperatur °C')}</span>
            <DecimalInput value={plan.tAir} valid={(x) => x > -10 && x < 50} onValue={(tAir) => update({ tAir })} /></label>
          <label className="field"><span>{t('rel. Feuchte %')}</span>
            <DecimalInput value={plan.rh} valid={(x) => x >= 5 && x <= 100} onValue={(rh) => update({ rh })} /></label>
          <label className="field"><span>{t('Blatt kühler (K)')}</span>
            <DecimalInput value={plan.leafOff} valid={(x) => x >= 0 && x <= 8} onValue={(leafOff) => update({ leafOff })} /></label>
        </div>
        {canTake ? (
          <div className="gp-pad gp-take">
            <button type="button" className="btn small" onClick={() => {
              update({ tAir: roundTo(live.temp, 1), rh: Math.round(live.humi) })
              toast(live.day ? t('Werte aus dem Zelt übernommen') : t('Werte übernommen – nachts ist das Blatt etwa so warm wie die Luft, dann 0 K eintragen.'))
            }}>{t('Werte aus dem Zelt übernehmen ({temp} °C, {humi} %)', { temp: fmt(live.temp, 1), humi: fmt(live.humi, 0) })}</button>
          </div>
        ) : null}
        <div className="gp-verdict">
          <div className={`gp-big num ${cls}`}>{f2(v)}</div>
          <div className="small muted">{txt}</div>
        </div>
        <div className="gp-pad" style={{ paddingTop: 0 }}>
          <div className="gp-bar" role="img" aria-label={t('VPD {value} kPa, Zielband {range}', { value: f2(v), range })}>
            <i style={{ left: `${pct(lo)}%`, width: `${pct(hi) - pct(lo)}%` }} />
            <b style={{ left: `${pct(v)}%` }} />
          </div>
          <div className="gp-scale"><span>{dec('0.4')}</span><span>{dec('0.8')}</span><span>{dec('1.2')}</span><span>{dec('1.6')}</span><span>{dec('2.0')} kPa</span></div>
        </div>
        <div className="gp-tip">
          {t('Unter LED liegt die Blatttemperatur meist 1–3 K unter der Lufttemperatur, nachts etwa gleichauf (dann 0 eintragen). Mit dem Wert für „Blatt kühler“ rechnet GrowDeck auch die Messwerte der Geräte und die Ziele der Zeltsteuerung um.')}
        </div>
      </div>
    </Block>
  )
}

function EnvTable({ g }) {
  const { plan, pos } = g
  const cur = stageKey(pos.phase, pos.week, plan.floWeeks)
  return (
    <Block title={t('Zielwerte je Phase')} hint={t('Tag / Nacht')}>
      <div className="panel">
        <div className="table-wrap gp-scroll">
          <table className="gp-table">
            <thead><tr><th className="gp-p">{t('Phase')}</th><th>{t('Tag °C')}</th><th>{t('Nacht °C')}</th><th>{t('rF %')}</th><th>VPD kPa</th><th>PPFD</th></tr></thead>
            <tbody>
              {ENV_KEYS.map((k) => {
                const x = envOf(plan, k)
                const c = k === cur ? 'cur' : ''
                return (
                  <tr key={k} className={c}>
                    <td className="gp-p">{t(ENV[k].n)}{envAdj(plan, k) ? ' •' : ''}</td>
                    <td>{rng(x.tag)}</td><td>{rng(x.nacht)}</td><td>{rng(x.rh)}</td><td>{rngV(x.vpd)}</td><td>{rng(x.ppfd)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="gp-tip">{t('• = von dir angepasst. Temperatur, Feuchte, VPD, PPFD, Lichtstunden und Lampenabstand lassen sich für jede Phase ändern.')}</div>
        <div className="gp-pad gp-foot">
          <button type="button" className="btn primary gp-wide" onClick={() => g.open({ kind: 'env' })}>{t('Zielwerte anpassen')}</button>
        </div>
      </div>
    </Block>
  )
}

// Link to the room control: take temperature, humidity and VPD from the plan.
function RoomControlLink({ g }) {
  const { plan, today, tent } = g
  const [busy, setBusy] = useState(false)
  const ct = controlTargets(plan, today)
  const status = tent.control
  const follows = !!status?.plan_source
  const setFollow = async (value) => {
    setBusy(true)
    try {
      const r = await api(`/rooms/${tent.room.id}/control`)
      await api(`/rooms/${tent.room.id}/control`, { method: 'PUT', body: { ...r.config, plan_targets: value } })
      toast(value ? t('Die Zeltsteuerung übernimmt jetzt die Ziele aus dem Growplan.') : t('Die Zeltsteuerung nutzt wieder ihre eigenen Zielwerte.'))
    } catch {
      /* toast shown */
    } finally {
      setBusy(false)
    }
  }
  let body
  if (tent.room && status) {
    body = (
      <>
        <p className="small" style={{ margin: 0 }}>
          {follows
            ? (status.enabled
              ? t('Die Zeltsteuerung von {room} folgt diesem Plan und wechselt die Ziele automatisch mit der Woche.', { room: tent.room.name })
              : t('Die Zeltsteuerung von {room} folgt diesem Plan (sie ist gerade ausgeschaltet) und wechselt die Ziele automatisch mit der Woche.', { room: tent.room.name }))
            : t('Die Zeltsteuerung von {room} nutzt ihre eigenen Zielwerte. Sie kann stattdessen die Werte dieses Plans übernehmen und wechselt sie dann automatisch mit der Woche.', { room: tent.room.name })}
        </p>
        <div className="row">
          {follows
            ? <button type="button" className="btn small" disabled={busy} onClick={() => setFollow(false)}>{t('Eigene Zielwerte nutzen')}</button>
            : <button type="button" className="btn primary small" disabled={busy} onClick={() => setFollow(true)}>{t('Ziele aus dem Growplan übernehmen')}</button>}
        </div>
      </>
    )
  } else if (tent.room) {
    body = (
      <p className="small" style={{ margin: 0 }}>
        {t('Für {room} ist noch keine Zeltsteuerung eingerichtet. Richte sie in der {overview} ein, dann kann sie Temperatur, Luftfeuchte und VPD aus diesem Plan übernehmen.', {
          room: tent.room.name, overview: <a href={href('overview')}>{t('Übersicht')}</a>,
        })}
      </p>
    )
  } else if (tent.implicit) {
    body = (
      <p className="small" style={{ margin: 0 }}>
        {t('Lege unter {options} einen Raum an und ordne ihm diesen Plan zu, dann kann die Zeltsteuerung die Ziele aus dem Plan übernehmen.', {
          options: <a href={href('options')}>{t('Optionen')}</a>,
        })}
      </p>
    )
  } else {
    body = <p className="small" style={{ margin: 0 }}>{t('Ordne den Plan im Heute-Tab einem Zelt zu, dann kann dessen Zeltsteuerung die Ziele aus dem Plan übernehmen.')}</p>
  }
  return (
    <Block title={t('Zeltsteuerung')} hint={t('diese Woche: {stage}', { stage: t(ct.stage_name) })}>
      <div className="panel gp-pad stack">
        <div className="table-wrap">
          <table className="gp-table gp-mini">
            <thead><tr><th className="gp-p">{t('Ziel')}</th><th>{t('Tag')}</th><th>{t('Nacht')}</th><th>{t('Toleranz')}</th></tr></thead>
            <tbody>
              <tr><td className="gp-p">{t('Temperatur')}</td><td>{fmt(ct.temp.day, 1)} °C</td><td>{fmt(ct.temp.night, 1)} °C</td><td>± {fmt(ct.temp.tolerance, 1)} °C</td></tr>
              <tr><td className="gp-p">{t('Luftfeuchte')}</td><td>{fmt(ct.humi.day, 0)} %</td><td>{fmt(ct.humi.night, 0)} %</td><td>± {fmt(ct.humi.tolerance, 0)} %</td></tr>
              <tr><td className="gp-p">{t('VPD der Luft')}</td><td>{fmt(ct.vpd.day, 2)} kPa</td><td>{fmt(ct.vpd.night, 2)} kPa</td><td>± {fmt(ct.vpd.tolerance, 2)} kPa</td></tr>
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          {t('Jeweils die Mitte der Zielbereiche, die Toleranz reicht bis zum Rand. Die Geräte messen den VPD der Luft: Das Blatt-Ziel {leaf} entspricht bei {offset} K kühlerem Blatt (VPD-Rechner) tagsüber {day} kPa Luft-VPD. Nachts ist das Blatt etwa so warm wie die Luft; den Nachtwert rechnet GrowDeck aus Nachttemperatur und Luftfeuchte. Ob nach Luftfeuchte oder VPD geregelt wird, stellst du in der Zeltsteuerung ein.', {
            leaf: rngV(ct.leaf_vpd, 'kPa'), offset: num(ct.leaf_offset), day: fmt(ct.vpd.day, 2),
          })}
        </p>
        {body}
      </div>
    </Block>
  )
}

const TROUBLE = [
  [t('Zu feucht:'), t('Abluft erhöhen, dichten Bestand auslichten, Untersetzer trocken halten, nicht kurz vor Lichtaus gießen. In der späten Blüte ist Feuchte über ~60 % das größte Schimmelrisiko.')],
  [t('Zu trocken:'), t('Abluft drosseln, Luftbefeuchter oder offene Wasserschale, größere Töpfe.')],
  [t('Zu warm:'), t('Lampe dimmen oder höher hängen, Lichtphase in die Nacht legen, Abluft erhöhen.')],
  [t('Zu kühl nachts:'), t('Tag/Nacht-Unterschied möglichst unter 8–10 K halten.')],
  [t('Immer:'), t('Umluft für leichte Blattbewegung, aber nicht direkt auf die Blüten.')],
]

export default function ClimateTab({ g }) {
  return (
    <div className="gp-cols">
      <div className="gp-col">
        <VpdCalculator g={g} />
        <PlanAlarmBlock g={g} />
        <RoomControlLink g={g} />
      </div>
      <div className="gp-col">
        <EnvTable g={g} />
        <Block title={t('Wenn es klemmt')}>
          <div className="panel">
            <ul className="gp-tips">{TROUBLE.map(([b, tip]) => <li key={b}><b>{b}</b> {tip}</li>)}</ul>
          </div>
        </Block>
      </div>
    </div>
  )
}

export { num }

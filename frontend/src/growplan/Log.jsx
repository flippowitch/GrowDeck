// Tab "Protokoll": watering log with statistics, EC/pH charts, export and backups.
import { useRef, useState } from 'react'
import { toast } from '../store.js'
import { fmt } from '../format.js'
import { Modal } from '../components/ui.jsx'
import { TYPE_LBL } from './data.js'
import {
  activePlants, agoText, currentSched, daysBetween, extraText, f1, f2, fmtDate, isWatering, num, phaseLabel, phTarget,
  plantById, plantsLabel, sortedLog, toText,
} from './engine.js'
import { Block, Cell, MeasureChart } from './parts.jsx'
import { WateringSettings } from './extras.jsx'
import { photoUrl } from '../cameras.js'
import { lang, t } from '../i18n.js'

const FILTER_KEY = 'growdeck.growplan.filter.'
function loadFilter(planId) {
  try {
    return localStorage.getItem(FILTER_KEY + planId) || ''
  } catch {
    return ''
  }
}
function saveFilter(planId, value) {
  try {
    localStorage.setItem(FILTER_KEY + planId, value)
  } catch {
    /* private mode */
  }
}

const TONE = { feed: 'leaf', water: 'frost', flush: 'amber', note: '' }

function Stats({ list, today }) {
  const water = list.filter(isWatering)
  const last = water[0]
  const dates = []
  water.forEach((e) => {
    if (!dates.includes(e.date)) dates.push(e.date)
  })
  const gaps = []
  for (let i = 0; i < Math.min(dates.length - 1, 10); i++) gaps.push(daysBetween(dates[i + 1], dates[i]))
  const avg = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null
  const week = water.filter((e) => {
    const d = daysBetween(e.date, today)
    return d >= 0 && d < 7
  })
  const liters = week.reduce((a, e) => a + (e.liters || 0), 0)
  const m = list.find((e) => e.phIn != null || e.ecIn != null)
  return (
    <div className="gp-grid">
      <Cell label={t('Letzte Gießung')} value={last ? agoText(last.date, today) : '–'} note={last ? `${fmtDate(last.date)} · ${TYPE_LBL[last.type]}` : t('noch kein Eintrag')} />
      <Cell label={t('Ø Abstand')} value={avg ? num(avg, 1) : '–'} unit={avg ? t('Tage') : ''} note={t('aus den letzten Gießtagen')} />
      <Cell label={t('Letzte 7 Tage')} value={week.length} unit={week.length === 1 ? t('Gießung') : t('Gießungen')} note={t('{liters} L gesamt', { liters: num(liters, 1) })} />
      <Cell label={t('Letzte Messung')} value={m ? (m.phIn != null ? `pH ${f1(m.phIn)}` : `EC ${f2(m.ecIn)}`) : '–'}
        note={m ? `${m.ecIn != null && m.phIn != null ? `EC ${f2(m.ecIn)} · ` : ''}${fmtDate(m.date)}` : t('EC/pH beim Eintragen erfassen')} />
    </div>
  )
}

function Charts({ list, range }) {
  const pts = list.filter((e) => e.ecIn != null || e.ecOut != null || e.phIn != null || e.phOut != null).slice(0, 20).reverse()
  if (pts.length < 2) return null
  const labels = pts.map((e) => fmtDate(e.date, { day: '2-digit', month: '2-digit' }))
  const ecIn = pts.map((e) => e.ecIn)
  const ecOut = pts.map((e) => e.ecOut)
  const phIn = pts.map((e) => e.phIn)
  const phOut = pts.map((e) => e.phOut)
  const ecAll = ecIn.concat(ecOut).filter((v) => v != null)
  const phAll = phIn.concat(phOut).filter((v) => v != null)
  const water = 'var(--chart-humi)'
  const drain = 'var(--chart-temp)'
  return (
    <Block title={t('EC & pH Verlauf')} hint={t('letzte 20 Messungen')}>
      <div className="panel gp-pad">
        <div className="gp-legend">
          <span><i style={{ background: water }} />{t('Gießwasser')}</span>
          <span><i style={{ background: drain }} />{t('Drain')}</span>
          <span><i className="band" />{t('pH-Zielband {range}', { range: `${f1(range[0])}–${f1(range[1])}` })}</span>
        </div>
        <div className="gp-charts">
          {ecAll.length ? (
            <MeasureChart title="EC in mS/cm" labels={labels} digits={2} unit="mS/cm" yMin={0}
              yMax={Math.max(1, Math.ceil((Math.max(...ecAll) + 0.2) * 2) / 2)}
              series={[{ key: 'in', label: t('Gießwasser'), color: water, vals: ecIn }, { key: 'out', label: t('Drain'), color: drain, vals: ecOut }]} />
          ) : <p className="muted small">{t('Noch keine EC-Werte erfasst.')}</p>}
          {phAll.length ? (
            <MeasureChart title="pH" labels={labels} digits={1} band={range}
              yMin={Math.floor(Math.min(range[0] - 0.4, Math.min(...phAll) - 0.2) * 2) / 2}
              yMax={Math.ceil(Math.max(range[1] + 0.4, Math.max(...phAll) + 0.2) * 2) / 2}
              series={[{ key: 'in', label: t('Gießwasser'), color: water, vals: phIn }, { key: 'out', label: t('Drain'), color: drain, vals: phOut }]} />
          ) : <p className="muted small">{t('Noch keine pH-Werte erfasst.')}</p>}
        </div>
        <details className="gp-details">
          <summary>{t('Als Tabelle')}</summary>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>{t('Datum')}</th><th>{t('EC Gießwasser')}</th><th>{t('EC Drain')}</th><th>{t('pH Gießwasser')}</th><th>{t('pH Drain')}</th></tr></thead>
              <tbody>
                {pts.map((e) => (
                  <tr key={e.id}>
                    <td>{fmtDate(e.date)}</td>
                    <td className="num">{e.ecIn != null ? fmt(e.ecIn, 2) : '–'}</td>
                    <td className="num">{e.ecOut != null ? fmt(e.ecOut, 2) : '–'}</td>
                    <td className="num">{e.phIn != null ? fmt(e.phIn, 1) : '–'}</td>
                    <td className="num">{e.phOut != null ? fmt(e.phOut, 1) : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>
    </Block>
  )
}

function Entry({ e, plan, onOpen }) {
  const meas = []
  const drain = []
  if (e.ecIn != null) meas.push(<span key="ei">EC <b>{f2(e.ecIn)}</b></span>)
  if (e.phIn != null) meas.push(<span key="pi">pH <b>{f1(e.phIn)}</b></span>)
  if (e.ecOut != null) drain.push(<span key="eo">EC <b>{f2(e.ecOut)}</b></span>)
  if (e.phOut != null) drain.push(<span key="po">pH <b>{f1(e.phOut)}</b></span>)
  const join = (items) => items.flatMap((x, i) => (i ? [' · ', x] : [x]))
  return (
    <button type="button" className="gp-entry" onClick={onOpen}>
      <div className="gp-l1">
        <span className="gp-d">{fmtDate(e.date)}</span>
        <span className={`chip ${TONE[e.type] || ''}`}>{TYPE_LBL[e.type] || ''}</span>
        <span className="chip">{phaseLabel(e.phase, e.week)}</span>
      </div>
      <div className="gp-l2">
        {isWatering(e) && e.liters ? <><b>{num(e.liters, 2)} L</b> · </> : null}
        {plantsLabel(plan, e)}
        {(e.type === 'feed' || e.type === 'flush') && e.strength !== 100 ? ` · ${e.strength} %` : ''}
      </div>
      {meas.length || drain.length ? (
        <div className="gp-l2">{join(meas)}{drain.length ? <>{meas.length ? ' → ' : ''}{t('Drain')} {join(drain)}</> : null}</div>
      ) : null}
      {e.extra?.length ? <div className="gp-l2">+ {extraText(e)}</div> : null}
      {e.tags?.length ? <div className="gp-l2 gp-tags">{e.tags.map((tag) => <span className="chip frost" key={tag}>{t(tag)}</span>)}</div> : null}
      {e.note ? <div className="gp-l2">{e.note}</div> : null}
      {e.photo ? <img className="gp-entry-photo" src={photoUrl(e.photo, true)} alt="" loading="lazy" /> : null}
    </button>
  )
}

// The log as text to copy by hand, where the device has no share menu.
function ShareText({ text, onClose }) {
  const area = useRef(null)
  return (
    <Modal title={t('Protokoll als Text')} onClose={onClose}
      actions={<>
        <button type="button" className="btn" onClick={() => {
          area.current?.focus()
          area.current?.select()
        }}>{t('Alles markieren')}</button>
        <button type="button" className="btn primary" onClick={onClose}>{t('Fertig')}</button>
      </>}>
      <p className="small muted" style={{ marginTop: 0 }}>{t('Markieren, kopieren und in Messenger oder Notizen einfügen.')}</p>
      <textarea ref={area} className="input gp-textarea tall" readOnly value={text} aria-label={t('Protokoll als Text')} />
    </Modal>
  )
}

// Files come from GrowDeck itself (plain download links); open changes are saved first.
function FileLink({ g, href, children, empty }) {
  return (
    <a className="btn" href={href} onClick={async (e) => {
      if (empty) {
        e.preventDefault()
        toast(empty)
        return
      }
      if (window.GROWDECK_STATIC_DEMO) {
        e.preventDefault()
        toast(t('In der Demo gibt es keine Dateien zum Herunterladen.'))
        return
      }
      if (g.hasPending()) {
        e.preventDefault()
        await g.flush()
        window.location.assign(href)
      }
    }}>{children}</a>
  )
}

export default function Log({ g }) {
  const { plan, lib, log, today, planId } = g
  const [filter, setFilter] = useState(() => loadFilter(planId))
  const valid = plantById(plan, filter)
  const fid = valid && !valid.gone ? filter : ''
  const list = sortedLog(log).filter((e) => !fid || !e.plants?.length || e.plants.includes(fid))
  const range = phTarget(currentSched(lib, plan), plan.medium)
  const [shareText, setShareText] = useState(null)
  const base = `/api/growplan/plans/${encodeURIComponent(planId)}`
  const share = () => {
    if (!log.length) return toast(t('Noch keine Einträge'))
    const text = toText(plan, log, t('Growplan – Gießprotokoll {title}', { title: g.title }))
    if (navigator.share) {
      navigator.share({ title: t('Gießprotokoll'), text }).catch(() => {})
      return
    }
    setShareText(text)
  }
  return (
    <div className="gp-cols">
      <div className="gp-col">
        <Block title={t('Gießprotokoll')} hint={list.length ? (list.length === 1 ? t('{n} Eintrag', { n: list.length }) : t('{n} Einträge', { n: list.length })) : ''}>
          <select className="input gp-filter" aria-label={t('Nach Pflanze filtern')} value={fid} onChange={(e) => {
            setFilter(e.target.value)
            saveFilter(planId, e.target.value)
          }}>
            <option value="">{t('Alle Pflanzen')}</option>
            {activePlants(plan).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <Stats list={list} today={today} />
          <button type="button" className="btn primary gp-wide gp-gap" onClick={() => g.newEntry(fid)}>{t('+ Gießung eintragen')}</button>
        </Block>
        <Charts list={list} range={range} />
        <WateringSettings g={g} />
        <Block title={t('Sichern & teilen')}>
          <div className="panel gp-pad stack">
            <div className="gp-btns">
              <FileLink g={g} href={`${base}/csv?lang=${lang}`} empty={log.length ? '' : t('Noch keine Einträge')}>{t('CSV exportieren')}</FileLink>
              <button type="button" className="btn" onClick={share}>{t('Als Text teilen')}</button>
              <FileLink g={g} href={`${base}/export?download=1`}>{t('Backup speichern')}</FileLink>
              <button type="button" className="btn" onClick={() => g.open({ kind: 'restore' })}>{t('Backup laden')}</button>
            </div>
            <p className="small muted" style={{ margin: 0 }}>
              {t('Das Protokoll liegt in GrowDeck und wird mit dem Datenordner gesichert. Das Backup hat das Format der Growplan-App: Du kannst es dort laden und Backups der App hier einlesen.')}
            </p>
            <button type="button" className="btn danger gp-wide" onClick={() => {
              if (!log.length) return toast(t('Das Protokoll ist schon leer'))
              g.open({
                kind: 'confirm', title: t('Protokoll leeren?'), okLabel: t('Alles löschen'),
                text: t('Alle {n} Einträge werden gelöscht. Mach vorher ein Backup, wenn du sie behalten willst.', { n: log.length }),
                onOk: async () => {
                  await g.clearLog()
                  toast(t('Protokoll geleert'))
                },
              })
            }}>{t('Protokoll leeren')}</button>
          </div>
        </Block>
      </div>
      <div className="gp-col">
        <Block title={t('Einträge')}>
          {list.length ? (
            <div className="gp-entries">
              {list.map((e) => <Entry key={e.id} e={e} plan={plan} onOpen={() => g.editEntry(e)} />)}
            </div>
          ) : (
            <div className="panel gp-pad muted">
              {fid ? t('Für diese Pflanze gibt es noch keine Einträge.')
                : t('Noch keine Einträge. Am schnellsten geht es über „Kanne mischen“ auf dem Heute-Tab – die Düngermengen werden automatisch übernommen.')}
            </div>
          )}
        </Block>
        {shareText != null ? <ShareText text={shareText} onClose={() => setShareText(null)} /> : null}
      </div>
    </div>
  )
}

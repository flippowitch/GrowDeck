// Grow archive: finished grows with yield, key figures, climate per phase, photos and log;
// two or three grows side by side.
import { useEffect, useMemo, useState } from 'react'
import { api, toast, useStore } from '../store.js'
import { go, href } from '../router.js'
import { fmt, LOCALE } from '../format.js'
import Icon from '../components/Icon.jsx'
import { Empty, Field, Modal, Segmented } from '../components/ui.jsx'
import { photoUrl, usePhotos } from '../cameras.js'
import { TYPE_LBL } from '../growplan/data.js'
import { lang, t } from '../i18n.js'

function day(iso) {
  if (!iso) return '–'
  return new Date(`${iso}T12:00:00`).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' })
}
const pct = (v) => (v == null ? '–' : `${fmt(v * 100, 0)} %`)
const num = (v, d = 1, unit = '') => (v == null ? '–' : `${fmt(v, d)}${unit ? ` ${unit}` : ''}`)
// 'Gießungen' is also a unit in the log ("3 waterings"); as a row label it starts upper-case
const cap = (text) => text.charAt(0).toUpperCase() + text.slice(1)
const pair = (a, b, d, unit) => (a == null && b == null ? '–' : `${a == null ? '–' : fmt(a, d)} / ${b == null ? '–' : fmt(b, d)} ${unit}`)

function useGrows() {
  const tick = useStore((s) => s.growTick)
  const [grows, setGrows] = useState(null)
  useEffect(() => {
    let alive = true
    api('/grows', { quiet: true }).then((d) => alive && setGrows(d.grows)).catch(() => alive && setGrows([]))
    return () => {
      alive = false
    }
  }, [tick])
  return grows
}

// rows of the comparison and the key figures: label, value of a grow
const FIGURES = [
  [t('Zelt'), (g) => g.room_name || '–'],
  [t('Zeitraum'), (g) => `${day(g.started)} – ${day(g.harvested)}`],
  [t('Dauer'), (g) => num(g.stats.days, 0, t('Tage'))],
  [t('Wachstum / Blüte'), (g) => t('{veg} / {flower} Tage', { veg: num(g.stats.veg_days, 0), flower: num(g.stats.flower_days, 0) })],
  [t('Ertrag'), (g) => num(g.yield_g, 0, 'g')],
  [t('Gramm pro Watt'), (g) => num(g.stats.g_per_watt, 2, 'g/W')],
  [t('Gramm pro kWh'), (g) => num(g.stats.g_per_kwh, 2, 'g/kWh')],
  [t('Strom Lampe (geschätzt)'), (g) => (g.stats.kwh == null ? '–' : `${fmt(g.stats.kwh, 0)} kWh${g.stats.cost != null ? ` · ${fmt(g.stats.cost, 2)} €` : ''}`)],
  [t('Stromkosten pro Gramm'), (g) => num(g.stats.cost_per_g, 2, '€')],
  [cap(t('Gießungen')), (g) => t('{n} ({feeds} mit Dünger) · {liters}', { n: num(g.stats.waterings, 0), feeds: num(g.stats.feeds, 0), liters: num(g.stats.liters, 1, 'L') })],
  [t('EC / pH Gießwasser Ø'), (g) => `${num(g.stats.ec_in, 2)} / ${num(g.stats.ph_in, 1)}`],
  [t('EC / pH Drain Ø'), (g) => `${num(g.stats.ec_out, 2)} / ${num(g.stats.ph_out, 1)}`],
  [t('Bewertung'), (g) => (g.rating ? t('{n} von 5', { n: g.rating }) : '–')],
]
const CLIMATE = [
  [t('Temperatur Tag / Nacht'), (c) => pair(c.temp_day, c.temp_night, 1, '°C')],
  [t('Luftfeuchte Tag / Nacht'), (c) => pair(c.humi_day, c.humi_night, 0, '%')],
  [t('VPD Tag / Nacht'), (c) => pair(c.vpd_day, c.vpd_night, 2, 'kPa')],
  [t('Temperatur im Ziel'), (c) => pct(c.in_temp)],
  [t('Luftfeuchte im Ziel'), (c) => pct(c.in_humi)],
  [t('VPD im Ziel'), (c) => pct(c.in_vpd)],
  [t('Licht pro Tag'), (c) => num(c.light_hours, 1, 'h')],
  [t('Lichtmenge (DLI)'), (c) => num(c.dli, 1, 'mol/m²')],
  [t('Tage mit Messwerten'), (c) => num(c.days, 0)],
]
const PHASES = [['veg', t('Wachstum')], ['flower', t('Blüte')]]

function GrowCard({ grow, selected, onSelect }) {
  const flower = grow.stats.climate?.flower || {}
  return (
    <article className="panel grow-card">
      <a href={href(`archiv/${grow.id}`)} className="grow-link">
        {grow.stats.photo_last ? <img src={photoUrl(grow.stats.photo_last, true)} alt="" loading="lazy" />
          : <div className="grow-nophoto" aria-hidden="true"><Icon name="growplan" size={28} /></div>}
        <div className="grow-body">
          <h2>{grow.name}</h2>
          <p className="small muted">{[grow.strain, grow.room_name].filter(Boolean).join(' · ')}</p>
          <p className="small muted">{day(grow.started)} – {day(grow.harvested)} · {num(grow.stats.days, 0, t('Tage'))}</p>
          <div className="grow-figures">
            <span>{t('{value} Ertrag', { value: <b>{num(grow.yield_g, 0, 'g')}</b> })}</span>
            <span><b>{num(grow.stats.g_per_watt, 2)}</b> g/W</span>
            <span>{t('{value} VPD im Ziel (Blüte)', { value: <b>{pct(flower.in_vpd)}</b> })}</span>
          </div>
        </div>
      </a>
      <label className="check small grow-select">
        <input type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked)} /> {t('Vergleichen')}
      </label>
    </article>
  )
}

function Compare({ grows }) {
  return (
    <div className="panel">
      <div className="table-wrap">
        <table className="data compare">
          <thead>
            <tr><th scope="col">Grow</th>{grows.map((g) => <th scope="col" key={g.id}><a href={href(`archiv/${g.id}`)}>{g.name}</a></th>)}</tr>
          </thead>
          <tbody>
            <tr><th scope="row">{t('Sorte')}</th>{grows.map((g) => <td key={g.id}>{g.strain || '–'}</td>)}</tr>
            {FIGURES.map(([label, value]) => (
              <tr key={label}><th scope="row">{label}</th>{grows.map((g) => <td key={g.id} className="num">{value(g)}</td>)}</tr>
            ))}
            {PHASES.map(([phase, title]) => CLIMATE.slice(0, 8).map(([label, value]) => (
              <tr key={`${phase}-${label}`}>
                <th scope="row">{title}: {label}</th>
                {grows.map((g) => <td key={g.id} className="num">{g.stats.climate?.[phase] ? value(g.stats.climate[phase]) : '–'}</td>)}
              </tr>
            )))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function List({ query }) {
  const grows = useGrows()
  const wanted = (query?.get('vergleich') || '').split(',').filter(Boolean)
  const [selected, setSelected] = useState(wanted)
  if (grows == null) return <p className="muted">{t('Lade Archiv …')}</p>
  const comparing = wanted.length > 1 ? grows.filter((g) => wanted.includes(g.id)) : null
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('Grow-Archiv')}</h1>
          <p>{comparing ? t('{n} Grows im Vergleich.', { n: comparing.length }) : t('Abgeschlossene Grows mit Ertrag, Klima, Fotos und Gießprotokoll.')}</p>
        </div>
        <div className="row page-tools">
          {comparing ? <a className="btn ghost" href={href('archiv')}>{t('Alle Grows')}</a> : <a className="btn ghost" href={href('growplan')}>{t('Zum Growplan')}</a>}
          {!comparing && selected.length > 1 ? (
            <button type="button" className="btn primary" onClick={() => go(`archiv?vergleich=${selected.join(',')}`)}>
              {t('{n} Grows vergleichen', { n: selected.length })}
            </button>
          ) : null}
        </div>
      </div>
      {comparing ? <Compare grows={comparing} /> : !grows.length ? (
        <div className="panel">
          <Empty title={t('Noch kein Grow im Archiv')} action={<a className="btn" href={href('growplan')}>{t('Zum Growplan')}</a>}>
            {t('Nach der Ernte schließt du den Grow im Growplan unter „Plan & Zelt“ ab. GrowDeck hebt dann Ertrag, Klima, Fotos und das Gießprotokoll hier auf, und der Plan startet für den nächsten Durchgang neu.')}
          </Empty>
        </div>
      ) : (
        <>
          {grows.length > 1 && selected.length < 2 ? <p className="small muted">{t('Hake zwei oder drei Grows an, um sie nebeneinander zu sehen.')}</p> : null}
          <div className="grow-grid">
            {grows.map((g) => (
              <GrowCard key={g.id} grow={g} selected={selected.includes(g.id)}
                onSelect={(on) => setSelected((s) => (on ? [...s, g.id].slice(-3) : s.filter((x) => x !== g.id)))} />
            ))}
          </div>
        </>
      )}
    </>
  )
}

function ResultForm({ grow, onSaved }) {
  const [draft, setDraft] = useState({
    name: grow.name, strain: grow.strain || '', yield_g: grow.yield_g ?? '', rating: grow.rating || 0, notes: grow.notes || '',
    harvested: grow.harvested,
  })
  const [busy, setBusy] = useState(false)
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }))
  const save = async () => {
    setBusy(true)
    try {
      const body = { ...draft, yield_g: String(draft.yield_g).trim() === '' ? null : String(draft.yield_g).replace(',', '.') }
      const res = await api(`/grows/${encodeURIComponent(grow.id)}`, { method: 'PUT', body })
      toast(t('Gespeichert.'))
      onSaved(res.grow)
    } catch {
      /* toast shown */
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="panel panel-pad stack" aria-labelledby="result-head">
      <h2 className="sub" id="result-head" style={{ margin: 0 }}>{t('Ergebnis')}</h2>
      <div className="form-grid">
        <Field label={t('Name')}><input className="input" maxLength={80} value={draft.name} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label={t('Sorte(n)')}><input className="input" maxLength={120} value={draft.strain} onChange={(e) => set({ strain: e.target.value })} /></Field>
        <Field label={t('Ertrag getrocknet (g)')}>
          <input className="input" inputMode="decimal" value={draft.yield_g} placeholder={t('z. B. 380')} onChange={(e) => set({ yield_g: e.target.value })} />
        </Field>
        <Field label={t('Erntedatum')}><input className="input" type="date" value={draft.harvested} onChange={(e) => set({ harvested: e.target.value })} /></Field>
      </div>
      <div className="field">
        <span>{t('Bewertung')}</span>
        <Segmented label={t('Bewertung')} value={String(draft.rating || 0)} onChange={(v) => set({ rating: Number(v) })}
          options={[{ key: '0', label: t('Keine') }, ...[1, 2, 3, 4, 5].map((n) => ({ key: String(n), label: String(n) }))]} />
      </div>
      <Field label={t('Notizen')}>
        <textarea className="input gp-textarea" maxLength={4000} value={draft.notes} placeholder={t('Was lief gut, was machst du beim nächsten Mal anders?')}
          onChange={(e) => set({ notes: e.target.value })} />
      </Field>
      <div><button type="button" className="btn primary" disabled={busy} onClick={save}>{busy ? t('Speichere …') : t('Speichern')}</button></div>
    </section>
  )
}

function Detail({ id }) {
  const tick = useStore((s) => s.growTick)
  const [grow, setGrow] = useState(null)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState(false)
  useEffect(() => {
    let alive = true
    api(`/grows/${encodeURIComponent(id)}`, { quiet: true })
      .then((d) => alive && setGrow(d.grow))
      .catch((err) => alive && setError(err.message))
    return () => {
      alive = false
    }
  }, [id, tick])
  const range = useMemo(() => {
    if (!grow) return {}
    return {
      start: Math.floor(new Date(`${grow.started}T00:00:00`).getTime() / 1000),
      end: Math.floor(new Date(`${grow.harvested}T23:59:59`).getTime() / 1000),
    }
  }, [grow])
  const photos = usePhotos({ roomId: grow?.room_id, limit: 200, ...range })
  if (error) return <div className="notice alert">{t(error)}</div>
  if (!grow) return <p className="muted">{t('Lade Grow …')}</p>
  const s = grow.stats
  const shown = photos?.length > 8 ? Array.from({ length: 8 }, (_, i) => photos[Math.round((i * (photos.length - 1)) / 7)]).reverse() : [...(photos || [])].reverse()
  const log = [...(grow.log || [])].sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.ts || 0) - (a.ts || 0))
  const base = `/api/grows/${encodeURIComponent(grow.id)}/export`
  const remove = async () => {
    try {
      await api(`/grows/${encodeURIComponent(grow.id)}`, { method: 'DELETE' })
      toast(t('Grow aus dem Archiv gelöscht.'))
      go('archiv')
    } catch {
      /* toast shown */
    }
  }
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{grow.name}</h1>
          <p>{[grow.strain, grow.room_name, `${day(grow.started)} – ${day(grow.harvested)}`].filter(Boolean).join(' · ')}</p>
        </div>
        <div className="row page-tools">
          <a className="btn ghost" href={href('archiv')}>{t('Alle Grows')}</a>
          <a className="btn" href={`${base}?format=csv&lang=${lang}`}>{t('Protokoll als CSV')}</a>
          <a className="btn" href={base}>{t('Als JSON')}</a>
        </div>
      </div>
      <div className="grow-cols">
        <div className="stack">
          <section className="panel panel-pad" aria-labelledby="fig-head">
            <h2 className="sub" id="fig-head" style={{ marginTop: 0 }}>{t('Kennzahlen')}</h2>
            <dl className="grow-dl">
              {FIGURES.slice(2).map(([label, value]) => (
                <div key={label}><dt>{label}</dt><dd className="num">{value(grow)}</dd></div>
              ))}
            </dl>
            <p className="small muted" style={{ margin: '10px 0 0' }}>
              {s.price
                ? t('Strom geschätzt aus {watts} Lampenleistung (mit Dimmer) und den Lichtstunden, {price} € pro kWh.', { watts: num(s.lamp_watts, 0, 'W'), price: fmt(s.price, 2) })
                : t('Strom geschätzt aus {watts} Lampenleistung (mit Dimmer) und den Lichtstunden.', { watts: num(s.lamp_watts, 0, 'W') })}
            </p>
          </section>
          <section className="panel" aria-labelledby="clim-head">
            <h2 className="sub panel-pad" id="clim-head" style={{ margin: 0, paddingBottom: 0 }}>{t('Klima je Phase')}</h2>
            {s.climate_days || Object.keys(s.climate || {}).length ? (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th scope="col" />{PHASES.map(([k, title]) => <th scope="col" key={k}>{title}</th>)}</tr></thead>
                  <tbody>
                    {CLIMATE.map(([label, value]) => (
                      <tr key={label}><th scope="row">{label}</th>{PHASES.map(([k]) => <td className="num" key={k}>{s.climate?.[k] ? value(s.climate[k]) : '–'}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="small muted panel-pad" style={{ margin: 0 }}>
                {t('Für diesen Grow liegen keine Klimadaten vor. GrowDeck speichert sie ab Version 1.5 jede Nacht als Tageswerte pro Zelt.')}
              </p>
            )}
            <p className="small muted panel-pad" style={{ margin: 0 }}>{t('„Im Ziel“: Anteil der Zeit in den Zielbereichen des Growplans der jeweiligen Woche.')}</p>
          </section>
          {shown.length ? (
            <section className="panel panel-pad" aria-labelledby="ph-head">
              <div className="spread">
                <h2 className="sub" id="ph-head" style={{ margin: 0 }}>{t('Fotos')}</h2>
                {s.cameras?.[0] ? <a className="small" href={href(`kamera/${s.cameras[0]}`)}>{t('Alle Fotos und Zeitraffer')}</a> : null}
              </div>
              <div className="photo-grid small-grid">
                {shown.map((p) => (
                  <a key={p.id} href={photoUrl(p.id)} target="_blank" rel="noreferrer">
                    <img src={photoUrl(p.id, true)} alt={t('Foto vom {date}', { date: new Date(p.ts * 1000).toLocaleDateString(LOCALE) })} loading="lazy" />
                    <span>{new Date(p.ts * 1000).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })}</span>
                  </a>
                ))}
              </div>
            </section>
          ) : null}
        </div>
        <div className="stack">
          <ResultForm key={grow.updated} grow={grow} onSaved={(g) => setGrow((x) => ({ ...x, ...g }))} />
          <section className="panel" aria-labelledby="log-head">
            <h2 className="sub panel-pad" id="log-head" style={{ margin: 0, paddingBottom: 0 }}>{t('Gießprotokoll')}</h2>
            {log.length ? (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th scope="col">{t('Datum')}</th><th scope="col">{t('Art')}</th><th scope="col">{t('Liter')}</th><th scope="col">EC / pH</th><th scope="col">{t('Notiz')}</th></tr></thead>
                  <tbody>
                    {log.map((e) => (
                      <tr key={e.id}>
                        <td>{day(e.date)}</td>
                        <td>{TYPE_LBL[e.type] || e.type}</td>
                        <td className="num">{e.liters != null ? fmt(e.liters, 1) : ''}</td>
                        <td className="num">{e.ecIn != null || e.phIn != null ? `${e.ecIn != null ? fmt(e.ecIn, 2) : '–'} / ${e.phIn != null ? fmt(e.phIn, 1) : '–'}` : ''}</td>
                        <td>{[...(e.tags || []).map((tag) => t(tag)), e.note].filter(Boolean).join(' · ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="small muted panel-pad" style={{ margin: 0 }}>{t('Kein Gießprotokoll gespeichert.')}</p>}
          </section>
          <div><button type="button" className="btn danger small" onClick={() => setConfirm(true)}>{t('Aus dem Archiv löschen')}</button></div>
        </div>
      </div>
      {confirm ? (
        <Modal title={t('Grow löschen?')} onClose={() => setConfirm(false)}
          actions={<>
            <button type="button" className="btn ghost" onClick={() => setConfirm(false)}>{t('Abbrechen')}</button>
            <button type="button" className="btn danger" onClick={remove}>{t('Löschen')}</button>
          </>}>
          <p className="muted" style={{ margin: 0 }}>{t('„{name}“ wird mit Kennzahlen und Gießprotokoll aus dem Archiv gelöscht. Die Fotos bleiben in der Galerie.', { name: grow.name })}</p>
        </Modal>
      ) : null}
    </>
  )
}

export default function Archive({ id, query }) {
  return id ? <Detail id={id} /> : <List query={query} />
}

// Dialogs of the Growplan page, ported from the sheets of the Growplan app.
import { useMemo, useRef, useState } from 'react'
import { toast } from '../store.js'
import { t } from '../i18n.js'
import Icon from '../components/Icon.jsx'
import { Field, Modal, Segmented } from '../components/ui.jsx'
import {
  ADDITIVES, CHECK_DEFAULT, CHECK_GROUPS, COLORS, ENV, ENV_FIELDS, ENV_KEYS, LAMP_DEFAULT, PLANT_TYPES, TAGS, TYPE_SHORT,
} from './data.js'
import {
  activePlants, anyRow, cellIn, clampInt, clone, colFor, currentSched, ensureRows, f1, f2, fV, newProduct, num, numIn,
  parseNum, phaseLabel, phTarget, prodColor, prodNames, resize, rng, rngV, roundTo, rowAt, schedById, vpdOf,
} from './engine.js'
import { ConfirmDialog, Dot } from './parts.jsx'
import { PhotoField } from './extras.jsx'

// ------------------------------------------------------------- log entry
export function EntryEditor({ entry, isNew, plan, lib, probes, tent, onSave, onDelete, onClose }) {
  const [e, setE] = useState(() => ({ ...clone(entry), tags: entry.tags || [], extra: entry.extra || [], plants: entry.plants || [] }))
  const [text, setText] = useState(() => ({
    liters: numIn(entry.liters), strength: numIn(entry.strength), ecIn: numIn(entry.ecIn), phIn: numIn(entry.phIn),
    ecOut: numIn(entry.ecOut), phOut: numIn(entry.phOut),
  }))
  const [extraText, setExtraText] = useState(() => (entry.extra || []).map((x) => numIn(x.a)))
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const isNote = e.type === 'note'
  const sched = currentSched(lib, plan)
  const es = (e.sched && schedById(lib, e.sched.id)) || sched
  const ecTarget = rowAt(es, 'ec', colFor(es, e.phase, e.week, plan.floWeeks))
  const ph = phTarget(sched, plan.medium)
  const chipPlants = activePlants(plan).concat(plan.plants.filter((p) => p.gone && e.plants.includes(p.id)))
  const names = useMemo(() => prodNames(lib), [lib])
  const set = (patch) => setE((x) => ({ ...x, ...patch }))
  const setT = (key, value) => setText((t) => ({ ...t, [key]: value }))

  const togglePlant = (id) => {
    if (id === 'all') return set({ plants: [] })
    let next = e.plants.includes(id) ? e.plants.filter((x) => x !== id) : [...e.plants, id]
    const active = activePlants(plan)
    if (active.length > 1 && next.length === active.length && active.every((p) => next.includes(p.id))) next = []
    set({ plants: next })
  }
  const toggleTag = (tag) => set({ tags: e.tags.includes(tag) ? e.tags.filter((t) => t !== tag) : [...e.tags, tag] })
  const fromProbes = () => {
    if (probes.ec) setT('ecIn', numIn(roundTo(probes.ec.value, 2)))
    if (probes.ph) setT('phIn', numIn(roundTo(probes.ph.value, 1)))
  }

  const save = async () => {
    const out = { ...e }
    delete out._new
    if (!out.date) return toast(t('Bitte ein Datum wählen'), 'warn')
    if (!isNote) {
      out.liters = parseNum(text.liters)
      const st = parseNum(text.strength)
      if (st != null) out.strength = Math.max(0, Math.min(200, Math.round(st)))
      out.extra = e.extra.map((x, i) => ({ n: (x.n || '').trim().slice(0, 40), a: parseNum(extraText[i]), u: x.u === 'g' ? 'g' : 'ml' }))
    }
    for (const key of ['ecIn', 'phIn', 'ecOut', 'phOut']) out[key] = parseNum(text[key])
    out.note = (out.note || '').slice(0, 500)
    if (isNote) {
      if (!out.note.trim() && !out.tags.length && out.ecIn == null && out.phIn == null && out.ecOut == null && out.phOut == null) {
        return toast(t('Bitte eine Notiz, Maßnahme oder Messung eintragen'), 'warn')
      }
      out.liters = null
      out.mix = []
      out.extra = []
    } else if (!(out.liters > 0) || out.liters > 500) return toast(t('Bitte eine gültige Wassermenge angeben'), 'warn')
    const bad = [out.phIn, out.phOut].some((v) => v != null && (v < 0 || v > 14)) || [out.ecIn, out.ecOut].some((v) => v != null && (v < 0 || v > 10))
    if (bad) return toast(t('EC (0–10) bzw. pH (0–14) bitte prüfen'), 'warn')
    if (out.extra.some((x) => x.a != null && (x.a < 0 || x.a > 5000))) return toast(t('Bitte die Mengen bei den Zusätzen prüfen'), 'warn')
    out.extra = out.extra.filter((x) => x.n)
    setBusy(true)
    try {
      await onSave(out)
      toast(t('Eintrag gespeichert'))
      onClose()
    } catch {
      /* toast shown */
    } finally {
      setBusy(false)
    }
  }

  const f = (Number(parseNum(text.strength)) || e.strength || 100) / 100
  const liters = parseNum(text.liters) || 0
  return (
    <>
      <Modal title={isNew ? t('Neuer Eintrag') : t('Eintrag bearbeiten')} onClose={onClose}
        actions={<>
          {!isNew ? <button type="button" className="btn danger" onClick={() => setConfirm(true)} style={{ marginRight: 'auto' }}>{t('Eintrag löschen')}</button> : null}
          <button type="button" className="btn ghost" onClick={onClose}>{t('Abbrechen')}</button>
          <button type="button" className="btn primary" onClick={save} disabled={busy}>{busy ? t('Speichern …') : t('Speichern')}</button>
        </>}>
        <div className="stack">
          <Field label={t('Datum')}><input type="date" className="input" value={e.date} onChange={(ev) => set({ date: ev.target.value })} /></Field>
          <div className="field">
            <span>{t('Art')}</span>
            <Segmented label={t('Art')} value={e.type} onChange={(type) => set({ type })}
              options={['feed', 'water', 'flush', 'note'].map((k) => ({ key: k, label: t(TYPE_SHORT[k]) }))} />
          </div>
          <div className="field">
            <span>{t('Pflanzen')}</span>
            <div className="gp-chips">
              <button type="button" aria-pressed={e.plants.length === 0} onClick={() => togglePlant('all')}>{t('Alle')}</button>
              {chipPlants.map((p) => (
                <button type="button" key={p.id} aria-pressed={e.plants.includes(p.id)} onClick={() => togglePlant(p.id)}>
                  {p.gone ? t('{name} (entfernt)', { name: p.name }) : p.name}
                </button>
              ))}
            </div>
          </div>
          {!isNote ? (
            <div className="gp-form2">
              <Field label={t('Menge (Liter)')}><input className="input" inputMode="decimal" value={text.liters} onChange={(ev) => setT('liters', ev.target.value)} /></Field>
              <Field label={t('Dosierstärke %')}><input className="input" inputMode="numeric" value={text.strength} disabled={e.type === 'water'} onChange={(ev) => setT('strength', ev.target.value)} /></Field>
            </div>
          ) : null}
          <div className="gp-form2">
            <Field label={t('EC Gießwasser')}><input className="input" inputMode="decimal" placeholder={ecTarget != null ? t('Ziel {value}', { value: f2(ecTarget) }) : t('z. B. 1,4')} value={text.ecIn} onChange={(ev) => setT('ecIn', ev.target.value)} /></Field>
            <Field label={t('pH Gießwasser')}><input className="input" inputMode="decimal" placeholder={t('Ziel {value}', { value: `${f1(ph[0])}–${f1(ph[1])}` })} value={text.phIn} onChange={(ev) => setT('phIn', ev.target.value)} /></Field>
          </div>
          {probes.ph || probes.ec ? (
            <button type="button" className="btn small" onClick={fromProbes} style={{ justifySelf: 'start' }}>
              {t('Messwerte vom Gerät übernehmen ({values})', {
                values: [probes.ph ? `pH ${f1(probes.ph.value)}` : '', probes.ec ? `EC ${f2(probes.ec.value)}` : ''].filter(Boolean).join(', '),
              })}
            </button>
          ) : null}
          <div className="gp-form2">
            <Field label={t('EC Drain (optional)')}><input className="input" inputMode="decimal" value={text.ecOut} onChange={(ev) => setT('ecOut', ev.target.value)} /></Field>
            <Field label={t('pH Drain (optional)')}><input className="input" inputMode="decimal" value={text.phOut} onChange={(ev) => setT('phOut', ev.target.value)} /></Field>
          </div>
          {!isNote ? (
            <div className="field">
              <span>{t('Zusätzlich gegeben (optional)')}</span>
              {e.extra.map((x, i) => (
                <div className="gp-xrow" key={i}>
                  <input className="input" list="gp-products" maxLength={40} placeholder={t('z. B. CalMag')} value={x.n} aria-label={t('Produkt')}
                    onChange={(ev) => set({ extra: e.extra.map((y, j) => (j === i ? { ...y, n: ev.target.value } : y)) })} />
                  <input className="input" inputMode="decimal" placeholder={t('Menge')} value={extraText[i] ?? ''} aria-label={t('Menge')}
                    onChange={(ev) => setExtraText((t) => t.map((v, j) => (j === i ? ev.target.value : v)))} />
                  <select className="input" value={x.u === 'g' ? 'g' : 'ml'} aria-label={t('Einheit')}
                    onChange={(ev) => set({ extra: e.extra.map((y, j) => (j === i ? { ...y, u: ev.target.value } : y)) })}>
                    <option value="ml">ml</option><option value="g">g</option>
                  </select>
                  <button type="button" className="icon-btn" aria-label={t('Entfernen')} onClick={() => {
                    set({ extra: e.extra.filter((_, j) => j !== i) })
                    setExtraText((t) => t.filter((_, j) => j !== i))
                  }}><Icon name="close" size={18} /></button>
                </div>
              ))}
              <button type="button" className="btn small" style={{ justifySelf: 'start' }} onClick={() => {
                set({ extra: [...e.extra, { n: '', a: null, u: 'ml' }] })
                setExtraText((t) => [...t, ''])
              }}><Icon name="plus" size={16} /> {t('Zusatz eintragen')}</button>
              <datalist id="gp-products">{names.map((n) => <option key={n} value={n} />)}</datalist>
            </div>
          ) : null}
          <div className="field">
            <span>{t('Maßnahmen (optional)')}</span>
            <div className="gp-chips small">
              {TAGS.map((tag) => <button type="button" key={tag} aria-pressed={e.tags.includes(tag)} onClick={() => toggleTag(tag)}>{t(tag)}</button>)}
            </div>
          </div>
          <Field label={t('Notiz')}>
            <textarea className="input gp-textarea" maxLength={500} value={e.note} placeholder={t('z. B. Blätter hängen, Trichome milchig, neuer Luftbefeuchter …')}
              onChange={(ev) => set({ note: ev.target.value })} />
          </Field>
          {tent ? <PhotoField tent={tent} value={e.photo || null} onChange={(photo) => set({ photo: photo || undefined })} /> : null}
          <p className="small muted" style={{ margin: 0 }}>{phaseLabel(e.phase, e.week)}{e.sched ? ` · ${t(e.sched.name)}` : ''}</p>
          {(e.type === 'feed' || e.type === 'flush') && e.mix?.length ? (
            <div className="field">
              <span>{t('Dünger laut Schema')}</span>
              <div className="panel gp-rows">
                {e.mix.map((x) => (
                  <div className="gp-row" key={x.n}>
                    <Dot color={x.c || 'var(--line)'} />
                    <div className="gp-nm"><b>{t(x.n)}</b></div>
                    <div className="gp-dose num">{x.v == null ? '?' : num(x.v * f * liters, 1)} {x.u}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </Modal>
      {confirm ? (
        <ConfirmDialog title={t('Eintrag löschen?')} text={t('Dieser Eintrag wird aus dem Protokoll entfernt.')} okLabel={t('Löschen')}
          onClose={() => setConfirm(false)}
          onOk={async () => {
            await onDelete(e.id)
            toast(t('Eintrag gelöscht'))
            setConfirm(false)
            onClose()
          }} />
      ) : null}
    </>
  )
}

// --------------------------------------------------------- schedule editor
// A number field that applies its value when left (like the app's change event).
function CommitNumber({ value, min, max, onCommit, label }) {
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

export function ScheduleEditor({ sched, exists, isOverride, onSave, onRemove, onReset, onClose }) {
  const [d, setD] = useState(() => {
    const ed = clone(sched)
    ed.products.forEach((p, i) => {
      p.v = resize(p.v, ed.vegN)
      p.b = resize(p.b, ed.bloomN)
      if (typeof p.t !== 'string') p.t = ''
      if (!p.c) p.c = COLORS[i % COLORS.length]
    })
    ensureRows(ed)
    if (typeof ed.comment !== 'string') ed.comment = ''
    return ed
  })
  const orig = useRef({ v: sched.vegN, b: sched.bloomN })
  const [pick, setPick] = useState(null)
  const [version, setVersion] = useState(0) // remounts the dose fields after structural changes
  const [confirm, setConfirm] = useState(null)
  const [busy, setBusy] = useState(false)
  const mutate = (fn, structural = false) => {
    setD((prev) => {
      const next = clone(prev)
      fn(next)
      return next
    })
    if (structural) setVersion((v) => v + 1)
  }
  const title = d.custom ? (exists ? t('Schema bearbeiten') : t('Neues Schema')) : t('Schema anpassen')

  const resizeWeeks = (patch) => mutate((x) => {
    Object.assign(x, patch)
    if (x.flushN >= x.bloomN) x.flushN = x.bloomN - 1
    x.products.forEach((p) => {
      p.v = resize(p.v, x.vegN)
      p.b = resize(p.b, x.bloomN)
    })
    ensureRows(x)
  }, true)

  const doseInput = (value, onValue, label) => (
    <input type="text" inputMode="decimal" className="input gp-c" defaultValue={cellIn(value)} aria-label={label}
      onChange={(e) => {
        const raw = e.target.value.trim()
        let v
        if (raw === '') v = 0
        else if (raw === '?') v = -1
        else {
          v = parseNum(raw)
          if (v == null || v < 0) return
        }
        onValue(v)
      }} />
  )
  const ecInput = (value, onValue, label) => (
    <input type="text" inputMode="decimal" className="input gp-c" defaultValue={cellIn(value)} aria-label={label}
      onChange={(e) => {
        const raw = e.target.value.trim()
        const v = raw === '' ? 0 : parseNum(raw)
        if (v == null || v < 0 || v > 10) return
        onValue(v)
      }} />
  )

  const save = async () => {
    const x = clone(d)
    x.name = (x.name || '').trim().slice(0, 60) || t('Mein Schema')
    x.products = x.products.filter((p) => (p.n || '').trim())
    x.products.forEach((p) => {
      p.n = p.n.trim().slice(0, 40)
      p.t = (p.t || '').trim()
    })
    const seen = new Set()
    let dup = false
    x.products.forEach((p) => {
      if (seen.has(p.n)) dup = true
      seen.add(p.n)
    })
    if (!x.products.length) return toast(t('Mindestens ein Produkt anlegen'), 'warn')
    if (dup) return toast(t('Produktnamen müssen eindeutig sein'), 'warn')
    x.hold = Math.max(1, Math.min(x.hold || x.bloomN - x.flushN, x.bloomN - x.flushN))
    x.notes.v = x.notes.v.map((n) => (n || '').trim())
    x.notes.b = x.notes.b.map((n) => (n || '').trim())
    if (!anyRow(x, 'ec')) delete x.ec
    if (!anyRow(x, 'notes')) delete x.notes
    x.comment = (x.comment || '').trim()
    if (!x.comment) delete x.comment
    if (!x.custom) x.adjusted = true
    setBusy(true)
    try {
      await onSave(x, orig.current)
      onClose()
    } catch {
      /* toast shown */
    } finally {
      setBusy(false)
    }
  }

  const weeks = []
  for (let i = 1; i <= d.vegN; i++) weeks.push({ key: `v${i}`, label: `W${i}` })
  for (let i = 1; i <= d.bloomN; i++) weeks.push({ key: `b${i}`, label: `B${i}${i > d.bloomN - d.flushN ? ' ✦' : ''}` })
  const hasNotes = d.notes.v.concat(d.notes.b).some(Boolean)
  const picked = pick != null ? d.products[pick] : null

  return (
    <>
      <Modal wide title={title} onClose={onClose}
        actions={<>
          {d.custom && exists ? <button type="button" className="btn danger" style={{ marginRight: 'auto' }} onClick={() => setConfirm('remove')}>{t('Schema löschen')}</button> : null}
          {!d.custom && isOverride ? <button type="button" className="btn danger" style={{ marginRight: 'auto' }} onClick={() => setConfirm('reset')}>{t('Original wiederherstellen')}</button> : null}
          <button type="button" className="btn ghost" onClick={onClose}>{t('Abbrechen')}</button>
          <button type="button" className="btn primary" onClick={save} disabled={busy}>{busy ? t('Speichern …') : t('Speichern')}</button>
        </>}>
        <div className="stack">
          {!d.custom ? <p className="small muted" style={{ margin: 0 }}>{t('Änderungen gelten für {schedule}. Das Original lässt sich jederzeit wiederherstellen.', { schedule: `${d.brand} · ${t(d.name)}` })}</p> : null}
          <Field label={t('Name')}><input className="input" maxLength={60} value={d.name} onChange={(e) => mutate((x) => { x.name = e.target.value })} /></Field>
          <div className="gp-form3">
            <Field label={t('Wachstum (Wo.)')}><CommitNumber label={t('Wachstum (Wochen)')} value={d.vegN} min={1} max={12} onCommit={(vegN) => resizeWeeks({ vegN })} /></Field>
            <Field label={t('Blüte (Wo.)')}><CommitNumber label={t('Blüte (Wochen)')} value={d.bloomN} min={4} max={16} onCommit={(bloomN) => resizeWeeks({ bloomN })} /></Field>
            <Field label={t('davon Spülen')}><CommitNumber label={t('davon Spülen')} value={d.flushN} min={0} max={3} onCommit={(flushN) => resizeWeeks({ flushN })} /></Field>
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            {t('Menge pro Liter. Leeres Feld = nicht verwenden, „?“ = Wert noch unbekannt. Farbpunkt antippen, um eine Farbe zu wählen. Änderst du die Wochenzahl, übernimmt dein Plan sie beim Speichern.')}
          </p>
          {picked ? (
            <div className="gp-palette">
              <b>{t('Farbe für „{name}“', { name: picked.n })}</b>
              <div className="gp-swatches">
                {COLORS.map((c) => (
                  <button type="button" key={c} style={{ background: c }} aria-label={t('Farbe {color}', { color: c })} aria-pressed={picked.c === c}
                    onClick={() => {
                      mutate((x) => { x.products[pick].c = c })
                      setPick(null)
                    }} />
                ))}
                <button type="button" aria-label={t('Automatische Farbe')} onClick={() => {
                  mutate((x) => { delete x.products[pick].c })
                  setPick(null)
                }}>auto</button>
              </div>
            </div>
          ) : null}
          <div className="table-wrap gp-scroll gp-ed" key={version}>
            <table className="gp-table">
              <thead>
                <tr>
                  <th className="gp-p">{t('Produkt')}</th><th>{t('Einheit')}</th><th>{t('Art')}</th>
                  {weeks.map((w) => <th key={w.key}>{w.label}</th>)}
                  <th aria-label={t('Entfernen')} />
                </tr>
              </thead>
              <tbody>
                {d.products.map((p, pi) => (
                  <tr key={`${pi}-${version}`}>
                    <td className="gp-p">
                      <div className="gp-pc">
                        <button type="button" className="gp-cdot" style={{ background: prodColor(d, p) }} aria-label={t('Farbe für {name} wählen', { name: p.n })} onClick={() => setPick(pi)} />
                        <div>
                          <input className="input gp-n" maxLength={40} value={p.n} aria-label={t('Produktname')} onChange={(e) => mutate((x) => { x.products[pi].n = e.target.value })} />
                          <input className="input gp-n gp-t" maxLength={60} value={p.t} placeholder={t('Kommentar (optional)')} aria-label={t('Kommentar zum Produkt')}
                            onChange={(e) => mutate((x) => { x.products[pi].t = e.target.value.slice(0, 60) })} />
                        </div>
                      </div>
                    </td>
                    <td>
                      <select className="input gp-sel" value={p.u === 'g' ? 'g' : 'ml'} aria-label={t('Einheit')} onChange={(e) => mutate((x) => { x.products[pi].u = e.target.value })}>
                        <option value="ml">ml</option><option value="g">g</option>
                      </select>
                    </td>
                    <td>
                      <select className="input gp-sel" value={p.k} aria-label={t('Art')} onChange={(e) => mutate((x) => { x.products[pi].k = e.target.value })}>
                        <option value="base">{t('Basis')}</option><option value="add">{t('Zusatz')}</option><option value="flush">{t('Spülen')}</option>
                      </select>
                    </td>
                    {p.v.map((v, w) => <td key={`v${w}`}>{doseInput(v, (nv) => mutate((x) => { x.products[pi].v[w] = nv }), `${p.n} W${w + 1}`)}</td>)}
                    {p.b.map((v, w) => <td key={`b${w}`}>{doseInput(v, (nv) => mutate((x) => { x.products[pi].b[w] = nv }), `${p.n} B${w + 1}`)}</td>)}
                    <td>
                      <button type="button" className="icon-btn" aria-label={t('Produkt entfernen')} onClick={() => {
                        mutate((x) => { x.products.splice(pi, 1) }, true)
                        setPick(null)
                      }}><Icon name="close" size={18} /></button>
                    </td>
                  </tr>
                ))}
                <tr className="gp-xr">
                  <td className="gp-p"><b>{t('Ziel-EC')}</b> <small>mS/cm</small></td><td /><td />
                  {d.ec.v.map((v, w) => <td key={`ev${w}`}>{ecInput(v, (nv) => mutate((x) => { x.ec.v[w] = nv }), t('Ziel-EC {week}', { week: `W${w + 1}` }))}</td>)}
                  {d.ec.b.map((v, w) => <td key={`eb${w}`}>{ecInput(v, (nv) => mutate((x) => { x.ec.b[w] = nv }), t('Ziel-EC {week}', { week: `B${w + 1}` }))}</td>)}
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
          <p className="small muted" style={{ margin: 0 }}>{t('✦ = Spülwoche · Ziel-EC ist optional und erscheint beim Mischen und im Protokoll.')}</p>
          <div className="field">
            <span>{t('Produkt ergänzen')}</span>
            <div className="gp-chips small">
              {['Produkt', ...ADDITIVES].map((n) => (
                <button type="button" key={n} onClick={() => {
                  const blank = t('Neues Produkt')
                  let name = n === 'Produkt' ? blank : n
                  if (d.products.some((p) => p.n === name)) {
                    if (name !== blank) return toast(t('{name} ist schon im Schema', { name: t(name) }), 'warn')
                    name = t('Neues Produkt {n}', { n: d.products.length + 1 })
                  }
                  mutate((x) => {
                    const np = newProduct(name, x.vegN, x.bloomN)
                    np.c = COLORS[x.products.length % COLORS.length]
                    x.products.push(np)
                  }, true)
                  setPick(null)
                }}>+ {n === 'Produkt' ? t('Eigenes Produkt') : t(n)}</button>
              ))}
            </div>
          </div>
          <details className="gp-details" open={hasNotes}>
            <summary>{t('Kommentare je Woche')}</summary>
            {d.notes.v.map((n, w) => (
              <div className="gp-nrow" key={`nv${w}`}><span>W{w + 1}</span>
                <input className="input" maxLength={200} value={n} placeholder={t('z. B. Umtopfen')} onChange={(e) => mutate((x) => { x.notes.v[w] = e.target.value })} />
              </div>
            ))}
            {d.notes.b.map((n, w) => (
              <div className="gp-nrow" key={`nb${w}`}><span>B{w + 1}</span>
                <input className="input" maxLength={200} value={n} placeholder={t('z. B. Entlauben')} onChange={(e) => mutate((x) => { x.notes.b[w] = e.target.value })} />
              </div>
            ))}
          </details>
          <Field label={t('Kommentar zum Schema')}>
            <textarea className="input gp-textarea" maxLength={1000} value={d.comment} placeholder={t('z. B. Erfahrungen, Wasserwerte, Bezugsquelle …')}
              onChange={(e) => mutate((x) => { x.comment = e.target.value.slice(0, 1000) })} />
          </Field>
        </div>
      </Modal>
      {confirm === 'remove' ? (
        <ConfirmDialog title={t('Schema löschen?')} text={t('„{name}“ wird endgültig entfernt. Gießprotokoll-Einträge bleiben erhalten.', { name: t(d.name) })}
          okLabel={t('Löschen')} onClose={() => setConfirm(null)} onOk={async () => {
            await onRemove(d.id)
            setConfirm(null)
            onClose()
          }} />
      ) : null}
      {confirm === 'reset' ? (
        <ConfirmDialog title={t('Original wiederherstellen?')} text={t('Deine Änderungen an diesem Schema – auch Farben und Kommentare – werden verworfen.')}
          okLabel={t('Wiederherstellen')} onClose={() => setConfirm(null)} onOk={async () => {
            await onReset(d.id)
            setConfirm(null)
            onClose()
          }} />
      ) : null}
    </>
  )
}

// --------------------------------------------------------- simple texts
export function TextDialog({ title, subtitle, hint, value, maxLength, placeholder, tall, onSave, onDelete, onClose }) {
  const [text, setText] = useState(value || '')
  const [busy, setBusy] = useState(false)
  const run = async (fn) => {
    setBusy(true)
    try {
      await fn()
      onClose()
    } catch {
      /* toast shown */
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title={title} onClose={onClose}
      actions={<>
        {onDelete && value ? <button type="button" className="btn danger" style={{ marginRight: 'auto' }} disabled={busy} onClick={() => run(onDelete)}>{t('Kommentar löschen')}</button> : null}
        <button type="button" className="btn ghost" onClick={onClose}>{t('Abbrechen')}</button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => run(() => onSave(text.trim().slice(0, maxLength)))}>{t('Speichern')}</button>
      </>}>
      <div className="stack">
        {subtitle ? <p className="muted" style={{ margin: 0 }}>{subtitle}</p> : null}
        {hint ? <p className="small muted" style={{ margin: 0 }}>{hint}</p> : null}
        <textarea className={`input gp-textarea ${tall ? 'tall' : ''}`} maxLength={maxLength} placeholder={placeholder} value={text}
          aria-label={title} onChange={(e) => setText(e.target.value)} />
      </div>
    </Modal>
  )
}

// ------------------------------------------------------ targets per phase
function envDraft(env) {
  const draft = {}
  for (const f of ENV_FIELDS) draft[f.k] = f.single ? numIn(env[f.k]) : [numIn(env[f.k][0]), numIn(env[f.k][1])]
  return draft
}

function parseEnvDraft(draft) {
  const out = {}
  for (const f of ENV_FIELDS) {
    if (f.single) {
      const v = parseNum(draft[f.k])
      if (v == null || v < f.lo || v > f.hi) return null
      out[f.k] = Math.round(v)
    } else {
      let a = parseNum(draft[f.k][0])
      let b = parseNum(draft[f.k][1])
      if (a == null || b == null || a < f.lo || a > f.hi || b < f.lo || b > f.hi) return null
      if (a > b) [a, b] = [b, a]
      out[f.k] = [roundTo(a, f.dec), roundTo(b, f.dec)]
    }
  }
  return out
}

export function EnvEditor({ plan, current, onSave, onClose }) {
  const [values, setValues] = useState(() => Object.fromEntries(ENV_KEYS.map((k) => {
    const d = ENV[k]
    const o = plan.envOv?.[k] || {}
    const r = {}
    for (const f in d) r[f] = f in o ? o[f] : d[f]
    return [k, r]
  })))
  const [k, setK] = useState(current)
  const [draft, setDraft] = useState(() => envDraft(values[current]))
  const [confirm, setConfirm] = useState(false)
  const differs = (key, vals) => ENV_FIELDS.some((f) => JSON.stringify(vals[key][f.k]) !== JSON.stringify(ENV[key][f.k]))

  const sync = () => {
    const parsed = parseEnvDraft(draft)
    if (!parsed) return null
    const next = { ...values, [k]: { ...values[k], ...parsed } }
    setValues(next)
    return next
  }
  const switchTo = (key) => {
    let next = sync()
    if (!next) {
      toast(t('Ungültige Felder wurden nicht übernommen'), 'warn')
      next = values
    }
    setK(key)
    setDraft(envDraft(next[key]))
  }
  const setField = (field, index, value) => setDraft((dr) => ({
    ...dr, [field]: index == null ? value : dr[field].map((v, i) => (i === index ? value : v)),
  }))
  const calcVpd = () => {
    const [t0, t1] = draft.tag.map(parseNum)
    const [r0, r1] = draft.rh.map(parseNum)
    if ([t0, t1, r0, r1].some((v) => v == null)) return toast(t('Erst Temperatur Tag und Luftfeuchte eintragen'), 'warn')
    const tAvg = (t0 + t1) / 2
    const lo = vpdOf(tAvg, Math.max(r0, r1), plan.leafOff)
    const hi = vpdOf(tAvg, Math.min(r0, r1), plan.leafOff)
    setDraft((dr) => ({ ...dr, vpd: [numIn(roundTo(Math.max(0.1, lo), 2)), numIn(roundTo(Math.max(0.1, hi), 2))] }))
    toast(t('Berechnet für Ø {temp} °C und {off} K kühleres Blatt', { temp: num(tAvg), off: num(plan.leafOff) }))
  }
  const save = async () => {
    const next = sync()
    if (!next) return toast(t('Mindestens ein Wert ist leer oder außerhalb des sinnvollen Bereichs'), 'warn')
    const ov = {}
    ENV_KEYS.forEach((key) => {
      const o = {}
      ENV_FIELDS.forEach((f) => {
        if (JSON.stringify(next[key][f.k]) !== JSON.stringify(ENV[key][f.k])) o[f.k] = next[key][f.k]
      })
      if (Object.keys(o).length) ov[key] = o
    })
    await onSave(ov)
    toast(t('Zielwerte gespeichert'))
    onClose()
  }
  const def = ENV[k]
  return (
    <>
      <Modal title={t('Zielwerte anpassen')} onClose={onClose}
        actions={<>
          <button type="button" className="btn danger" style={{ marginRight: 'auto' }} onClick={() => setConfirm(true)}>{t('Alle zurücksetzen')}</button>
          <button type="button" className="btn ghost" onClick={() => {
            setDraft(envDraft(ENV[k]))
            toast(t('Standardwerte eingetragen – zum Übernehmen speichern'))
          }}>{t('Standard für diese Phase')}</button>
          <button type="button" className="btn ghost" onClick={onClose}>{t('Abbrechen')}</button>
          <button type="button" className="btn primary" onClick={save}>{t('Speichern')}</button>
        </>}>
        <div className="stack">
          <Field label={t('Phase')}>
            <select className="input" value={k} onChange={(e) => switchTo(e.target.value)}>
              {ENV_KEYS.map((key) => <option key={key} value={key}>{t(ENV[key].n)}{differs(key, values) ? ' •' : ''}</option>)}
            </select>
          </Field>
          {ENV_FIELDS.map((f) => {
            const std = f.single ? num(def[f.k], 0) : f.k === 'vpd' ? rngV(def[f.k]) : rng(def[f.k])
            const label = t(f.l)
            return (
              <div className="field" key={f.k}>
                <span>{f.single
                  ? t('{label} ({unit}) · Standard {std}', { label, unit: t(f.u), std })
                  : t('{label} ({unit}) von / bis · Standard {std}', { label, unit: t(f.u), std })}</span>
                {f.single ? (
                  <input className="input" inputMode="numeric" value={draft[f.k]} aria-label={label} onChange={(e) => setField(f.k, null, e.target.value)} />
                ) : (
                  <div className="gp-form2">
                    <input className="input" inputMode="decimal" value={draft[f.k][0]} aria-label={t('{label} von', { label })} onChange={(e) => setField(f.k, 0, e.target.value)} />
                    <input className="input" inputMode="decimal" value={draft[f.k][1]} aria-label={t('{label} bis', { label })} onChange={(e) => setField(f.k, 1, e.target.value)} />
                  </div>
                )}
                {f.k === 'vpd' ? <button type="button" className="btn small" style={{ justifySelf: 'start' }} onClick={calcVpd}>{t('VPD aus Temperatur & Feuchte berechnen')}</button> : null}
              </div>
            )
          })}
          <p className="small muted" style={{ margin: 0 }}>{t('Die Werte gelten für die gewählte Phase – Heute, Klima, Licht, der VPD-Rechner und die Zeltsteuerung richten sich danach.')}</p>
        </div>
      </Modal>
      {confirm ? (
        <ConfirmDialog title={t('Alle Zielwerte zurücksetzen?')} text={t('Alle Phasen bekommen wieder die Standardwerte der App.')} okLabel={t('Zurücksetzen')}
          onClose={() => setConfirm(false)} onOk={async () => {
            await onSave({})
            toast(t('Zielwerte zurückgesetzt'))
            setConfirm(false)
            onClose()
          }} />
      ) : null}
    </>
  )
}

// ------------------------------------------------------------------ lamp
export function LampEditor({ lamp, onSave, onClose }) {
  const [form, setForm] = useState(() => ({
    name: lamp.name, ppf: numIn(lamp.ppf), watt: numIn(lamp.watt), util: numIn(lamp.util), price: numIn(lamp.price), luxF: numIn(lamp.luxF),
  }))
  const set = (key) => (e) => setForm((x) => ({ ...x, [key]: e.target.value }))
  const save = async () => {
    const name = (form.name || '').trim() || LAMP_DEFAULT.name
    const ppf = parseNum(form.ppf)
    const watt = parseNum(form.watt)
    const util = parseNum(form.util)
    const price = parseNum(form.price)
    const luxF = parseNum(form.luxF)
    if (!(ppf >= 50 && ppf <= 5000) || !(watt >= 10 && watt <= 3000) || !(util >= 30 && util <= 100) || !(price >= 0 && price <= 3) || !(luxF >= 10 && luxF <= 150)) {
      return toast(t('Bitte die Werte prüfen'), 'warn')
    }
    await onSave({ name: name.slice(0, 40), ppf, watt, util, luxF, price })
    toast(t('Lampe gespeichert'))
    onClose()
  }
  return (
    <Modal title={t('Lampe & Umrechnung')} onClose={onClose}
      actions={<>
        <button type="button" className="btn danger" style={{ marginRight: 'auto' }} onClick={async () => {
          await onSave(clone(LAMP_DEFAULT))
          toast(t('Werte der G3000 wiederhergestellt'))
          onClose()
        }}>{t('Werte der G3000 wiederherstellen')}</button>
        <button type="button" className="btn ghost" onClick={onClose}>{t('Abbrechen')}</button>
        <button type="button" className="btn primary" onClick={save}>{t('Speichern')}</button>
      </>}>
      <div className="stack">
        <Field label={t('Bezeichnung')}><input className="input" maxLength={40} value={form.name} onChange={set('name')} /></Field>
        <div className="gp-form2">
          <Field label="PPF (µmol/s)"><input className="input" inputMode="decimal" value={form.ppf} onChange={set('ppf')} /></Field>
          <Field label={t('Leistung (W)')}><input className="input" inputMode="decimal" value={form.watt} onChange={set('watt')} /></Field>
          <Field label={t('Nutzung im Zelt (%)')}><input className="input" inputMode="decimal" value={form.util} onChange={set('util')} /></Field>
          <Field label={t('Strompreis (€/kWh)')}><input className="input" inputMode="decimal" value={form.price} onChange={set('price')} /></Field>
        </div>
        <Field label={t('Lux pro µmol/m²s (Umrechnungsfaktor)')}><input className="input" inputMode="decimal" value={form.luxF} onChange={set('luxF')} /></Field>
        <p className="small muted" style={{ margin: 0 }}>
          {t('Für weißes Vollspektrum-LED mit etwas Tiefrot passen etwa 60–70, für Sonnenlicht rund 54. Mit einem PAR-Messgerät bestimmst du den Faktor selbst: gemessene Lux ÷ PPFD an derselben Stelle.')}
        </p>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------- plants
export function PlantEditor({ plant, isNew, plan, onSave, onRemove, onClose }) {
  const [p, setP] = useState(() => ({ ...plant }))
  const [pot, setPot] = useState(numIn(plant.pot))
  const [confirm, setConfirm] = useState(false)
  const save = async () => {
    const next = { ...p, name: (p.name || '').trim().slice(0, 24), strain: (p.strain || '').trim().slice(0, 40), note: (p.note || '').slice(0, 300) }
    const potValue = parseNum(pot)
    next.pot = potValue != null && potValue > 0 && potValue <= 1000 ? potValue : null
    if (!next.name) return toast(t('Bitte einen Namen eingeben'), 'warn')
    if (activePlants(plan).some((x) => x.id !== next.id && x.name.toLowerCase() === next.name.toLowerCase())) return toast(t('Diesen Namen gibt es schon'), 'warn')
    await onSave(next)
    toast(t('Pflanze gespeichert'))
    onClose()
  }
  return (
    <>
      <Modal title={isNew ? t('Pflanze hinzufügen') : t('Pflanze bearbeiten')} onClose={onClose}
        actions={<>
          {!isNew ? <button type="button" className="btn danger" style={{ marginRight: 'auto' }} onClick={() => setConfirm(true)}>{t('Pflanze entfernen')}</button> : null}
          <button type="button" className="btn ghost" onClick={onClose}>{t('Abbrechen')}</button>
          <button type="button" className="btn primary" onClick={save}>{t('Speichern')}</button>
        </>}>
        <div className="stack">
          <Field label={t('Name')}><input className="input" maxLength={24} value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} /></Field>
          <Field label={t('Sorte')}><input className="input" maxLength={40} placeholder={t('z. B. Northern Lights')} value={p.strain} onChange={(e) => setP({ ...p, strain: e.target.value })} /></Field>
          <div className="field">
            <span>{t('Typ')}</span>
            <Segmented label={t('Typ')} value={p.type} onChange={(type) => setP({ ...p, type })}
              options={Object.entries(PLANT_TYPES).map(([key, label]) => ({ key, label: t(label) }))} />
          </div>
          <div className="gp-form2">
            <Field label={t('Topfgröße (Liter)')}><input className="input" inputMode="decimal" value={pot} onChange={(e) => setPot(e.target.value)} /></Field>
            <Field label={t('Start (Keimung/Steckling)')}><input type="date" className="input" value={p.start} onChange={(e) => setP({ ...p, start: e.target.value })} /></Field>
          </div>
          <Field label={t('Notiz')}>
            <textarea className="input gp-textarea" maxLength={300} placeholder={t('z. B. Herkunft, Phänotyp, Besonderheiten …')} value={p.note}
              onChange={(e) => setP({ ...p, note: e.target.value })} />
          </Field>
        </div>
      </Modal>
      {confirm ? (
        <ConfirmDialog title={t('Pflanze entfernen?')} text={t('„{name}“ verschwindet aus der Auswahl. Einträge im Gießprotokoll bleiben erhalten.', { name: p.name })}
          okLabel={t('Entfernen')} onClose={() => setConfirm(false)} onOk={async () => {
            await onRemove(p.id)
            toast(t('Pflanze entfernt'))
            setConfirm(false)
            onClose()
          }} />
      ) : null}
    </>
  )
}

// ------------------------------------------------------------ checklist
export function ChecklistEditor({ lib, onChange, onClose }) {
  const [text, setText] = useState('')
  const [group, setGroup] = useState('vor')
  const [confirm, setConfirm] = useState(false)
  const off = lib.checkOff || []
  const custom = lib.checkCustom || []
  const add = async () => {
    const value = text.trim()
    if (!value) return toast(t('Bitte einen Text eingeben'), 'warn')
    await onChange({ checkCustom: [...custom, { id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, g: group, t: value.slice(0, 100) }] })
    setText('')
    toast(t('Punkt hinzugefügt'))
  }
  return (
    <>
      <Modal title={t('Checkliste anpassen')} onClose={onClose}
        actions={<>
          <button type="button" className="btn danger" style={{ marginRight: 'auto' }} onClick={() => setConfirm(true)}>{t('Standardliste wiederherstellen')}</button>
          <button type="button" className="btn primary" onClick={onClose}>{t('Fertig')}</button>
        </>}>
        <div className="stack">
          <p className="muted" style={{ margin: 0 }}>{t('Standardpunkte kannst du ausblenden, eigene Punkte ergänzen.')}</p>
          {CHECK_GROUPS.map(([g, label]) => (
            <div key={g}>
              <div className="gp-chkgroup">{t(label)}</div>
              {CHECK_DEFAULT.filter((c) => c.g === g).map((c) => {
                const visible = !off.includes(c.id)
                return (
                  <button type="button" key={c.id} className={`gp-chk ${visible ? 'on' : ''}`} aria-pressed={visible}
                    onClick={() => onChange({ checkOff: visible ? [...off, c.id] : off.filter((x) => x !== c.id) })}>
                    <span className="gp-box" aria-hidden="true">{visible ? '✓' : ''}</span><span className="gp-ct">{t(c.t)}</span>
                  </button>
                )
              })}
              {custom.filter((c) => c.g === g).map((c) => (
                <div className="gp-chkx" key={c.id}>
                  <span className="gp-ct">{c.t} <small className="muted">{t('(eigener Punkt)')}</small></span>
                  <button type="button" className="icon-btn" aria-label={t('Punkt löschen')} onClick={() => onChange({ checkCustom: custom.filter((x) => x.id !== c.id) })}>
                    <Icon name="close" size={18} />
                  </button>
                </div>
              ))}
            </div>
          ))}
          <div className="gp-form2">
            <Field label={t('Eigener Punkt')}><input className="input" maxLength={100} placeholder={t('z. B. Sprühflasche beschriften')} value={text} onChange={(e) => setText(e.target.value)} /></Field>
            <Field label={t('Abschnitt')}>
              <select className="input" value={group} onChange={(e) => setGroup(e.target.value)}>
                {CHECK_GROUPS.map(([g, label]) => <option key={g} value={g}>{t(label)}</option>)}
              </select>
            </Field>
          </div>
          <button type="button" className="btn" style={{ justifySelf: 'start' }} onClick={add}>{t('Punkt hinzufügen')}</button>
        </div>
      </Modal>
      {confirm ? (
        <ConfirmDialog title={t('Standardliste wiederherstellen?')} text={t('Ausgeblendete Punkte werden wieder angezeigt, eigene Punkte gelöscht.')}
          okLabel={t('Wiederherstellen')} onClose={() => setConfirm(false)} onOk={async () => {
            await onChange({ checkOff: [], checkCustom: [] })
            toast(t('Standardliste wiederhergestellt'))
            setConfirm(false)
          }} />
      ) : null}
    </>
  )
}

// --------------------------------------------------------------- backup
export function RestoreDialog({ onImport, onClose, intro }) {
  const [paste, setPaste] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async (txt) => {
    let o
    try {
      o = JSON.parse(txt)
    } catch {
      return toast(t('Das ist keine gültige Backup-Datei'), 'warn')
    }
    if (!o || o.app !== 'growplan' || !Array.isArray(o.log)) return toast(t('Kein Growplan-Backup'), 'warn')
    setBusy(true)
    try {
      await onImport(o)
      onClose()
    } catch {
      /* toast shown */
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title={t('Backup laden')} onClose={onClose}
      actions={<>
        <button type="button" className="btn ghost" onClick={onClose}>{t('Abbrechen')}</button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => {
          const txt = paste.trim()
          if (!txt) return toast(t('Bitte Backup-Text einfügen'), 'warn')
          run(txt)
        }}>{t('Text importieren')}</button>
      </>}>
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>
          {intro || t('Einträge aus dem Backup werden zum bestehenden Protokoll hinzugefügt, gleiche Einträge werden aktualisiert.')}
          {' '}{t('Backups der Growplan-App (Protokoll → „Backup speichern“) lassen sich direkt laden.')}
        </p>
        <Field label={t('Backup-Datei')}>
          <input type="file" className="input" accept=".json,application/json,text/plain" disabled={busy} onChange={(e) => {
            const file = e.target.files && e.target.files[0]
            if (file) file.text().then(run, () => toast(t('Die Datei lässt sich nicht lesen'), 'warn'))
          }} />
        </Field>
        <Field label={t('…oder Backup-Text einfügen')}>
          <textarea className="input gp-textarea" placeholder={'{"app":"growplan" …'} value={paste} onChange={(e) => setPaste(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

export { fV }

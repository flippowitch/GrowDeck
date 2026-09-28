// Tab "Dünger": feeding schedule, the week's watering can, the complete plan and hints.
import { toast } from '../store.js'
import { t } from '../i18n.js'
import { Field } from '../components/ui.jsx'
import { BUILTIN, MIX_ORDER, TIPS } from './data.js'
import {
  allScheds, anyRow, clampInt, clampWeek, clone, colFor, currentSched, doseAt, ensureRows, f1, hasMissing, isHidden,
  newBlank, newCustomFrom, num, phaseLabel, prodColor, rowAt, sameColWeeks, schedLabel,
} from './engine.js'
import { Block, Dot, MixRows, Rich } from './parts.jsx'

// Saves a changed schedule: own schedules into the list, built-in ones as adjusted copy.
export async function storeSchedule(g, d) {
  const lib = g.lib
  if (d.custom) {
    const exists = lib.custom.some((c) => c.id === d.id)
    await g.saveLibrary({ custom: exists ? lib.custom.map((c) => (c.id === d.id ? d : c)) : [...lib.custom, d] })
  } else {
    await g.saveLibrary({ ovr: { ...lib.ovr, [d.id]: { ...d, adjusted: true } } })
  }
}

function PlanTable({ g, sched }) {
  const { plan, pos, update } = g
  const cols = []
  for (let i = 1; i <= plan.vegWeeks; i++) cols.push({ ph: 'veg', w: i, c: colFor(sched, 'veg', i, plan.floWeeks) })
  for (let i = 1; i <= plan.floWeeks; i++) cols.push({ ph: 'flower', w: i, c: colFor(sched, 'flower', i, plan.floWeeks) })
  const cc = (c) => (pos.phase === c.ph && pos.week === c.w ? ' cc' : '')
  const toggle = (p) => {
    const list = plan.hidden?.[sched.id] || []
    const next = list.includes(p.n) ? list.filter((n) => n !== p.n) : [...list, p.n]
    update({ hidden: { ...plan.hidden, [sched.id]: next } })
  }
  return (
    <div className="table-wrap gp-scroll">
      <table className="gp-table gp-plan">
        <thead>
          <tr>
            <th className="gp-p">{t('Produkt')}</th>
            {cols.map((c) => <th key={`${c.ph}${c.w}`} className={cc(c).trim()} scope="col">{c.ph === 'veg' ? 'W' : 'B'}{c.w}</th>)}
          </tr>
        </thead>
        <tbody>
          {sched.products.map((p) => {
            const hid = isHidden(plan, sched, p.n)
            const color = prodColor(sched, p)
            return (
              <tr key={p.n} className={hid ? 'hid' : ''}>
                <td className="gp-p">
                  <button type="button" className="gp-pname" onClick={() => toggle(p)} aria-pressed={!hid}
                    title={hid ? t('Ausgeblendet – antippen zum Einblenden') : t('Antippen zum Ausblenden')}>
                    <Dot color={color} />{t(p.n)}{p.u === 'g' ? <small> (g)</small> : null}
                  </button>
                </td>
                {cols.map((c) => {
                  const v = doseAt(p, c.c)
                  const key = `${c.ph}${c.w}`
                  if (v === 0) return <td key={key} className={`off${cc(c)}`}>·</td>
                  if (v < 0) return <td key={key} className={`miss${cc(c)}`}>?</td>
                  return (
                    <td key={key} className={`on${cc(c)}`} style={{ background: `color-mix(in srgb, ${color} 24%, var(--panel))` }}>
                      {num((v * plan.strength) / 100, 2)}
                    </td>
                  )
                })}
              </tr>
            )
          })}
          {anyRow(sched, 'ec') ? (
            <tr className="gp-xr">
              <td className="gp-p"><b>{t('Ziel-EC')}</b></td>
              {cols.map((c) => {
                const v = rowAt(sched, 'ec', c.c)
                return <td key={`${c.ph}${c.w}`} className={cc(c).trim()}>{v != null ? f1(v) : '·'}</td>
              })}
            </tr>
          ) : null}
          {anyRow(sched, 'notes') ? (
            <tr className="gp-xr">
              <td className="gp-p"><b>{t('Kommentar')}</b></td>
              {cols.map((c) => {
                const v = rowAt(sched, 'notes', c.c)
                return (
                  <td key={`${c.ph}${c.w}`} className={cc(c).trim()}>
                    {v ? <button type="button" className="gp-pname" title={v} aria-label={t('Kommentar {week}: {text}', { week: `${c.ph === 'veg' ? 'W' : 'B'}${c.w}`, text: v })} onClick={() => toast(v)}>✎</button> : '·'}
                  </td>
                )
              })}
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  )
}

export default function Feed({ g }) {
  const { plan, lib, pos, update } = g
  const s = currentSched(lib, plan)
  const col = colFor(s, pos.phase, pos.week, plan.floWeeks)
  const diff = plan.vegWeeks !== s.vegN || plan.floWeeks !== s.bloomN
  const tipsKey = s.custom ? 'custom' : (s.tips || 'custom')
  const groups = []
  for (const x of allScheds(lib)) {
    const name = x.custom ? t('Eigene Schemata') : x.brand
    let group = groups.find((gr) => gr.name === name)
    if (!group) groups.push((group = { name, items: [] }))
    group.items.push(x)
  }
  const weekNote = rowAt(s, 'notes', col)

  const openEditor = (sched) => g.open({
    kind: 'sched', sched, exists: lib.custom.some((c) => c.id === sched.id), isOverride: !!lib.ovr?.[sched.id],
    onSave: async (d, orig) => {
      await storeSchedule(g, d)
      let adopt = false
      update((data) => {
        let next = { ...data, sched: d.id }
        if (d.bloomN !== orig.b || (d.custom && d.bloomN > data.floWeeks)) {
          next.floWeeks = clampInt(d.bloomN, 4, 16, data.floWeeks)
          adopt = true
        }
        if (d.vegN !== orig.v) {
          next.vegWeeks = clampInt(d.vegN, 1, 12, data.vegWeeks)
          adopt = true
        }
        next = clampWeek(next)
        const weeks = { veg: next.vegWeeks, flower: next.floWeeks }
        if (d.custom) toast(adopt ? t('Schema gespeichert – Plan jetzt {veg} + {flower} Wochen', weeks) : t('Schema gespeichert'))
        else toast(adopt ? t('Anpassung gespeichert – Plan jetzt {veg} + {flower} Wochen', weeks) : t('Anpassung gespeichert'))
        return next
      })
    },
    onRemove: async (id) => {
      await g.saveLibrary({ custom: lib.custom.filter((c) => c.id !== id) })
      update((data) => {
        const hidden = { ...data.hidden }
        delete hidden[id]
        return { ...data, hidden, sched: data.sched === id ? BUILTIN[0].id : data.sched }
      })
      toast(t('Schema gelöscht'))
    },
    onReset: async (id) => {
      const ovr = { ...lib.ovr }
      delete ovr[id]
      await g.saveLibrary({ ovr })
      toast(t('Original wiederhergestellt'))
    },
  })

  const mutate = async (fn) => {
    const d = clone(s)
    fn(d)
    if (!d.custom) d.adjusted = true
    await storeSchedule(g, d)
  }

  const weekComment = () => {
    if (col.water) return toast(t('In der Anzucht hat dieses Schema keine eigene Spalte – nutze den Kommentar zum Schema.'))
    const weeks = sameColWeeks(s, col, plan)
    const saveNote = async (text) => {
      await mutate((d) => {
        ensureRows(d)
        ;(col.ph === 'v' ? d.notes.v : d.notes.b)[col.i] = text
        if (!anyRow(d, 'notes')) delete d.notes
        if (!anyRow(d, 'ec')) delete d.ec
      })
      toast(text ? t('Kommentar gespeichert') : t('Kommentar gelöscht'))
    }
    g.open({
      kind: 'text', title: t('Kommentar zur Woche'), subtitle: `${phaseLabel(pos.phase, pos.week)} · ${t(schedLabel(s))}`,
      hint: weeks.length > 1 ? t('Gilt für {weeks}, weil das Schema dort dieselbe Spalte verwendet.', { weeks: weeks.join(', ') }) : '',
      value: weekNote || '', maxLength: 200, placeholder: t('z. B. CalMag +0,5 ml/L, entlauben, Drain prüfen …'),
      onSave: saveNote, onDelete: () => saveNote(''),
    })
  }
  const schedComment = () => g.open({
    kind: 'text', title: t('Kommentar zum Schema'), subtitle: t(schedLabel(s)), value: s.comment || '', maxLength: 1000, tall: true,
    placeholder: t('z. B. Erfahrungen, Wasserwerte, was du nächstes Mal anders machst …'),
    onSave: async (text) => {
      await mutate((d) => {
        if (text) d.comment = text
        else delete d.comment
      })
      toast(text ? t('Kommentar gespeichert') : t('Kommentar entfernt'))
    },
  })

  return (
    <>
      <div className="gp-cols">
        <div className="gp-col">
          <Block title={t('Düngeschema')} hint={t('pro Liter Gießwasser')}>
            <div className="panel gp-pad stack">
              <Field label={t('Hersteller & Schema')}>
                <select className="input" value={s.id} onChange={(e) => update({ sched: e.target.value })}>
                  {groups.map((gr) => (
                    <optgroup key={gr.name} label={gr.name}>
                      {gr.items.map((x) => <option key={x.id} value={x.id}>{t(schedLabel(x))}</option>)}
                    </optgroup>
                  ))}
                </select>
              </Field>
              <p className="small muted" style={{ margin: 0 }}>
                {t(s.brand)}{s.medium ? ` · ${t(s.medium)}` : ''} · {!s.flushN
                  ? t('ausgelegt auf {veg} Wo. Wachstum + {flower} Wo. Blüte.', { veg: s.vegN, flower: s.bloomN })
                  : s.flushN === 1
                    ? t('ausgelegt auf {veg} Wo. Wachstum + {flower} Wo. Blüte (inkl. {flush} Spülwoche).', { veg: s.vegN, flower: s.bloomN, flush: s.flushN })
                    : t('ausgelegt auf {veg} Wo. Wachstum + {flower} Wo. Blüte (inkl. {flush} Spülwochen).', { veg: s.vegN, flower: s.bloomN, flush: s.flushN })}
                {s.adjusted ? <b> {t('Von dir angepasst.')}</b> : null}
              </p>
              {diff ? (
                <div className="notice frost">
                  {t('Dein Plan hat {planVeg} + {planFlower} Wochen, das Schema {veg} + {flower}. Die Werte werden automatisch zugeordnet.', {
                    planVeg: plan.vegWeeks, planFlower: plan.floWeeks, veg: s.vegN, flower: s.bloomN,
                  })}
                  <div className="row gp-gap">
                    <button type="button" className="btn small" onClick={() => {
                      update((data) => clampWeek({ ...data, vegWeeks: clampInt(s.vegN, 1, 12, data.vegWeeks), floWeeks: clampInt(s.bloomN, 4, 16, data.floWeeks) }))
                      toast(t('Plan: {veg} Wochen Wachstum + {flower} Wochen Blüte', { veg: clampInt(s.vegN, 1, 12, plan.vegWeeks), flower: clampInt(s.bloomN, 4, 16, plan.floWeeks) }))
                    }}>{t('Plan auf {veg} + {flower} Wochen umstellen', { veg: s.vegN, flower: s.bloomN })}</button>
                  </div>
                </div>
              ) : null}
              {hasMissing(s) ? (
                <div className="notice"><b>{t('Unvollständig:')}</b> {t('Für einige Produkte fehlen Mengen (?). Tippe auf „Schema anpassen“ und trag die Werte aus deiner Packungsbeilage ein.')}</div>
              ) : null}
              <div className="row">
                <button type="button" className="btn primary" onClick={() => openEditor(s)}>{t('Schema anpassen')}</button>
                <button type="button" className="btn" onClick={() => openEditor(newCustomFrom(s))}>{t('Als neues Schema speichern')}</button>
                <button type="button" className="btn" onClick={() => openEditor(newBlank())}>{t('Neues leeres Schema')}</button>
                {s.adjusted ? (
                  <button type="button" className="btn danger" onClick={() => g.open({
                    kind: 'confirm', title: t('Original wiederherstellen?'), okLabel: t('Wiederherstellen'),
                    text: t('Deine Änderungen an diesem Schema – auch Farben und Kommentare – werden verworfen.'),
                    onOk: async () => {
                      const ovr = { ...lib.ovr }
                      delete ovr[s.id]
                      await g.saveLibrary({ ovr })
                      toast(t('Original wiederhergestellt'))
                    },
                  })}>{t('Original wiederherstellen')}</button>
                ) : null}
              </div>
            </div>
          </Block>
        </div>
        <div className="gp-col">
          <Block title={phaseLabel(pos.phase, pos.week)} hint={`${num(plan.liters, 2)} L · ${plan.strength} %`}>
            <div className="panel">
              <MixRows plan={plan} sched={s} pos={pos} />
              <div className="gp-pad gp-foot">
                <button type="button" className="btn gp-wide" disabled={!!col.water} onClick={weekComment}>
                  {weekNote ? t('Kommentar zu dieser Woche bearbeiten') : t('Kommentar zu dieser Woche')}
                </button>
              </div>
            </div>
          </Block>
        </div>
      </div>

      <Block title={t('Kompletter Plan')} hint={t('seitlich scrollen →')}>
        <div className="panel">
          <PlanTable g={g} sched={s} />
          <div className="gp-tip">
            {t('Produktnamen antippen, um eine Flasche aus- oder einzublenden. Werte, Farben, Produkte, Ziel-EC und Kommentare änderst du über „Schema anpassen“.')}
            {' '}{t('{w} = Wachstumswoche, {b} = Blütewoche, {q} = Wert fehlt, {pen} = Kommentar.', { w: <b>W</b>, b: <b>B</b>, q: <b>?</b>, pen: <b>✎</b> })}
          </div>
          <div className="gp-tip"><Rich text={t(MIX_ORDER[tipsKey] || MIX_ORDER.custom)} /></div>
        </div>
      </Block>

      <div className="gp-cols">
        <div className="gp-col">
          <Block title={t('Kommentar zum Schema')}>
            <div className="panel">
              <div className="gp-pad gp-prewrap">
                {s.comment || <span className="muted">{t('Noch kein Kommentar – z. B. Erfahrungen, Wasserwerte oder was du beim nächsten Grow anders machst.')}</span>}
              </div>
              <div className="gp-pad gp-foot"><button type="button" className="btn gp-wide" onClick={schedComment}>{t('Kommentar bearbeiten')}</button></div>
            </div>
          </Block>
        </div>
        <div className="gp-col">
          <Block title={t('Hinweise')}>
            <div className="panel">
              <ul className="gp-tips">{TIPS[tipsKey].map((tip) => <li key={tip}><Rich text={t(tip)} /></li>)}</ul>
              {s.src ? <div className="gp-tip">{t(s.src)}{s.adjusted ? ` ${t('Werte von dir geändert.')}` : ''}</div> : null}
            </div>
          </Block>
        </div>
      </div>
    </>
  )
}

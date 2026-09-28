// Growplan: the feeding and grow plan of the Growplan app inside GrowDeck – one plan per
// tent, stored on the NAS and tied to the tent's devices.
import { useMemo, useState } from 'react'
import { api, toast, useStore } from '../store.js'
import { go, href } from '../router.js'
import Icon from '../components/Icon.jsx'
import { Field, Segmented } from '../components/ui.jsx'
import { useNow } from './Overview.jsx'
import { ENV, PHASE_LBL } from '../growplan/data.js'
import {
  agoText, currentPosition, envOf, harvestLabel, lastWatering, maxWeek, newEntry, phaseLabel, stageKey, stepPosition, todayISO,
} from '../growplan/engine.js'
import {
  assignPlan, createPlan, deletePlan, importIntoNewPlan, importMessage, useLibrary, usePlan,
} from '../growplan/usePlan.js'
import { Block, ConfirmDialog, useTent } from '../growplan/parts.jsx'
import {
  ChecklistEditor, EntryEditor, EnvEditor, LampEditor, PlantEditor, RestoreDialog, ScheduleEditor, TextDialog,
} from '../growplan/editors.jsx'
import Today from '../growplan/Today.jsx'
import Feed from '../growplan/Feed.jsx'
import Log from '../growplan/Log.jsx'
import ClimateTab from '../growplan/ClimateTab.jsx'
import Light from '../growplan/Light.jsx'
import { ArchiveBlock } from '../growplan/extras.jsx'
import { t } from '../i18n.js'
import '../styles/growplan.css'

const TABS = [
  { key: 'heute', label: t('Heute'), icon: 'gp_today' },
  { key: 'duenger', label: t('Dünger'), icon: 'gp_feed' },
  { key: 'log', label: t('Protokoll'), icon: 'gp_log' },
  { key: 'klima', label: t('Klima'), icon: 'gp_climate' },
  { key: 'licht', label: t('Licht'), icon: 'gp_light' },
]
const LAST_KEY = 'growdeck.growplan.last'

function remember(key) {
  try {
    localStorage.setItem(LAST_KEY, key)
  } catch {
    /* private mode */
  }
}
function remembered() {
  try {
    return localStorage.getItem(LAST_KEY) || ''
  } catch {
    return ''
  }
}

// Every tent is a target; plans without a tent come after them.
function useTargets() {
  const rooms = useStore((s) => s.rooms)
  const plans = useStore((s) => s.growplans)
  return useMemo(() => {
    const roomIds = new Set(rooms.map((r) => r.id))
    const list = rooms.map((room) => ({ key: room.id, label: room.name, room, plan: plans.find((p) => p.room_id === room.id) || null }))
    for (const plan of plans) {
      if (!plan.room_id || !roomIds.has(plan.room_id)) {
        list.push({ key: plan.id, label: rooms.length ? t('{name} (ohne Zelt)', { name: plan.name || t('Mein Grow') }) : plan.name || t('Mein Grow'), room: null, plan })
      }
    }
    if (!list.some((x) => !x.room) && !rooms.length) list.push({ key: 'neu', label: t('Mein Grow'), room: null, plan: null })
    return list
  }, [rooms, plans])
}

function initialData(room) {
  const stage = room?.stage
  if (stage === 'clone') return { phase: 'seed', week: 1 }
  if (stage === 'flower') return { phase: 'flower', week: 1 }
  if (stage === 'late') return { phase: 'flower', week: 6 }
  return { phase: 'veg', week: 1 }
}

function StartPanel({ target, targets }) {
  const [restore, setRestore] = useState(false)
  const [busy, setBusy] = useState(false)
  const loose = targets.filter((t) => !t.room && t.plan)
  const [take, setTake] = useState(loose[0]?.plan.id || '')
  const name = target.room ? target.room.name : t('Mein Grow')
  const done = (plan) => {
    if (!target.room) go(`growplan/${plan.id}`)
  }
  const create = async () => {
    setBusy(true)
    try {
      const plan = await createPlan({ roomId: target.room?.id || null, name, data: initialData(target.room) })
      toast(t('Growplan angelegt'))
      done(plan)
    } catch {
      /* toast shown */
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="panel gp-start">
      <h2>{target.room ? t('Growplan für {room}', { room: target.room.name }) : t('Growplan starten')}</h2>
      <p className="muted">
        {target.room
          ? t('Wochenplan mit Düngeschema, Klima- und Lichtzielen, Sicherheits-Checkliste und Gießprotokoll – wie in der Growplan-App, aber in GrowDeck gespeichert und mit den Geräten in {room} verbunden: Die Sollwerte stehen neben den Messwerten, die Übersicht zeigt Phase und Woche, und die Zeltsteuerung kann die Ziele übernehmen.', { room: target.room.name })
          : t('Wochenplan mit Düngeschema, Klima- und Lichtzielen, Sicherheits-Checkliste und Gießprotokoll – wie in der Growplan-App, aber in GrowDeck gespeichert und mit deinen Geräten verbunden: Die Sollwerte stehen neben den Messwerten, die Übersicht zeigt Phase und Woche, und die Zeltsteuerung kann die Ziele übernehmen.')}
      </p>
      <div className="row">
        <button type="button" className="btn primary" disabled={busy} onClick={create}>{t('Growplan anlegen')}</button>
        <button type="button" className="btn" disabled={busy} onClick={() => setRestore(true)}>{t('Backup aus der Growplan-App laden')}</button>
      </div>
      {target.room && loose.length ? (
        <div className="row gp-gap">
          <span className="small muted">{t('oder vorhandenen Plan übernehmen:')}</span>
          <select className="input gp-inline" value={take} onChange={(e) => setTake(e.target.value)} aria-label={t('Vorhandener Plan')}>
            {loose.map((x) => <option key={x.plan.id} value={x.plan.id}>{x.plan.name || t('Mein Grow')}</option>)}
          </select>
          <button type="button" className="btn small" disabled={busy || !take} onClick={async () => {
            setBusy(true)
            try {
              await assignPlan(take, target.room.id)
              toast(t('Plan gehört jetzt zu {room}', { room: target.room.name }))
            } catch {
              /* toast shown */
            } finally {
              setBusy(false)
            }
          }}>{t('Zuordnen')}</button>
        </div>
      ) : null}
      {restore ? (
        <RestoreDialog onClose={() => setRestore(false)}
          intro={t('Der neue Plan übernimmt Einstellungen, Pflanzen und Protokoll aus dem Backup, eigene Düngeschemata landen in der gemeinsamen Bibliothek.')}
          onImport={async (backup) => {
            const { plan, result } = await importIntoNewPlan({ roomId: target.room?.id || null, name, data: initialData(target.room), backup })
            toast(importMessage(result))
            done(plan)
          }} />
      ) : null}
    </div>
  )
}

function Hero({ g }) {
  const { plan, pos, current, log, today } = g
  const k = stageKey(pos.phase, pos.week, plan.floWeeks)
  const e = envOf(plan, k)
  const last = lastWatering(log)
  const harvest = harvestLabel(plan)
  const right = last ? t('Gegossen {ago}', { ago: agoText(last.date, today) }) : harvest ? t('Ernte etwa {date}', { date: harvest }) : ''
  const previewing = pos.phase !== current.phase || pos.week !== current.week
  return (
    <section className="panel gp-hero" aria-label={t('Woche des Plans')}>
      <div className="gp-stepper">
        <button type="button" aria-label={t('Woche zurück')} disabled={pos.phase === 'seed' && pos.week === 1} onClick={() => g.step(-1)}>
          <Icon name="prev" size={26} />
        </button>
        <div className="gp-mid" aria-live="polite">
          <div className="gp-phase">{t('{phase} · Woche', { phase: pos.phase === 'seed' ? t('Anzucht') : PHASE_LBL[pos.phase] })}</div>
          <div className="gp-week num">{pos.week}{pos.phase !== 'seed' ? <small>{t('von {n}', { n: maxWeek(pos.phase, plan) })}</small> : null}</div>
          <div className="gp-stage">{t(ENV[k].n)}</div>
        </div>
        <button type="button" aria-label={t('Woche vor')} disabled={pos.phase === 'flower' && pos.week >= plan.floWeeks} onClick={() => g.step(1)}>
          <Icon name="next" size={26} />
        </button>
      </div>
      <div className="gp-daybar" role="img" aria-label={t('{light} Stunden Licht, {dark} Stunden Dunkel', { light: e.h, dark: 24 - e.h })}>
        {Array.from({ length: 24 }, (_, i) => <i key={i} className={i < e.h ? 'on' : ''} />)}
      </div>
      <div className="gp-meta"><span>{t('Licht {on}/{off} h', { on: e.h, off: 24 - e.h })}</span><span>{right}</span></div>
      {previewing ? (
        <div className="gp-preview">
          <span>{t('Vorschau – laut Startdaten ist gerade {phase}.', { phase: phaseLabel(current.phase, current.week) })}</span>
          <button type="button" className="btn small" onClick={g.resetPreview}>{t('Zur aktuellen Woche')}</button>
        </div>
      ) : null}
    </section>
  )
}

function PlanAdmin({ g }) {
  const rooms = useStore((s) => s.rooms)
  const plans = useStore((s) => s.growplans)
  const { summary, tent } = g
  const free = rooms.filter((r) => !plans.some((p) => p.room_id === r.id))
  const [room, setRoom] = useState(free[0]?.id || '')
  const [name, setName] = useState(summary.name || '')
  const [busy, setBusy] = useState(false)
  const run = async (fn) => {
    setBusy(true)
    try {
      await fn()
    } catch {
      /* toast shown */
    } finally {
      setBusy(false)
    }
  }
  return (
    <Block title={t('Plan & Zelt')}>
      <div className="panel gp-pad stack">
        {tent.room ? (
          <>
            <p className="small" style={{ margin: 0 }}>
              {t('Dieser Plan gehört zu {room}. Die Übersicht zeigt dort Phase und Woche, die Verläufe nutzen sein VPD-Band, und die Zeltsteuerung kann seine Zielwerte übernehmen.', {
                room: <b>{tent.room.name}</b>,
              })}
            </p>
            <div className="row">
              <button type="button" className="btn small" disabled={busy} onClick={() => run(async () => {
                await assignPlan(summary.id, null)
                toast(t('Plan vom Zelt gelöst'))
                go(`growplan/${summary.id}`)
              })}>{t('Vom Zelt lösen')}</button>
            </div>
          </>
        ) : (
          <>
            <Field label={t('Name des Plans')}>
              <input className="input" maxLength={60} value={name} onChange={(e) => setName(e.target.value)}
                onBlur={() => name.trim() && name.trim() !== summary.name && run(() => g.rename(name.trim()))} />
            </Field>
            {rooms.length ? (
              free.length ? (
                <div className="row">
                  <select className="input gp-inline" value={room} aria-label={t('Zelt')} onChange={(e) => setRoom(e.target.value)}>
                    {free.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                  <button type="button" className="btn small" disabled={busy || !room} onClick={() => run(async () => {
                    await assignPlan(summary.id, room)
                    toast(t('Plan dem Zelt zugeordnet'))
                    go(`growplan/${room}`)
                  })}>{t('Zelt zuordnen')}</button>
                </div>
              ) : <p className="small muted" style={{ margin: 0 }}>{t('Alle Zelte haben schon einen Growplan. Löse dort einen Plan, um diesen zuzuordnen.')}</p>
            ) : (
              <p className="small muted" style={{ margin: 0 }}>
                {t('Ohne Raum gilt dieser Plan für alle Geräte. Lege unter {options} Räume an, um für jedes Zelt einen eigenen Plan zu führen – diesen Plan kannst du dann einem Zelt zuordnen.', {
                  options: <a href={href('options')}>{t('Optionen')}</a>,
                })}
              </p>
            )}
          </>
        )}
        <button type="button" className="btn danger small" style={{ justifySelf: 'start' }} onClick={() => g.open({
          kind: 'confirm', title: t('Growplan löschen?'), okLabel: t('Löschen'),
          text: summary.entries === 1
            ? t('Einstellungen, Pflanzen und {n} Protokolleintrag werden gelöscht. Eigene Düngeschemata bleiben erhalten. Mach vorher ein Backup, wenn du den Plan behalten willst.', { n: summary.entries })
            : t('Einstellungen, Pflanzen und {n} Protokolleinträge werden gelöscht. Eigene Düngeschemata bleiben erhalten. Mach vorher ein Backup, wenn du den Plan behalten willst.', { n: summary.entries }),
          onOk: async () => {
            await deletePlan(summary.id)
            toast(t('Growplan gelöscht'))
            go('growplan')
          },
        })}>{t('Growplan löschen')}</button>
      </div>
    </Block>
  )
}

function PlanView({ target, targets, lib, saveLibrary, tab, today, now }) {
  const planState = usePlan(target.plan.id)
  const summary = planState.plan || target.plan
  const data = planState.plan?.data
  const tent = useTent(summary, now)
  const [preview, setPreview] = useState(null)
  const [dialog, setDialog] = useState(null)
  if (planState.error && !data) return <div className="notice alert">{t(planState.error)}</div>
  if (!data) return <p className="muted">{t('Lade Growplan …')}</p>

  const current = currentPosition(data, today)
  const pos = preview && current.auto && (preview.phase !== current.phase || preview.week !== current.week) ? preview : current
  const { update } = planState
  const close = () => setDialog(null)
  const moveTo = (next) => {
    if (current.auto) setPreview(next.phase === current.phase && next.week === current.week ? null : next)
    else update(next)
  }
  const g = {
    planId: summary.id, summary, plan: data, lib, log: planState.log, today, now, pos, current, tent,
    title: tent.room?.name || summary.name || t('Mein Grow'),
    update, saveLibrary, saveEntry: planState.saveEntry, deleteEntry: planState.deleteEntry, clearLog: planState.clearLog,
    flush: planState.flush, hasPending: planState.hasPending, rename: planState.rename,
    open: setDialog,
    newEntry: (plantId) => setDialog({ kind: 'entry', entry: newEntry(data, lib, pos, today, plantId), isNew: true }),
    editEntry: (entry) => setDialog({ kind: 'entry', entry, isNew: false }),
    step: (dir) => moveTo(stepPosition(pos, dir, data)),
    setPhase: (phase) => moveTo({ phase, week: 1 }),
    resetPreview: () => setPreview(null),
  }
  const routeKey = target.key
  const Tab = { heute: Today, duenger: Feed, log: Log, klima: ClimateTab, licht: Light }[tab] || Today

  return (
    <>
      <Hero g={g} />
      <nav className="gp-tabs" aria-label={t('Bereiche des Growplans')}>
        {TABS.map((t) => (
          <a key={t.key} href={href(`growplan/${routeKey}?tab=${t.key}`)} aria-current={tab === t.key ? 'page' : undefined}>
            <Icon name={t.icon} size={20} /><span>{t.label}</span>
          </a>
        ))}
      </nav>
      <Tab g={g} extra={<><ArchiveBlock g={g} /><PlanAdmin g={g} key={summary.id} /></>} />
      <p className="small muted gp-footnote">
        {t('Alle Angaben sind Richtwerte für den legalen Eigenanbau und ersetzen keine Messung im Zelt. Produktnamen gehören den jeweiligen Herstellern; die Düngeschemata stammen aus der Growplan-App und den Feedcharts der Hersteller.')}
      </p>

      {dialog?.kind === 'entry' ? (
        <EntryEditor entry={dialog.entry} isNew={dialog.isNew} plan={data} lib={lib} probes={tent.probes} tent={tent}
          onSave={async (entry) => {
            await planState.saveEntry(entry)
            // a watering taken over from the soil probes is done
            if (dialog.suggestion) {
              api(`/growplan/plans/${encodeURIComponent(summary.id)}/suggestions/${encodeURIComponent(dialog.suggestion)}`,
                { method: 'DELETE', quiet: true }).catch(() => {})
            }
          }}
          onDelete={planState.deleteEntry} onClose={close} />
      ) : null}
      {dialog?.kind === 'plant' ? (
        <PlantEditor plant={dialog.plant} isNew={dialog.isNew} plan={data} onClose={close}
          onSave={(p) => update((d) => ({ ...d, plants: d.plants.some((x) => x.id === p.id) ? d.plants.map((x) => (x.id === p.id ? p : x)) : [...d.plants, p] }))}
          onRemove={(id) => update((d) => ({ ...d, plants: d.plants.map((x) => (x.id === id ? { ...x, gone: true } : x)) }))} />
      ) : null}
      {dialog?.kind === 'sched' ? (
        <ScheduleEditor sched={dialog.sched} exists={dialog.exists} isOverride={dialog.isOverride}
          onSave={dialog.onSave} onRemove={dialog.onRemove} onReset={dialog.onReset} onClose={close} />
      ) : null}
      {dialog?.kind === 'text' ? <TextDialog {...dialog} onClose={close} /> : null}
      {dialog?.kind === 'env' ? (
        <EnvEditor plan={data} current={stageKey(pos.phase, pos.week, data.floWeeks)} onSave={(envOv) => update({ envOv })} onClose={close} />
      ) : null}
      {dialog?.kind === 'lamp' ? <LampEditor lamp={data.lamp} onSave={(lamp) => update({ lamp })} onClose={close} /> : null}
      {dialog?.kind === 'check' ? <ChecklistEditor lib={lib} onChange={(patch) => saveLibrary(patch).catch(() => {})} onClose={close} /> : null}
      {dialog?.kind === 'restore' ? (
        <RestoreDialog onClose={close} onImport={async (backup) => {
          const result = await planState.importBackup(backup)
          toast(importMessage(result))
        }} />
      ) : null}
      {dialog?.kind === 'confirm' ? (
        <ConfirmDialog title={dialog.title} text={dialog.text} okLabel={dialog.okLabel} onClose={close}
          onOk={async () => {
            try {
              await dialog.onOk()
              close()
            } catch {
              /* toast shown */
            }
          }} />
      ) : null}
    </>
  )
}

export default function Growplan({ id, query }) {
  const targets = useTargets()
  const [lib, saveLibrary] = useLibrary()
  const offset = useStore((s) => s.serverOffset)
  const now = useNow(60000) + offset
  const today = todayISO(new Date(now))
  const wanted = id || remembered()
  const target = targets.find((t) => t.key === wanted || t.plan?.id === wanted)
    || targets.find((t) => t.plan) || targets[0]
  const tab = TABS.some((t) => t.key === query?.get('tab')) ? query.get('tab') : 'heute'
  if (target && id) remember(target.key)
  const name = target?.room?.name || target?.plan?.name || ''

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Growplan</h1>
          <p>{name ? t('Düngeplan, Klima, Licht und Gießprotokoll für {name}.', { name }) : t('Düngeplan, Klima, Licht und Gießprotokoll.')}</p>
        </div>
        {targets.length > 1 ? (
          <div className="row page-tools">
            <a className="btn ghost small" href={href('archiv')}>{t('Archiv')}</a>
            <span className="small muted">{t('Zelt')}</span>
            {targets.length <= 4 ? (
              <Segmented label={t('Zelt oder Plan')} value={target.key} onChange={(key) => go(`growplan/${key}?tab=${tab}`)}
                options={targets.map((t) => ({ key: t.key, label: t.label }))} />
            ) : (
              <select className="input gp-inline" value={target.key} aria-label={t('Zelt oder Plan')} onChange={(e) => go(`growplan/${e.target.value}?tab=${tab}`)}>
                {targets.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
            )}
          </div>
        ) : (
          <div className="row page-tools"><a className="btn ghost small" href={href('archiv')}>{t('Archiv')}</a></div>
        )}
      </div>
      {!lib ? <p className="muted">{t('Lade Growplan …')}</p>
        : !target?.plan ? <StartPanel target={target} targets={targets} />
          : <PlanView key={target.plan.id} target={target} targets={targets} lib={lib} saveLibrary={saveLibrary} tab={tab} today={today} now={now} />}
    </>
  )
}

import { Fragment, useEffect, useMemo, useState } from 'react'
import { api, toast, useStore } from '../store.js'
import { OverrideButton } from '../components/Override.jsx'
import { href } from '../router.js'
import { DIGITS, fmt, sensorText, STAGES, VENDORS, vpd } from '../format.js'
import { Photoperiod, Readout, VpdChart } from '../components/Climate.jsx'
import ControlRow from '../components/ControlRow.jsx'
import { Empty, Fold, Modal, Segmented, useRemembered } from '../components/ui.jsx'
import ClimateTrend, {
  loadTrendRange, saveTrendRange, trailFrom, TREND_RANGES, trendQuery, trendSources, useClimateHistory,
} from '../components/ClimateTrend.jsx'
import { RoomControlEditor, RoomControlPanel } from '../editors/RoomControl.jsx'
import { agoText, controlTargets, harvestLabel, phaseLabel, todayISO } from '../growplan/engine.js'
import { PHASE_LBL } from '../growplan/data.js'
import { LOCALE, t } from '../i18n.js'
import {
  controlDeviations, deviationText, isDayNow, judge, lightHours, rangeText, ratioText, sameBand, targetLegend, tentTargets,
} from '../targets.js'

export function useNow(interval = 30000) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), interval)
    return () => clearInterval(id)
  }, [interval])
  return now
}

export function climateSource(room, allDevices, roomDevices) {
  let device = room.climate_device_id ? allDevices[room.climate_device_id] : null
  if (!device) {
    device = roomDevices.find((d) => d.sensors.some((s) => s.kind === 'temp') && d.sensors.some((s) => s.kind === 'humi'))
  }
  if (!device) return { device: null }
  const pick = (kind) => {
    const candidates = device.sensors.filter((s) => s.kind === kind && (!room.climate_group || s.group === room.climate_group))
    return candidates.find((s) => !s.key.includes('.')) || candidates[0] ||
      device.sensors.find((s) => s.kind === kind && !s.key.includes('.')) || null
  }
  return { device, temp: pick('temp'), humi: pick('humi'), vpd: pick('vpd'), co2: pick('co2'), ppfd: pick('ppfd') }
}

const HIDDEN_IN_SUMMARY = new Set(['rssi'])
// kinds whose unit alone says what they are; all others get their label
const SELF_EXPLAINING = new Set(['temp', 'humi', 'vpd', 'co2', 'ppfd', 'soil_temp', 'soil_moisture', 'soil_ec', 'water'])

function groupSensors(sensors) {
  const groups = []
  for (const s of sensors) {
    const name = s.group || t('Messwerte')
    let group = groups.find((g) => g.name === name)
    if (!group) groups.push((group = { name, items: [] }))
    group.items.push(s)
  }
  return groups
}

// Devices of a room with their readings and the state of their outputs. Only shows what the
// devices do; switching and adjusting happens in the device details.
export function DevicePanel({ devices, skipSensors = new Set() }) {
  return (
    <div className="panel" style={{ marginTop: 14 }}>
      {devices.map((d) => {
        const sensors = d.sensors.filter((s) => !HIDDEN_IN_SUMMARY.has(s.kind) && !skipSensors.has(`${d.id}|${s.key}`) && s.key !== 'core_temp')
        return (
          <div className={`device-block ${d.online ? '' : 'offline'}`} key={d.id}>
            <div className="device-head">
              <a href={href(`devices/${d.id}`)}>{d.name}</a>
              <span className="vendor">{VENDORS[d.vendor]} {t(d.model)}</span>
              {!d.online ? <span className="chip alert">{t('Offline')}</span> : null}
              {d.simulated ? <span className="chip">{t('Simuliert')}</span> : null}
              {d.controls.some((c) => !c.extra?.empty && c.features?.length) ? (
                <a className="btn ghost small device-operate" href={href(`devices/${d.id}`)}>{t('Bedienen')}</a>
              ) : null}
            </div>
            {sensors.length ? (
              <div className="device-sensors">
                {groupSensors(sensors).map((g) => (
                  <span key={g.name}>
                    {g.name ? <span className="grp">{t(g.name)}</span> : null}
                    {g.items.map((s) => (
                      <Fragment key={s.key}>
                        {' '}
                        <span title={t(s.label)}>{SELF_EXPLAINING.has(s.kind) ? null : `${t(s.label)} `}<b>{sensorText(s) ?? fmt(s.value, DIGITS[s.kind] ?? 1)}</b>{sensorText(s) ? '' : ` ${s.unit}`}</span>
                      </Fragment>
                    ))}
                  </span>
                ))}
              </div>
            ) : null}
            {d.kind === 'camera' ? (
              <div className="device-sensors">{t('Kamera: Livebild über RTSP im Heimnetz, Zugangsdaten in den Gerätedetails.')}</div>
            ) : null}
            {d.controls.length ? (
              <div className="controls">
                {d.controls.filter((c) => !c.extra?.empty).map((c) => <ControlRow key={c.id} device={d} control={c} readOnly />)}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

// Target of one readout for now (day or night) with its state in words: "Ziel 22–26 · zu warm".
function readoutTarget(key, value, targets, day) {
  const pair = targets?.[key]
  if (!pair) return {}
  let band
  let label
  if (key === 'ppfd') {
    if (!day) return { hint: t('Ziel {range} bei Licht', { range: rangeText(key, pair) }) }
    band = pair
    label = t('Ziel {value}', { value: rangeText(key, band) })
  } else {
    band = day ? pair.day : pair.night
    if (!band) return {}
    const split = !sameBand(pair.day, pair.night)
    const range = rangeText(key, band)
    label = !split ? t('Ziel {value}', { value: range }) : day ? t('Ziel Tag {range}', { range }) : t('Ziel Nacht {range}', { range })
  }
  const j = judge(key, value, band)
  if (!j) return { hint: label }
  return { tone: j.tone, hint: <>{label} · <b>{j.inside ? t('passt') : j.word}</b></> }
}

function GrowplanStrip({ gp, routeKey, today, room, control, targets, implicit, onAdopt }) {
  const status = gp.status
  const last = status.last_watering
  const harvest = harvestLabel(gp.data)
  const planHours = targets.plan?.light_hours
  const roomHours = lightHours(room)
  const lightDiffers = planHours != null && Math.abs(planHours - roomHours) >= 0.5
  const deviations = controlDeviations(control, targets)
  return (
    <div className="gp-strip">
      <div className="gp-strip-row">
        <span>
          <b>{t(status.stage_name)}</b>
          {' · '}
          {!last ? t('noch keine Gießung eingetragen')
            : last.liters ? t('gegossen {ago} ({liters} L)', { ago: t(agoText(last.date, today)), liters: fmt(last.liters, 1) })
              : t('gegossen {ago}', { ago: t(agoText(last.date, today)) })}
          {harvest && status.phase === 'flower' ? ` · ${t('Ernte etwa {date}', { date: harvest })}` : ''}
        </span>
        <a className="btn small" href={href(`growplan/${routeKey}`)}>Growplan</a>
      </div>
      {lightDiffers ? (
        <div className="gp-deviation">
          <p>
            <b>{t('Lichtzeit weicht ab:')}</b>{' '}
            {implicit
              ? t('Der Growplan sieht {plan} Stunden Licht vor, unter Optionen sind {room} eingestellt.', { plan: ratioText(planHours), room: ratioText(roomHours) })
              : t('Der Growplan sieht {plan} Stunden Licht vor, im Zelt sind {room} eingestellt.', { plan: ratioText(planHours), room: ratioText(roomHours) })}
          </p>
          <a className="btn small" href={href('options')}>{t('Lichtzeiten ändern')}</a>
        </div>
      ) : null}
      {deviations.length ? (
        <div className="gp-deviation">
          <p>
            <b>{t('Zeltsteuerung regelt nicht nach dem Growplan:')}</b>{' '}
            {deviations.map((d, i) => (
              <Fragment key={`${d.key}-${d.phase}`}>
                <span className="nowrap">{deviationText(d)}{i < deviations.length - 1 ? ',' : '.'}</span>{' '}
              </Fragment>
            ))}
          </p>
          <button type="button" className="btn small" onClick={onAdopt}>{t('Growplan-Ziele übernehmen')}</button>
        </div>
      ) : null}
    </div>
  )
}

// Switch the room control to the Growplan's targets (the same switch as in its editor).
function AdoptTargetsDialog({ room, gp, today, byVpd, onClose }) {
  const [busy, setBusy] = useState(false)
  const goal = controlTargets(gp.data, today)
  const adopt = async () => {
    setBusy(true)
    try {
      const current = await api(`/rooms/${room.id}/control`, { quiet: true })
      await api(`/rooms/${room.id}/control`, { method: 'PUT', body: { ...current.config, plan_targets: true }, quiet: true })
      toast(t('Die Zeltsteuerung übernimmt jetzt die Ziele aus dem Growplan.'))
      onClose()
    } catch (err) {
      toast(err.message || t('Das hat nicht geklappt.'), 'alert')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title={t('Ziele aus dem Growplan übernehmen')} onClose={onClose}
      actions={<>
        <button type="button" className="btn ghost" onClick={onClose}>{t('Abbrechen')}</button>
        <button type="button" className="btn primary" disabled={busy} onClick={adopt}>{t('Übernehmen')}</button>
      </>}>
      <p style={{ margin: 0 }}>
        {t('Die Zeltsteuerung von {room} regelt dann Woche für Woche nach dem Growplan.', { room: room.name })}{' '}
        {byVpd
          ? t('Diese Woche ({stage}): Temperatur {day} / {night} °C ± {tol}, VPD {vday} / {vnight} kPa ± {vtol} (Tag / Nacht).', {
            stage: t(goal.stage_name), day: fmt(goal.temp.day, 1), night: fmt(goal.temp.night, 1), tol: fmt(goal.temp.tolerance, 1),
            vday: fmt(goal.vpd.day, 2), vnight: fmt(goal.vpd.night, 2), vtol: fmt(goal.vpd.tolerance, 2) })
          : t('Diese Woche ({stage}): Temperatur {day} / {night} °C ± {tol}, Luftfeuchte {hday} % ± {htol} (Tag / Nacht).', {
            stage: t(goal.stage_name), day: fmt(goal.temp.day, 1), night: fmt(goal.temp.night, 1), tol: fmt(goal.temp.tolerance, 1),
            hday: fmt(goal.humi.day, 0), htol: fmt(goal.humi.tolerance, 0) })}
      </p>
      <p className="muted small" style={{ margin: '10px 0 0' }}>
        {t('Zurück auf eigene Werte geht jederzeit in der Zeltsteuerung unter „Ziele“.')}
      </p>
    </Modal>
  )
}

// Climate of a tent right now: where the values come from, the values and the targets.
function tentClimate({ room, devices, allDevices, control, gp, now }) {
  const source = climateSource(room, allDevices, devices)
  const averaged = control?.readings?.sources?.length > 1 ? control.readings : null
  const stage = STAGES[room.stage] || STAGES.veg
  const today = todayISO(new Date(now))
  const targets = tentTargets({ gp, control, stage, today })
  const day = isDayNow(room, control, now)
  const temp = averaged?.temp ?? source.temp?.value ?? null
  const humi = averaged?.humi ?? source.humi?.value ?? null
  const vpdValue = averaged ? vpd(temp, humi) : source.vpd?.value ?? vpd(temp, humi)
  return { source, averaged, stage, today, targets, day, temp, humi, vpdValue }
}

const TONE_RANK = { good: 0, warn: 1, bad: 2 }

// Worst state of temperature, humidity and VPD against the targets of now.
function climateTone(c) {
  let worst = null
  for (const [key, value] of [['temp', c.temp], ['humi', c.humi], ['vpd', c.vpdValue]]) {
    const band = c.targets?.[key]?.[c.day ? 'day' : 'night']
    const j = judge(key, value, band)
    if (j && (worst == null || TONE_RANK[j.tone] > TONE_RANK[worst])) worst = j.tone
  }
  return worst
}

const TONE_TEXT = { good: t('Klima passt'), warn: t('Klima knapp daneben'), bad: t('Klima deutlich daneben') }

// One card per tent at the top of the overview: the most important numbers at a glance, and
// a tap shows that tent below.
function TentCards({ sections, selected, onSelect }) {
  return (
    <div className="tent-cards" role="tablist" aria-label={t('Zelte')}>
      {sections.map((sec) => {
        const c = sec.climate
        const tone = c ? climateTone(c) : null
        const offline = sec.devices.filter((d) => !d.online).length
        const phase = sec.gp ? (sec.gp.status.phase === 'seed' ? t(phaseLabel(sec.gp.status.phase, sec.gp.status.week))
          : `${PHASE_LBL[sec.gp.status.phase]} · ${t('Woche {week}', { week: sec.gp.status.week })}`) : null
        return (
          <button key={sec.id} type="button" role="tab" aria-selected={selected === sec.id}
            className={`tent-card ${selected === sec.id ? 'active' : ''}`} onClick={() => onSelect(sec.id)}>
            <span className="tent-card-head">
              <b>{sec.name}</b>
              {tone ? <span className={`tone-dot ${tone}`} title={TONE_TEXT[tone]} aria-label={TONE_TEXT[tone]} /> : null}
            </span>
            {c && c.temp != null ? (
              <span className="tent-card-values num">
                {fmt(c.temp, 1)} °C · {fmt(c.humi, 0)} % · {fmt(c.vpdValue, 2)} kPa
              </span>
            ) : (
              <span className="tent-card-values muted">{sec.devices.length === 1 ? t('1 Gerät') : t('{n} Geräte', { n: sec.devices.length })}</span>
            )}
            <span className="tent-card-foot">
              {phase ? <span>{phase}</span> : null}
              {offline ? <span className="tent-card-warn">{t('{n} offline', { n: offline })}</span> : null}
            </span>
          </button>
        )
      })}
    </div>
  )
}

// What needs a look right now, gathered from all pages: triggered alarms, recognised
// waterings, devices without data and changes still waiting for a device.
function Attention({ devices, rooms, growplans }) {
  const alarmStatus = useStore((s) => s.alarmStatus)
  const watering = useStore((s) => s.watering)
  const items = []
  const firing = Object.values(alarmStatus || {}).filter((a) => a?.firing).length
  if (firing) {
    items.push({ key: 'alarms', tone: 'alert', text: firing === 1 ? t('1 Alarm ist ausgelöst.') : t('{n} Alarme sind ausgelöst.', { n: firing }),
      href: href('alarms'), action: t('Ansehen') })
  }
  for (const plan of growplans) {
    const found = watering?.suggestions?.[plan.id] || []
    if (!found.length) continue
    const room = rooms.find((r) => r.id === plan.room_id)
    items.push({ key: `water-${plan.id}`, tone: 'frost',
      text: t('{tent}: Gießung erkannt – ins Protokoll eintragen?', { tent: room?.name || plan.name || 'Growplan' }),
      href: href(`growplan/${plan.room_id ? plan.room_id : plan.id}`), action: t('Zum Growplan') })
  }
  const offline = devices.filter((d) => !d.online)
  if (offline.length) {
    items.push({ key: 'offline', tone: 'warn',
      text: offline.length === 1 ? t('{name} sendet keine Daten.', { name: offline[0].name }) : t('{n} Geräte senden keine Daten.', { n: offline.length }),
      href: href(offline.length === 1 ? `devices/${offline[0].id}` : 'devices'), action: t('Prüfen') })
  }
  const waiting = devices.filter((d) => Object.keys(d.pending || {}).length)
  if (waiting.length) {
    items.push({ key: 'pending', tone: 'frost',
      text: t('Änderungen warten auf {names}.', { names: waiting.map((d) => d.name).join(', ') }),
      href: href(`devices/${waiting[0].id}`), action: t('Ansehen') })
  }
  if (!items.length) return null
  return (
    <section className="attention" aria-label={t('Braucht deine Aufmerksamkeit')}>
      {items.map((item) => (
        <div className={`attention-item ${item.tone}`} key={item.key}>
          <span className={`tone-dot ${item.tone === 'alert' ? 'bad' : item.tone === 'warn' ? 'warn' : 'info'}`} aria-hidden="true" />
          <span className="attention-text">{item.text}</span>
          <a className="btn small" href={item.href}>{item.action}</a>
        </div>
      ))}
    </section>
  )
}

// One line about the devices of a tent for the closed device list.
function devicesSummary(devices) {
  const outputs = devices.flatMap((d) => d.controls.filter((c) => !c.extra?.empty && c.on != null))
  const on = outputs.filter((c) => c.on).length
  const offline = devices.filter((d) => !d.online).length
  const parts = [devices.length === 1 ? t('1 Gerät') : t('{n} Geräte', { n: devices.length })]
  if (outputs.length) parts.push(t('{on} von {total} Ausgängen an', { on, total: outputs.length }))
  if (offline) parts.push(t('{n} offline', { n: offline }))
  return parts.join(' · ')
}

function RoomSection({ room, devices, allDevices, now, control, trendRange, onTrendRange, gp, implicit = false }) {
  const [editing, setEditing] = useState(false)
  const [adopting, setAdopting] = useState(false)
  // one set of targets for readouts, charts and the VPD diagram: Growplan, room control or phase
  const { source, averaged, stage, today, targets, day, temp, humi, vpdValue } = tentClimate({ room, devices, allDevices, control, gp, now })
  const band = targets.vpd ? targets.vpd[day ? 'day' : 'night'] : null
  const refs = trendSources({ roomDevices: devices, source, averaged, control })
  const history = useClimateHistory(trendQuery(refs, room), trendRange)
  const trail = useMemo(() => trailFrom(history.data), [history.data])
  const gpKey = gp ? (gp.room_id ? room.id : gp.id) : null
  const historySeries = [...refs.temp, ...refs.humi, ...refs.vpd]
  const ppfdValue = source.ppfd?.value ?? null
  const skip = new Set(
    ['temp', 'humi', 'vpd', 'co2', 'ppfd'].filter((k) => source[k]).map((k) => `${source.device.id}|${source[k].key}`),
  )
  const offline = source.device && !source.device.online
  return (
    <section className="room" aria-labelledby={`room-${room.id}`}>
      <div className="room-head">
        <h2 id={`room-${room.id}`}>{room.name}</h2>
        {gp ? (
          <a className="chip leaf" href={href(`growplan/${gpKey}`)} title={t('Zum Growplan')}>
            {gp.status.phase === 'seed' ? t(phaseLabel(gp.status.phase, gp.status.week))
              : `${PHASE_LBL[gp.status.phase]} · ${t('Woche {week} von {max}', { week: gp.status.week, max: gp.status.max_week })}`}
          </a>
        ) : implicit ? null : <span className="chip">{stage.label}</span>}
        <span className="small muted">
          {averaged ? t('Mittelwert aus {n} Sensoren', { n: averaged.sources.length })
            : !source.device ? t('Kein Gerät mit Temperatur und Luftfeuchte im Raum')
              : offline ? t('Klima von {name} (offline)', { name: source.device.name }) : t('Klima von {name}', { name: source.device.name })}
        </span>
        {!control && !implicit ? (
          <button type="button" className="btn ghost small room-action" onClick={() => setEditing(true)}>{t('Zeltsteuerung einrichten')}</button>
        ) : null}
        {!gp ? (
          <a className={`btn ghost small ${control || implicit ? 'room-action' : ''}`} href={href(implicit ? 'growplan' : `growplan/${room.id}`)}>{t('Growplan anlegen')}</a>
        ) : null}
        {implicit ? (
          <span className="small muted room-hint">
            {t('Lege unter {options} einen Raum an, um Phase, Lichtzeiten und Zeltsteuerung pro Zelt einzustellen.', {
              options: <a href={href('options')}>{t('Optionen')}</a>,
            })}
          </span>
        ) : null}
      </div>
      <div className="panel climate">
        <div className="climate-readings">
          <div className="readouts">
            <Readout label={t('Temperatur')} value={temp} digits={1} unit="°C" {...readoutTarget('temp', temp, targets, day)} />
            <Readout label={t('Luftfeuchte')} value={humi} digits={0} unit="%" {...readoutTarget('humi', humi, targets, day)} />
            <Readout label="VPD" value={vpdValue} digits={2} unit="kPa" {...readoutTarget('vpd', vpdValue, targets, day)} />
            {source.co2 ? <Readout label="CO₂" value={source.co2.value} digits={0} unit="ppm" /> : null}
            {source.ppfd ? <Readout label="PPFD" value={ppfdValue} digits={0} unit="µmol" {...readoutTarget('ppfd', ppfdValue, targets, day)} /> : null}
          </div>
          <Photoperiod dayStart={room.day_start} dayEnd={room.day_end} nowMs={now}
            actualDay={control?.enabled && control.day_by === 'light' ? control.day : undefined} />
          {gp ? (
            <GrowplanStrip gp={gp} routeKey={gpKey} today={today} room={room} control={control} targets={targets}
              implicit={implicit} onAdopt={() => setAdopting(true)} />
          ) : null}
        </div>
        <div className="climate-chart">
          <VpdChart temp={temp} humi={humi} band={band} trail={trail} />
        </div>
      </div>
      {historySeries.length ? (
        <Fold id="overview-trend" title={t('Klimaverlauf')} defaultOpen
          summary={TREND_RANGES.find((r) => r.key === trendRange)?.label}
          actions={<Segmented label={t('Zeitraum der Verläufe')} value={trendRange} options={TREND_RANGES} onChange={onTrendRange} />}>
          <ClimateTrend
            data={history.data}
            loading={history.loading}
            error={history.error}
            rangeKey={trendRange}
            targets={targets}
            targetNote={targetLegend(targets, stage, implicit)}
            syncKey={`trend-${room.id}`}
            historyHref={href(`history?series=${encodeURIComponent(historySeries.join(','))}`)}
          />
        </Fold>
      ) : null}
      {control ? <RoomControlPanel room={room} status={control} devices={allDevices} onEdit={() => setEditing(true)} /> : null}
      {editing ? <RoomControlEditor room={room} onClose={() => setEditing(false)} /> : null}
      {adopting && gp ? (
        <AdoptTargetsDialog room={room} gp={gp} today={today} byVpd={control?.plan?.humidity_mode === 'vpd'} onClose={() => setAdopting(false)} />
      ) : null}
      {devices.length ? (
        <Fold id="overview-devices" title={t('Geräte im Zelt')} summary={devicesSummary(devices)}>
          <DevicePanel devices={devices} skipSensors={skip} />
        </Fold>
      ) : (
        <p className="muted">{t('Diesem Raum ist noch kein Gerät zugeordnet. Das geht in den Gerätedetails.')}</p>
      )}
    </section>
  )
}

export default function Overview() {
  const devices = useStore((s) => s.devices)
  const rooms = useStore((s) => s.rooms)
  const offset = useStore((s) => s.serverOffset)
  const automation = useStore((s) => s.automation)
  const override = useStore((s) => s.override)
  const settings = useStore((s) => s.settings)
  const roomControl = useStore((s) => s.roomControl)
  const growplans = useStore((s) => s.growplans)
  const now = useNow(30000) + offset
  const [trendRange, setTrendRange] = useState(loadTrendRange)
  const changeTrendRange = (key) => {
    setTrendRange(key)
    saveTrendRange(key)
  }

  const list = Object.values(devices)
    .filter((d) => !d.info?.hidden)
    .sort((a, b) => a.vendor.localeCompare(b.vendor) || a.name.localeCompare(b.name, LOCALE))
  const roomIds = new Set(rooms.map((r) => r.id))
  const unassigned = list.filter((d) => !d.info?.room_id || !roomIds.has(d.info.room_id))
  const online = list.filter((d) => d.online).length
  // Without any room the overview still shows climate and charts for all devices.
  const implicitRoom = !rooms.length && unassigned.some((d) => d.sensors.some((s) => s.kind === 'temp') && d.sensors.some((s) => s.kind === 'humi'))
    ? { id: 'alle', name: t('Alle Geräte'), stage: 'veg', day_start: settings.day_start || '06:00', day_end: settings.day_end || '00:00' }
    : null
  // without rooms the plan without a tent (the latest one) belongs to all devices
  const loosePlan = [...growplans].filter((p) => !p.room_id).sort((a, b) => b.updated - a.updated)[0] || null

  // every tent (and the devices without one) is one section; the overview shows one at a time
  const sections = rooms.map((room) => {
    const roomDevices = list.filter((d) => d.info?.room_id === room.id)
    const gp = growplans.find((p) => p.room_id === room.id) || null
    const control = roomControl?.[room.id]
    return {
      id: room.id, name: room.name, room, devices: roomDevices, gp, control,
      climate: tentClimate({ room, devices: roomDevices, allDevices: devices, control, gp, now }),
    }
  })
  if (implicitRoom) {
    sections.push({
      id: implicitRoom.id, name: implicitRoom.name, room: implicitRoom, devices: unassigned, gp: loosePlan, implicit: true,
      climate: tentClimate({ room: implicitRoom, devices: unassigned, allDevices: devices, gp: loosePlan, now }),
    })
  } else if (unassigned.length) {
    sections.push({ id: 'ohne-raum', name: rooms.length ? t('Ohne Raum') : t('Alle Geräte'), devices: unassigned, loose: true })
  }
  const [chosen, setChosen] = useRemembered('overview-tent', null)
  const current = sections.find((x) => x.id === chosen) || sections[0] || null

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('Übersicht')}</h1>
          <p>
            {list.length === 1 ? t('1 Gerät, davon {online} online.', { online }) : t('{n} Geräte, davon {online} online.', { n: list.length, online })}{' '}
            {override.active ? t('Handbetrieb: Regeln und Zeltsteuerung pausieren.') : automation.enabled ? t('Regeln sind aktiv.') : t('Regeln sind pausiert.')}
          </p>
        </div>
        <div className="row page-tools">
          {settings.demo ? <span className="chip frost">{t('Demo mit simulierten Geräten')}</span> : null}
          {list.length ? <OverrideButton className="btn small" /> : null}
        </div>
      </div>

      {!list.length ? (
        <div className="panel">
          <Empty
            title={t('Noch keine Geräte verbunden')}
            action={<a className="btn primary" href={href('options')}>{t('Verbindungen einrichten')}</a>}
          >
            {t('Spider-Farmer-Geräte erscheinen, sobald ihr Datenverkehr über den Proxy auf der NAS läuft. Vivosun-Geräte lädt GrowDeck, nachdem du dein Vivosun-Konto verbunden hast.')}
          </Empty>
        </div>
      ) : null}

      <Attention devices={list} rooms={rooms} growplans={growplans} />

      {sections.length > 1 ? <TentCards sections={sections} selected={current?.id} onSelect={setChosen} /> : null}

      {current && !current.loose ? (
        <RoomSection
          key={current.id}
          room={current.room}
          devices={current.devices}
          allDevices={devices}
          now={now}
          control={current.control}
          trendRange={trendRange}
          onTrendRange={changeTrendRange}
          gp={current.gp}
          implicit={!!current.implicit}
        />
      ) : null}

      {current?.loose ? (
        <section className="room">
          <div className="room-head">
            <h2>{current.name}</h2>
            <span className="small muted">
              {rooms.length
                ? t('Ordne diese Geräte in den Gerätedetails einem Raum zu.')
                : t('Lege unter Optionen einen Raum an, um Klima und Lichtphase pro Zelt zu sehen.')}
            </span>
          </div>
          <DevicePanel devices={current.devices} />
        </section>
      ) : null}
    </>
  )
}

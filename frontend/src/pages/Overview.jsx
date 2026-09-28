import { Fragment, useEffect, useMemo, useState } from 'react'
import { api, toast, useStore } from '../store.js'
import { href } from '../router.js'
import { DIGITS, fmt, sensorText, STAGES, VENDORS, vpd } from '../format.js'
import { Photoperiod, Readout, VpdChart } from '../components/Climate.jsx'
import ControlRow from '../components/ControlRow.jsx'
import { Empty, Modal, Segmented } from '../components/ui.jsx'
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

function RoomSection({ room, devices, allDevices, now, control, trendRange, gp, implicit = false }) {
  const [editing, setEditing] = useState(false)
  const [adopting, setAdopting] = useState(false)
  const source = climateSource(room, allDevices, devices)
  const averaged = control?.readings?.sources?.length > 1 ? control.readings : null
  const stage = STAGES[room.stage] || STAGES.veg
  const today = todayISO(new Date(now))
  // one set of targets for readouts, charts and the VPD diagram: Growplan, room control or phase
  const targets = useMemo(() => tentTargets({ gp, control, stage, today }), [gp, control, stage, today])
  const day = isDayNow(room, control, now)
  const band = targets.vpd ? targets.vpd[day ? 'day' : 'night'] : null
  const temp = averaged?.temp ?? source.temp?.value ?? null
  const humi = averaged?.humi ?? source.humi?.value ?? null
  const refs = trendSources({ roomDevices: devices, source, averaged, control })
  const history = useClimateHistory(trendQuery(refs, room), trendRange)
  const trail = useMemo(() => trailFrom(history.data), [history.data])
  const gpKey = gp ? (gp.room_id ? room.id : gp.id) : null
  const historySeries = [...refs.temp, ...refs.humi, ...refs.vpd]
  const vpdValue = averaged ? vpd(temp, humi) : source.vpd?.value ?? vpd(temp, humi)
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
      ) : null}
      {control ? <RoomControlPanel room={room} status={control} devices={allDevices} onEdit={() => setEditing(true)} /> : null}
      {editing ? <RoomControlEditor room={room} onClose={() => setEditing(false)} /> : null}
      {adopting && gp ? (
        <AdoptTargetsDialog room={room} gp={gp} today={today} byVpd={control?.plan?.humidity_mode === 'vpd'} onClose={() => setAdopting(false)} />
      ) : null}
      {devices.length ? (
        <DevicePanel devices={devices} skipSensors={skip} />
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

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('Übersicht')}</h1>
          <p>
            {list.length === 1 ? t('1 Gerät, davon {online} online.', { online }) : t('{n} Geräte, davon {online} online.', { n: list.length, online })}{' '}
            {automation.enabled ? t('Regeln sind aktiv.') : t('Regeln sind pausiert.')}
          </p>
        </div>
        <div className="row page-tools">
          {settings.demo ? <span className="chip frost">{t('Demo mit simulierten Geräten')}</span> : null}
          {list.length ? (
            <div className="row trend-range">
              <span className="small muted">{t('Verläufe')}</span>
              <Segmented label={t('Zeitraum der Verläufe')} value={trendRange} options={TREND_RANGES} onChange={changeTrendRange} />
            </div>
          ) : null}
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

      {rooms.map((room) => (
        <RoomSection
          key={room.id}
          room={room}
          devices={list.filter((d) => d.info?.room_id === room.id)}
          allDevices={devices}
          now={now}
          control={roomControl?.[room.id]}
          trendRange={trendRange}
          gp={growplans.find((p) => p.room_id === room.id) || null}
        />
      ))}

      {implicitRoom ? (
        <RoomSection room={implicitRoom} devices={unassigned} allDevices={devices} now={now} trendRange={trendRange} gp={loosePlan} implicit />
      ) : null}

      {unassigned.length && !implicitRoom ? (
        <section className="room">
          <div className="room-head">
            <h2>{rooms.length ? t('Ohne Raum') : t('Alle Geräte')}</h2>
            <span className="small muted">
              {rooms.length
                ? t('Ordne diese Geräte in den Gerätedetails einem Raum zu.')
                : t('Lege unter Optionen einen Raum an, um Klima und Lichtphase pro Zelt zu sehen.')}
            </span>
          </div>
          <DevicePanel devices={unassigned} />
        </section>
      ) : null}
    </>
  )
}

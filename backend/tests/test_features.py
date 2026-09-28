"""Tests Growplan alarms, watering reminders, backups, cameras, the grow archive and the
Vivosun smart plugs against a temporary database.

    cd backend && python tests/test_features.py
"""
from __future__ import annotations

import asyncio
import gzip
import sqlite3
import sys
import tempfile
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.adapters.vivosun.adapter import VivosunAdapter  # noqa: E402
from app.adapters.vivosun.fake import FakeVivosunCloud  # noqa: E402
from app.alarms import AlarmEngine  # noqa: E402
from app.archive import ArchiveService, summarize_day  # noqa: E402
from app.backup import BackupError, BackupService, apply_pending_restore  # noqa: E402
from app.cameras import CameraError, CameraService  # noqa: E402
from app.db import Database  # noqa: E402
from app.events import EventBus  # noqa: E402
from app.growplan import GrowPlanService  # noqa: E402
from app.hub import CommandError, Hub  # noqa: E402
from app.model import Control, Device, make_sensor  # noqa: E402
from app.roomcontrol import RoomControl  # noqa: E402
from app.tent import climate_refs, list_tents  # noqa: E402
from app.watering import WateringService  # noqa: E402

TZ = "Europe/Berlin"
ZONE = ZoneInfo(TZ)
ok = 0


def check(condition: bool, label: str) -> None:
    global ok
    if not condition:
        raise AssertionError(label)
    ok += 1


def local_ts(day: date, hour: int, minute: int = 0) -> float:
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=ZONE).timestamp()


class Env:
    async def open(self, tmp: Path) -> None:
        self.tmp = tmp
        self.db = Database(tmp / "growdeck.sqlite3")
        await self.db.open()
        self.bus = EventBus()
        self.hub = Hub(self.db, self.bus)
        self.events: list[dict] = []
        original = self.hub.add_event

        async def add_event(level, category, message, device_id=None, data=None):
            self.events.append({"level": level, "category": category, "message": message, "data": data or {}})
            await original(level, category, message, device_id, data)

        self.hub.add_event = add_event  # type: ignore[method-assign]
        await self.db.save_room({"id": "zelt-1", "name": "Zelt 1", "sort": 0, "climate_device_id": "t-1",
                                 "climate_group": "", "day_start": "06:00", "day_end": "18:00", "stage": "flower"})
        self.device = Device(id="t-1", vendor="spiderfarmer", native_id="1", model="GGS", kind="controller",
                             name="Controller")
        self.device.sensors["temp"] = make_sensor("temp", "temp", 24.0)
        self.device.sensors["humi"] = make_sensor("humi", "humi", 50.0)
        self.device.sensors["soil1.moisture"] = make_sensor("soil1.moisture", "soil_moisture", 40.0)
        self.device.sensors["ppfd"] = make_sensor("ppfd", "ppfd", 700.0)
        self.device.info["room_id"] = "zelt-1"
        self.hub.devices[self.device.id] = self.device
        self.growplan = GrowPlanService(self.db, self.bus, TZ)
        await self.growplan.start()
        self.room_control = RoomControl(self.hub, TZ)
        self.today = self.growplan.today()
        flower = self.today - timedelta(days=16)
        self.plan = await self.growplan.create("zelt-1", "Zelt 1", {
            "vegStart": (flower - timedelta(days=35)).isoformat(), "floStart": flower.isoformat(),
            "vegWeeks": 5, "floWeeks": 9, "phase": "flower", "week": 3,
            "plants": [{"id": "p1", "name": "Links", "strain": "Northern Lights"}],
        })

    def set(self, temp: float | None = None, humi: float | None = None, soil: float | None = None) -> None:
        for key, value in (("temp", temp), ("humi", humi), ("soil1.moisture", soil)):
            if value is not None:
                self.device.sensors[key].value = value

    def take(self, category: str) -> list[dict]:
        found = [e for e in self.events if e["category"] == category]
        self.events = [e for e in self.events if e["category"] != category]
        return found

    async def close(self) -> None:
        await self.growplan.stop()
        await self.db.close()


# ------------------------------------------------------------ Growplan alarms
async def test_plan_alarms(env: Env) -> None:
    alarms = AlarmEngine(env.hub, TZ)
    alarms.growplan, alarms.room_control = env.growplan, env.room_control
    await alarms.reload()
    for bad, message in (({"kind": "growplan", "room_id": "nope", "metrics": ["temp"]}, "Zelt"),
                         ({"kind": "growplan", "room_id": "zelt-1", "metrics": []}, "Messwert")):
        try:
            await alarms.save(bad)
            check(False, "invalid plan alarm must fail")
        except CommandError as err:
            check(message in str(err), f"error {err}")
    alarm = await alarms.save({"kind": "growplan", "room_id": "zelt-1", "metrics": ["temp", "humi", "vpd", "co2"],
                               "delay_minutes": 30})
    check(alarm["metrics"] == ["temp", "humi", "vpd"] and alarm["name"] == "Zelt 1: Growplan-Ziele", "cleaned alarm")
    day = env.today
    t0 = local_ts(day, 12)
    # flowering week 3 (flo2): day 22–26 °C, humidity 45–55 %, VPD (air) 1.54–1.74
    env.set(temp=24.0, humi=50.0)   # VPD 1.49: just below the band but within the 0.15 margin
    await alarms.evaluate(t0)
    check(not alarms.status()[alarm["id"]]["firing"], "inside (with margin)")
    env.set(humi=63.0)              # humidity 8 points too high -> outside with margin; VPD 1.10 too low
    await alarms.evaluate(t0 + 60)
    check(not env.take("alarm"), "no alarm before the delay")
    await alarms.evaluate(t0 + 60 + 31 * 60)
    fired = env.take("alarm")
    messages = [e["message"] for e in fired]
    check(len(fired) == 2 and all(e["level"] == "alarm" for e in fired), f"humidity and VPD fire: {messages}")
    check(any("Zelt 1 zu feucht: Luftfeuchte 63 % statt 45–55 %" in m and "Knospenaufbau" in m for m in messages),
          f"humidity message {messages}")
    check(any("VPD 1,10 kPa statt 1,54–1,74 kPa" in m for m in messages), f"VPD message {messages}")
    st = alarms.status()[alarm["id"]]
    check(st["firing"] and st["metrics"]["humi"]["band"] == [45, 55], "status per metric")
    env.set(humi=57.0)              # within band + (margin - hysteresis) = 58.5 -> all-clear
    await alarms.evaluate(t0 + 40 * 60)
    resolved = env.take("alarm")
    check(any("Luftfeuchte wieder im Ziel" in e["message"] and e["data"]["resolved"] for e in resolved),
          f"all-clear {[e['message'] for e in resolved]}")
    # night: band 18–21 °C
    env.set(temp=24.0, humi=50.0)
    await alarms.evaluate(local_ts(day, 22))
    await alarms.evaluate(local_ts(day, 22) + 31 * 60)
    night = env.take("alarm")
    check(any("zu warm: Temperatur 24,0 °C statt 18–21 °C" in e["message"] for e in night),
          f"night band {[e['message'] for e in night]}")
    # strict: fires right outside the band
    strict = await alarms.save({"kind": "growplan", "room_id": "zelt-1", "metrics": ["temp"], "delay_minutes": 0,
                                "strict": True})
    env.set(temp=26.4)
    await alarms.evaluate(local_ts(day + timedelta(days=1), 12))
    check(alarms.status()[strict["id"]]["firing"], "strict fires at 26.4")
    # no plan -> waits with a message
    await env.growplan.assign(env.plan["id"], None)
    await alarms.evaluate(local_ts(day + timedelta(days=1), 12, 5))
    check("keinen Growplan" in (alarms.status()[strict["id"]]["message"] or ""), "waits for a plan")
    await env.growplan.assign(env.plan["id"], "zelt-1")
    # a sensor alarm still works as before
    sensor = await alarms.save({"device_id": "t-1", "sensor": "temp", "max": 30, "delay_minutes": 0})
    env.set(temp=31.0)
    await alarms.evaluate(time.time())
    check(alarms.status()[sensor["id"]]["firing"], "sensor alarm")
    for item in list(alarms.alarms):
        await alarms.delete(item["id"])
    env.set(temp=24.0, humi=50.0)
    env.take("alarm")


# ------------------------------------------------------------------ watering
async def test_watering(env: Env) -> None:
    water = WateringService(env.hub, TZ)
    water.growplan = env.growplan
    await water.start()
    water._task.cancel()
    plan_id = env.plan["id"]
    await env.growplan.save_entry(plan_id, {"id": "w1", "date": (env.today - timedelta(days=4)).isoformat(),
                                            "type": "water", "liters": 5})
    settings = await water.save_settings(plan_id, {"days": 3, "time": "09:00", "soil_below": 30, "detect": True,
                                                   "junk": 1})
    check(settings == {"days": 3, "time": "09:00", "soil_below": 30.0, "detect": True}, f"settings {settings}")
    check((await water.save_settings(plan_id, {"days": 99, "time": "25:00", "soil_below": 0}))["days"] == 30,
          "clamped")
    await water.save_settings(plan_id, {"days": 3, "time": "09:00", "soil_below": 30, "detect": True})
    day = env.today
    await water.check(local_ts(day, 8, 30))
    check(not env.take("water"), "not before 09:00")
    await water.check(local_ts(day, 9, 5))
    reminders = env.take("water")
    check(len(reminders) == 1 and "Gießen fällig? Letzte Gießung vor 4 Tagen" in reminders[0]["message"],
          f"days reminder {reminders}")
    await water.check(local_ts(day, 10))
    check(not env.take("water"), "once a day")
    # soil below the limit for 30 minutes
    env.set(soil=25.0)
    base = local_ts(day, 11)
    await water.check(base)
    await water.check(base + 20 * 60)
    check(not env.take("water"), "soil: not before 30 min")
    await water.check(base + 31 * 60)
    soil = env.take("water")
    check(len(soil) == 1 and "Bodenfeuchte 25 % unter 30 %" in soil[0]["message"], f"soil reminder {soil}")
    await water.check(base + 40 * 60)
    check(not env.take("water"), "soil: not repeated")
    # a watering: soil moisture jumps from 25 to 44
    env.set(soil=44.0)
    await water.check(base + 42 * 60)
    detected = env.take("water")
    items = water.payload()["suggestions"][plan_id]
    check(len(items) == 1 and items[0]["before"] == 25.0 and items[0]["after"] == 44.0, f"suggestion {items}")
    check(any("von 25 % auf 44 % gestiegen" in e["message"] for e in detected), f"detected {detected}")
    env.set(soil=46.0)
    await water.check(base + 43 * 60)
    check(len(water.payload()["suggestions"][plan_id]) == 1, "the same watering counts once")
    await water.dismiss(plan_id, items[0]["id"])
    check(water.payload()["suggestions"][plan_id] == [], "dismissed")
    # humidifier tank
    hum = Device(id="h-1", vendor="vivosun", native_id="2", model="AeroStream", kind="humidifier", name="AeroStream")
    hum.controls["hmdf"] = Control(id="hmdf", type="humidifier", label="Befeuchter", extra={"water_warning": False})
    env.hub.devices[hum.id] = hum
    await water.check(base + 50 * 60)
    hum.controls["hmdf"].extra["water_warning"] = True
    await water.check(base + 51 * 60)
    hum.controls["hmdf"].extra["water_warning"] = False
    await water.check(base + 52 * 60)
    tank = [e["message"] for e in env.take("water")]
    check(tank == ["AeroStream: Wassertank fast leer, bitte nachfüllen.", "AeroStream: Wassertank wieder gefüllt."],
          f"tank {tank}")
    env.hub.devices.pop(hum.id)
    env.set(soil=40.0)
    await water.plan_removed(plan_id)
    check(water.settings_for(plan_id)["days"] == 0, "settings removed with the plan")
    await env.growplan.delete_entry(plan_id, "w1")


# ------------------------------------------------------------------- backups
async def test_backups(env: Env) -> None:
    service = BackupService(env.hub, env.tmp, env.db.path, TZ)
    service.dir.mkdir(parents=True, exist_ok=True)
    await env.db.set_setting("marker", "vorher")
    first = await service.create()
    check(first["kind"] == "" and first["size"] > 0, "automatic backup")
    manual = await service.create("manuell")
    check(manual["kind_label"] == "von Hand", "manual backup")
    with gzip.open(service.dir / first["name"], "rb") as fin:
        copy = env.tmp / "check.sqlite3"
        copy.write_bytes(fin.read())
    con = sqlite3.connect(copy)
    check(con.execute("SELECT value FROM settings WHERE key='marker'").fetchone()[0] == '"vorher"', "content")
    con.close()
    await service.save_settings({"keep": 2, "time": "04:15", "enabled": True})
    for _ in range(3):
        await service.create()
    autos = [i for i in service.list() if i["kind"] == ""]
    check(len(autos) == 2 and any(i["kind"] == "manuell" for i in service.list()), "keeps 2 automatic, manual stays")
    for bad in ({"time": "4 Uhr"}, {"keep": 0}):
        try:
            await service.save_settings(bad)
            check(False, "bad settings must fail")
        except BackupError:
            check(True, "bad settings rejected")
    status = await service.status()
    check(status["time"] == "04:15" and status["next"] and status["database_bytes"] > 0, "status")

    async def chunks(data: bytes):
        for i in range(0, len(data), 65536):
            yield data[i:i + 65536]

    upload = await service.store_upload(chunks((service.dir / manual["name"]).read_bytes()))
    check(upload["kind"] == "hochgeladen" and upload["summary"]["rooms"] == 1, "upload gz")
    upload2 = await service.store_upload(chunks(copy.read_bytes()))
    check(upload2["kind"] == "hochgeladen", "upload plain sqlite")
    for junk in (b"kein sqlite", b"\x1f\x8b kaputt"):
        try:
            await service.store_upload(chunks(junk))
            check(False, "junk upload must fail")
        except BackupError as err:
            check("Datei" in str(err) or "Datenbank" in str(err), f"junk rejected: {err}")
    try:
        service.path_of("../growdeck.sqlite3")
        check(False, "path traversal")
    except BackupError:
        check(True, "no path traversal")
    # restore: marker was "vorher" in the upload; change it now, restore, apply at start
    await env.db.set_setting("marker", "nachher")
    result = await service.prepare_restore(upload["name"])
    check((env.tmp / "restore-pending.sqlite3").exists() and "vor-wiederherstellung" in result["safety"], "pending")
    await env.db.close()
    check(apply_pending_restore(env.tmp, env.db.path), "applied at start")
    await env.db.open()
    check(await env.db.get_setting("marker") == "vorher", "restored content")
    check(not (env.tmp / "restore-pending.sqlite3").exists(), "pending consumed")
    check(apply_pending_restore(env.tmp, env.db.path) is False, "nothing pending")
    await service.delete(upload2["name"])
    check(all(i["name"] != upload2["name"] for i in service.list()), "deleted")


# ------------------------------------------------------------------- cameras
async def test_cameras(env: Env) -> None:
    cams = CameraService(env.hub, env.tmp, TZ, demo=True)
    cams.room_control = env.room_control
    await cams.start()
    cams._task.cancel()
    if not cams.ffmpeg:
        print("  (kein ffmpeg: Kameratests übersprungen)")
        return
    for bad in ({"name": "", "source": "demo"}, {"name": "x", "source": "url", "url": "file:///etc/passwd"},
                {"name": "x", "source": "url", "url": "concat:a|b"}, {"name": "x", "source": "growcam"}):
        try:
            await cams.create(bad)
            check(False, f"invalid camera {bad}")
        except CameraError:
            check(True, "invalid camera rejected")
    camera = await cams.create({"name": "Zelt 1 Kamera", "source": "demo", "room_id": "zelt-1",
                                "times": ["12:00", "22:00", "99:00"]})
    check(camera["id"] == "zelt-1-kamera" and camera["times"] == ["12:00", "22:00"], "camera saved")
    with_login = await cams.create({"name": "Netz", "source": "url", "url": "rtsp://admin:geheim@192.168.1.5:554/"})
    listing = await cams.listing()
    shown = next(c for c in listing["cameras"] if c["id"] == with_login["id"])
    check("geheim" not in str(listing) and shown["url_masked"] == "rtsp://admin:***@192.168.1.5:554/", "password hidden")
    kept = await cams.update(with_login["id"], {"name": "Netz 2", "url": shown["url_masked"]})
    check(kept["url"] == "rtsp://admin:geheim@192.168.1.5:554/", "masked address keeps the password")
    day = env.today
    taken = await cams.tick(local_ts(day, 12, 1))
    check(len(taken) == 1, f"photo at 12:00 {taken}")
    check(await cams.tick(local_ts(day, 12, 2)) == [], "only once per time")
    check(await cams.tick(local_ts(day, 22, 1)) == [], "no photo at night (only light)")
    check(await cams.tick(local_ts(day + timedelta(days=1), 15)) == [], "missed by more than 2 h: skipped")
    for back in range(1, 4):
        await cams.snapshot(camera["id"], now=local_ts(day - timedelta(days=back), 12))
    photos = await env.db.list_photos(camera_id=camera["id"])
    check(len(photos) == 4 and all(cams.photo_path(p).stat().st_size > 1000 for p in photos), "photos stored")
    check(cams.photo_path(photos[0], thumb=True).stat().st_size < cams.photo_path(photos[0]).stat().st_size, "thumb")
    job = await cams.start_timelapse(camera["id"], (day - timedelta(days=5)).isoformat(), day.isoformat(), 8, True)
    await cams.jobs[camera["id"]]["task"]
    status = cams.job_status(camera["id"])
    check(job["frames"] == 4 and status["file"] and status["size"] > 1000, f"timelapse {status}")
    check(cams.video_path(camera["id"], status["file"]).is_file(), "video")
    try:
        await cams.start_timelapse(camera["id"], "2020-01-01", "2020-01-02", 8, True)
        check(False, "no photos -> error")
    except CameraError:
        check(True, "timelapse needs photos")
    # cleanup keeps photos attached to log entries
    oldest = photos[-1]
    await env.growplan.save_entry(env.plan["id"], {"id": "with-photo", "date": day.isoformat(), "type": "note",
                                                   "note": "Foto", "photo": oldest["id"]})
    await cams.update(camera["id"], {"name": "Zelt 1 Kamera", "keep_days": 1})
    removed = await cams.cleanup(local_ts(day, 12, 30))
    left = {p["id"] for p in await env.db.list_photos(camera_id=camera["id"])}
    check(removed == 2 and oldest["id"] in left, f"cleanup kept the log photo ({removed}, {left})")
    await env.growplan.delete_entry(env.plan["id"], "with-photo")
    await cams.delete(with_login["id"], photos=True)
    env.cameras = cams


# ------------------------------------------------------------------- archive
async def test_archive(env: Env) -> None:
    day = env.today - timedelta(days=2)
    refs = climate_refs(env.hub, (await list_tents(env.db, env.hub))[0], {})
    check(refs["temp"] == [("t-1", "temp")] and refs["ppfd"] == [("t-1", "ppfd")], f"refs {refs}")
    rows = []
    start = int(local_ts(day, 0))
    for minute in range(0, 24 * 60, 5):
        ts = start + minute * 60
        light = 6 * 60 <= minute < 18 * 60
        rows += [(ts, "t-1", "temp", 24.0 if light else 20.0), (ts, "t-1", "humi", 50.0),
                 (ts, "t-1", "ppfd", 800.0 if light else 0.0)]
    await env.db.insert_readings(rows)
    summary = await summarize_day(env.hub, (await list_tents(env.db, env.hub))[0], {}, day, ZONE,
                                  env.growplan.get(env.plan["id"])["data"])
    check(summary["temp"]["day"] == 24.0 and summary["temp"]["night"] == 20.0, f"day/night {summary['temp']}")
    check(summary["light_hours"] == 12.0 and abs(summary["dli"] - 34.56) < 0.01, f"light {summary}")
    check(summary["in"]["temp"] == 1.0 and summary["in"]["humi"] == 1.0, f"in range {summary['in']}")
    archive = ArchiveService(env.hub, TZ, retention_days=30)
    archive.growplan, archive.room_control = env.growplan, env.room_control
    made = await archive.fill_all(days_back=5)
    check(made == 1, f"one day with data {made}")
    plan_id = env.plan["id"]
    for i, (kind, liters, ec) in enumerate((("feed", 5, 1.2), ("water", 5, None), ("feed", 6, 1.4))):
        await env.growplan.save_entry(plan_id, {"id": f"a{i}", "date": (env.today - timedelta(days=10 - i)).isoformat(),
                                                "type": kind, "liters": liters, "ecIn": ec, "phIn": 6.2})
    try:
        await archive.archive_plan(plan_id, {"yield_g": "viel"})
        check(False, "bad yield")
    except Exception as err:  # noqa: BLE001
        check("Gramm" in str(err), "bad yield rejected")
    grow = await archive.archive_plan(plan_id, {"yield_g": "123,5", "notes": "gut", "rating": 4, "reset": True})
    stats = grow["stats"]
    check(grow["yield_g"] == 123.5 and grow["strain"] == "Northern Lights", f"grow {grow['strain']}")
    check(stats["waterings"] == 3 and stats["feeds"] == 2 and stats["liters"] == 16.0 and stats["ec_in"] == 1.3,
          f"log stats {stats}")
    check(stats["flower_days"] == 16 and stats["veg_days"] == 35 and stats["climate"]["flower"]["temp_day"] == 24.0,
          f"phases {stats}")
    check(stats["kwh"] and stats["g_per_watt"] == round(123.5 / 300, 2), f"energy {stats['kwh']} {stats['g_per_watt']}")
    check(len(grow["log"]) == 3 and grow["plan"]["floStart"], "log and plan kept in the archive")
    plan_after = env.growplan.get(plan_id)["data"]
    check(plan_after["phase"] == "seed" and plan_after["floStart"] == "" and await env.growplan.log(plan_id) == [],
          "plan starts over")
    updated = await archive.update(grow["id"], {"yield_g": 200, "name": "Herbst"})
    check(updated["name"] == "Herbst" and updated["stats"]["g_per_watt"] == round(200 / 300, 2), "update")
    name, csv = await archive.csv(grow["id"])
    check(name == "Herbst" and csv.count("\n") >= 3, "csv")
    await archive.delete(grow["id"])
    check(await archive.list() == [], "deleted")


# -------------------------------------------------------------- vivosun plugs
async def test_vivosun_plugs() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db = Database(Path(tmp) / "v.sqlite3")
        await db.open()
        hub = Hub(db, EventBus())
        cloud = FakeVivosunCloud(interval=3600)
        adapter = VivosunAdapter(cloud)
        hub.register_adapter(adapter)
        await hub.start()
        await asyncio.sleep(0.2)
        a10 = hub.devices["vs-900000000000000108"]
        a22 = hub.devices["vs-900000000000000109"]
        check(a10.kind == "outlet_strip" and a10.model == "GrowHub A10 Steckdose", f"A10 {a10.kind} {a10.model}")
        check(list(a10.controls) == ["o:outlet"] and a10.controls["o:outlet"].label == "Steckdose"
              and a10.controls["o:outlet"].on is True, "A10 outlet")
        check([c.label for c in a22.controls.values()] == ["Steckdose 1", "Steckdose 2", "USB"], "A22 outlets")
        check(a22.controls["o:outlet2"].mode_label == "Programm 1 (App)" and a22.sensors["temp"].value, "A22 mode, probe")
        await hub.command(a22.id, "o:outlet2", {"on": False})
        await asyncio.sleep(1.2)
        block = cloud.reported["900000000000000109"]["outlet2"]
        check(block == {"on": 0, "mode": 0}, f"switched by hand -> manual {block}")
        check(hub.devices[a22.id].controls["o:outlet2"].on is False, "state updated")
        # unknown format: a plug without recognisable switches gets a notice
        cloud.reported["900000000000000108"] = {"xyz": {"a": 5}, "connected": True}
        await cloud.request_shadow("900000000000000108")
        check(not hub.devices[a10.id].controls and "Fehlersuche" in hub.devices[a10.id].info.get("notice", ""),
              "unknown format notice")
        # a GrowHub named "Controller" with outlet keys and no light/fan becomes an outlet strip
        check(hub.devices["vs-900000000000000101"].kind == "controller", "GrowHub stays a controller")
        await hub.stop()
        await db.close()


async def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        env = Env()
        await env.open(Path(tmp))
        try:
            await test_plan_alarms(env)
            await test_watering(env)
            await test_cameras(env)
            await test_archive(env)
            await test_backups(env)
        finally:
            await env.close()
    await test_vivosun_plugs()
    print(f"features: {ok} checks ok")


if __name__ == "__main__":
    asyncio.run(main())

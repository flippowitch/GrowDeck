"""Tests the Growplan integration (plans, watering log, backups) against a temporary database.

    cd backend && python tests/test_growplan.py
"""
from __future__ import annotations

import asyncio
import copy
import json
import sqlite3
import sys
import tempfile
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db import Database  # noqa: E402
from app.events import EventBus  # noqa: E402
from app.growplan import (  # noqa: E402
    ENV, GrowPlanError, GrowPlanService, auto_position, control_targets, current_position, file_slug, log_csv,
    plan_status, sanitize_entry, sanitize_library, sanitize_plan, stage_key, svp,
)
from app.roomcontrol import RoomControl  # noqa: E402

ok = 0


def check(condition: bool, label: str) -> None:
    global ok
    if not condition:
        raise AssertionError(label)
    ok += 1


def test_sanitize() -> None:
    plan = sanitize_plan({})
    check(plan["phase"] == "veg" and plan["week"] == 1 and len(plan["plants"]) == 3, "defaults")
    check(plan["lamp"]["ppf"] == 852 and plan["sched"] == "an-sensi-top", "default lamp and schedule")
    plan = sanitize_plan({"phase": "flower", "week": 14, "floWeeks": 9, "vegWeeks": 30, "liters": "2,5",
                          "strength": 5, "tent": "1.2", "plants": ["Links", "Rechts", {"id": "p9", "name": " X ",
                                                                                          "type": "auto", "pot": 11}],
                          "vegStart": "2026-02-30", "floStart": "2026-09-01", "medium": "sand", "unknown": 1,
                          "envOv": {"flo1": {"tag": [27, 21], "rh": [50, 60], "h": 11.6}, "zzz": {"tag": [1, 2]}},
                          "lamp": {"ppf": 20, "watt": 480, "name": "  "}})
    check(plan["week"] == 9 and plan["vegWeeks"] == 12, "week clamped to flower weeks")
    check(plan["liters"] == 2.5 and plan["strength"] == 25 and plan["tent"] == 1.2, "numbers clamped and parsed")
    check([p["name"] for p in plan["plants"]] == ["Links", "Rechts", "X"], "plants from strings")
    check(plan["plants"][2]["type"] == "auto" and plan["plants"][2]["pot"] == 11, "plant fields kept")
    check(plan["vegStart"] == "" and plan["floStart"] == "2026-09-01", "invalid date dropped")
    check(plan["medium"] == "erde" and "unknown" not in plan, "unknown values dropped")
    check(plan["envOv"] == {"flo1": {"tag": [21, 27]}}, f"overrides equal to default dropped: {plan['envOv']}")
    check(plan["lamp"]["ppf"] == 852 and plan["lamp"]["watt"] == 480 and plan["lamp"]["name"] == "Spider Farmer G3000",
          "lamp limits")

    lib = sanitize_library({
        "custom": [{"id": "c-1", "name": "Mein Schema", "vegN": 2, "bloomN": 5, "flushN": 1,
                    "products": [{"n": "A", "k": "base", "v": [1, "?"], "b": [2, 2, 2, 2, 0, 9], "c": "#123456"},
                                 {"n": "A", "k": "add", "v": [], "b": []}, {"n": "", "v": [1]}],
                    "ec": {"v": [1.2, 0], "b": [0, 0, 0, 0, 0]}, "notes": {"v": ["", ""], "b": ["", "", "", "", ""]}},
                   {"id": "an-sensi-top", "products": [{"n": "x"}]}, {"id": "c-2", "products": []}],
        "ovr": {"bb-all": {"id": "bb-all", "brand": "BioBizz", "name": "All-Mix", "vegN": 2, "bloomN": 9, "flushN": 1,
                           "hold": 8, "seed": "water", "organic": True, "tips": "bb",
                           "products": [{"n": "Bio-Grow", "k": "base", "v": [0, 1], "b": [1] * 9}]},
                "c-9": {"products": [{"n": "x"}]}},
        "check": {"date": "2026-09-26", "done": ["d1", "d1", "c7"]},
        "checkCustom": [{"id": "c7", "g": "nirgends", "t": " Sprühflasche "}, {"t": ""}],
        "checkOff": ["d2", "d99", "d2"],
    })
    custom = lib["custom"][0]
    check(len(lib["custom"]) == 1 and custom["custom"] is True, "only valid custom schedules")
    check([p["n"] for p in custom["products"]] == ["A"], "duplicate and empty products dropped")
    check(custom["products"][0]["v"] == [1, 0] and custom["products"][0]["b"] == [2, 2, 2, 2, 0], "doses resized")
    check(custom["ec"] == {"v": [1.2, 0], "b": [0, 0, 0, 0, 0]} and "notes" not in custom, "empty rows dropped")
    check(list(lib["ovr"]) == ["bb-all"] and lib["ovr"]["bb-all"]["adjusted"] is True, "only built-in overrides")
    check(lib["ovr"]["bb-all"]["tips"] == "bb" and lib["ovr"]["bb-all"]["seed"] == "water", "override keeps its kind")
    check(lib["check"]["done"] == ["d1", "c7"] and lib["checkOff"] == ["d2"], "checklist state")
    check(lib["checkCustom"] == [{"id": "c7", "g": "nach", "t": "Sprühflasche"}], "own checklist item")

    entry = sanitize_entry({"id": "e1", "date": "2026-09-20", "type": "feed", "liters": "5", "phIn": "6,1",
                            "plants": [0, "p2"], "extra": [{"n": "CalMag", "a": "2,5"}, {"n": "", "a": 1}],
                            "mix": [{"n": "Sensi Grow A", "u": "ml", "v": 2, "c": "#2E7D32"}]}, strict=True)
    check(entry["liters"] == 5 and entry["phIn"] == 6.1 and entry["plants"] == ["p1", "p2"], "entry numbers")
    check(entry["extra"] == [{"n": "CalMag", "a": 2.5, "u": "ml"}], "extra additives")
    for bad, message in (({"type": "feed", "liters": 0}, "Wassermenge"), ({"type": "note"}, "Notiz"),
                         ({"type": "water", "liters": 2, "phIn": 15}, "pH"), ({"type": "water", "liters": 2,
                          "extra": [{"n": "X", "a": 9000}]}, "Zusätzen")):
        try:
            sanitize_entry({"id": "e", "date": "2026-09-20", **bad}, strict=True)
        except GrowPlanError as err:
            check(message in str(err), f"message for {bad}: {err}")
        else:
            raise AssertionError(f"accepted {bad}")
    lenient = sanitize_entry({"id": "e", "date": "2026-09-20", "type": "water", "liters": 0, "phIn": 15}, strict=False)
    check(lenient["liters"] is None and lenient["phIn"] is None, "imports drop impossible values")


def test_csv() -> None:
    plan = {"plants": [{"id": "p1", "name": "Links"}, {"id": "p2", "name": 'Mitte; "groß"'}]}
    log = [  # newest first, as the database returns it
        {"id": "b", "date": "2026-09-20", "type": "feed", "phase": "flower", "week": 2, "plants": [], "liters": 7.5,
         "strength": 80, "mix": [{"n": "Bio-Grow", "u": "ml", "v": 2}, {"n": "Micro 3", "u": "ml", "v": None}],
         "extra": [{"n": "CalMag", "a": 2.5, "u": "ml"}], "ecIn": 1.4, "phIn": 6.3, "ecOut": 1.95, "phOut": None,
         "tags": ["Entlaubt"], "note": 'Drain "trüb"', "sched": {"id": "bb-light", "name": "BioBizz · Light-Mix"}},
        {"id": "a", "date": "2026-09-01", "type": "water", "phase": "seed", "week": 1, "plants": ["p2"], "liters": 5.0,
         "strength": 100, "mix": [], "extra": [], "ecIn": 0.4, "phIn": None, "ecOut": None, "phOut": None, "tags": [],
         "note": "", "sched": None},
    ]
    rows = log_csv(plan, log).split("\r\n")
    check(rows[0].startswith("\ufeffDatum;Art;Pflanzen;Phase;Woche") and len(rows) == 3, "csv header and rows")
    check(rows[1] == '2026-09-01;Nur Wasser;"Mitte; ""groß""";Anzucht;;;5;;0,4;;;;;;;', f"csv water row {rows[1]!r}")
    check(rows[2] == ("2026-09-20;Dünger;Alle Pflanzen;Blüte;2;BioBizz · Light-Mix;7,5;80;1,4;6,3;1,95;;"
                      'Bio-Grow 12 ml, Micro 3 ? ml;CalMag 2,5 ml;Entlaubt;"Drain ""trüb"""'), f"csv feed row {rows[2]!r}")
    check(file_slug("Zelt Größe 1") == "zelt-groesse-1" and file_slug("") == "growplan", "file names")


def test_phases() -> None:
    plan = sanitize_plan({"vegStart": "2026-08-01", "floStart": "2026-09-05", "vegWeeks": 5, "floWeeks": 8,
                          "phase": "seed", "week": 1})
    check(auto_position(plan, date(2026, 7, 31)) is None, "before the start the manual phase applies")
    check(current_position(plan, date(2026, 7, 31)) == {"phase": "seed", "week": 1, "auto": False}, "manual")
    check(auto_position(plan, date(2026, 8, 1)) == ("veg", 1), "veg week 1 on the start day")
    check(auto_position(plan, date(2026, 8, 8)) == ("veg", 2), "veg week 2 after seven days")
    check(auto_position(plan, date(2026, 9, 4)) == ("veg", 5), "veg capped at the planned weeks")
    check(auto_position(plan, date(2026, 9, 26)) == ("flower", 4), "flower week 4")
    check(auto_position(plan, date(2027, 1, 1)) == ("flower", 8), "flower capped")
    # across the switch to summer time (29 March 2026) the week still changes after 7 days
    spring = sanitize_plan({"vegStart": "2026-03-25", "vegWeeks": 4})
    check(auto_position(spring, date(2026, 4, 1)) == ("veg", 2), "DST-safe week")
    stages = [stage_key("flower", w, 8) for w in range(1, 9)]
    check(stages == ["flo1", "flo1", "flo2", "flo2", "flo2", "flo3", "flo3", "flush"], f"flower stages {stages}")
    check([stage_key("veg", w, 8) for w in (1, 2, 3)] == ["veg1", "veg1", "veg2"] and stage_key("seed", 2, 8) == "seed",
          "veg stages")
    status = plan_status(plan, date(2026, 9, 26), {"date": "2026-09-25", "type": "feed", "liters": 4})
    check(status["stage"] == "flo2" and status["max_week"] == 8 and status["harvest"] == "2026-10-31", "status")
    check(status["last_watering"] == {"date": "2026-09-25", "type": "feed", "liters": 4}, "last watering")

    targets = control_targets(sanitize_plan({"phase": "veg", "week": 1}), date(2026, 9, 26))
    check(targets["stage"] == "veg1" and targets["light_hours"] == 18, "targets stage")
    check(targets["temp"] == {"day": 24.5, "night": 22.0, "tolerance": 2.0}, f"temp targets {targets['temp']}")
    check(targets["humi"] == {"day": 65, "night": 65, "tolerance": 5}, f"humi targets {targets['humi']}")
    night = round(svp(22) * (1 - 0.65), 2)
    day = round(0.9 + svp(24.5) - svp(22.5), 2)  # leaf 2 K cooler than the air by default
    check(targets["vpd"] == {"day": day, "night": night, "tolerance": 0.1}, f"vpd targets {targets['vpd']}")
    check(1.2 < day < 1.3 and targets["leaf_offset"] == 2, "leaf VPD converted to air VPD")
    same = control_targets(sanitize_plan({"phase": "veg", "week": 1, "leafOff": 0}), date(2026, 9, 26))
    check(same["vpd"]["day"] == 0.9, "without leaf offset the targets stay")
    own = control_targets(sanitize_plan({"phase": "flower", "week": 3, "leafOff": 0,
                                         "envOv": {"flo2": {"vpd": [1.1, 1.5]}}}), date(2026, 9, 26))
    check(own["vpd"]["day"] == 1.3 and own["vpd"]["tolerance"] == 0.2, "own targets are used")
    check(ENV["flo2"]["vpd"] == [1.2, 1.4], "defaults unchanged")


async def test_service() -> None:
    folder = tempfile.mkdtemp()
    path = Path(folder) / "test.db"
    # a database from 1.1.0 with recorded Spider Farmer flags
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE readings (ts INTEGER NOT NULL, device_id TEXT NOT NULL, metric TEXT NOT NULL, "
                 "value REAL NOT NULL)")
    conn.executemany("INSERT INTO readings VALUES(?,?,?,?)", [(1, "sf-1", "temp", 24), (1, "sf-1", "sensor.isDaySensor", 1),
                                                               (1, "sf-1", "sensor.isDayEnvTarget", 0),
                                                               (1, "sf-1", "sensor.leafVpd", 1.1)])
    conn.commit()
    conn.close()
    db = Database(path)
    await db.open()
    async with db.conn.execute("SELECT metric FROM readings ORDER BY metric") as cur:
        metrics = [row[0] for row in await cur.fetchall()]
    check(metrics == ["sensor.leafVpd", "temp"], f"flag readings removed: {metrics}")
    await db.close()
    await db.open()  # second start: migration does not run again
    async with db.conn.execute("PRAGMA user_version") as cur:
        check((await cur.fetchone())[0] == 1, "schema version")

    bus = EventBus()
    queue = bus.subscribe()
    service = GrowPlanService(db, bus, "Europe/Berlin")
    await service.start()
    await db.save_room({"id": "zelt-1", "name": "Zelt 1", "sort": 0, "climate_device_id": None, "climate_group": None,
                        "day_start": "06:00", "day_end": "00:00", "stage": "veg"})
    plan = await service.create("zelt-1", "Zelt 1", {"phase": "flower", "week": 3})
    check(plan["data"]["phase"] == "flower" and service.for_room("zelt-1")["id"] == plan["id"], "plan per tent")
    try:
        await service.create("zelt-1", "Zweiter", None)
    except GrowPlanError:
        check(True, "one plan per tent")
    else:
        raise AssertionError("second plan for the same tent")
    message = queue.get_nowait()
    check(message["type"] == "growplan" and message["data"]["plans"][0]["status"]["stage"] == "flo2", "published")

    await service.save_entry(plan["id"], {"id": "a", "date": "2026-09-20", "ts": 1, "type": "feed", "liters": 5})
    await service.save_entry(plan["id"], {"id": "b", "date": "2026-09-22", "ts": 2, "type": "note", "note": "Entlaubt"})
    await service.save_entry(plan["id"], {"id": "c", "date": "2026-09-21", "ts": 3, "type": "water", "liters": 3})
    log = await service.log(plan["id"])
    check([e["id"] for e in log] == ["b", "c", "a"], "log newest first")
    summary = service.summary(service.get(plan["id"]))
    check(summary["entries"] == 3 and summary["status"]["last_watering"]["date"] == "2026-09-21", "notes are no watering")
    await service.save_entry(plan["id"], {"id": "c", "date": "2026-09-23", "ts": 3, "type": "water", "liters": 3})
    check(service.summary(service.get(plan["id"]))["status"]["last_watering"]["date"] == "2026-09-23", "entry updated")
    await service.delete_entry(plan["id"], "c")
    check(service.summary(service.get(plan["id"]))["entries"] == 2, "entry deleted")

    lib = await service.save_library({"checkOff": ["d1"], "custom": [{"id": "c-x", "name": "X",
                                                                        "products": [{"n": "A", "v": [1]}]}]})
    check(lib["checkOff"] == ["d1"] and lib["custom"][0]["id"] == "c-x", "library saved")
    await service.save_library({"check": {"date": "2026-09-26", "done": ["d2"]}})
    check(service.library["custom"][0]["id"] == "c-x" and service.library["check"]["done"] == ["d2"], "partial update")

    # backup of the Growplan app into a fresh plan: settings, log and schedules come along
    backup = {"app": "growplan", "format": 2, "exported": "2026-09-26T10:00:00.000Z",
              "settings": {"view": "log", "phase": "veg", "week": 2, "vegWeeks": 5, "floWeeks": 9, "sched": "c-imp",
                           "liters": 7.5, "plants": [{"id": "p1", "name": "Amnesia"}], "theme": "dark",
                           "checkOff": ["d3"], "check": {"date": "2026-09-25", "done": ["d4"]}},
              "log": [{"id": "x1", "date": "2026-09-01", "ts": 10, "type": "feed", "liters": 4, "plants": [0],
                       "phIn": 6.2, "mix": [{"n": "Grow", "u": "ml", "v": 2, "c": "#2E7D32"}]},
                      {"id": "x2", "date": "2026-09-03", "ts": 11, "type": "water", "liters": 4},
                      {"date": "2026-09-04"}],
              "custom": [{"id": "c-imp", "name": "Importiert", "products": [{"n": "Grow", "v": [1, 2], "b": []}]}],
              "ovr": {"an-coco-top": {"name": "Coco", "products": [{"n": "Sensi Coco Grow A", "v": [9]}]}}}
    fresh = await service.create(None, "Mein Grow", None)
    result = await service.import_backup(fresh["id"], backup)
    check(result == {"added": 2, "updated": 0, "skipped": 1, "custom": 1, "ovr": 1, "settings": True}, f"import {result}")
    data = service.get(fresh["id"])["data"]
    check(data["vegWeeks"] == 5 and data["liters"] == 7.5 and data["sched"] == "c-imp", "settings taken over")
    check("view" not in data and "theme" not in data, "app-only settings ignored")
    check(service.library["checkOff"] == ["d3"] and "c-imp" in [c["id"] for c in service.library["custom"]],
          "checklist and schedule in the library")
    check(service.library["ovr"]["an-coco-top"]["adjusted"] is True, "adjusted built-in schedule")
    again = await service.import_backup(fresh["id"], {**backup, "settings": {"liters": 1}})
    check(again["added"] == 0 and again["updated"] == 2 and again["settings"] is False, "second import merges")
    check(service.get(fresh["id"])["data"]["liters"] == 7.5, "settings kept once the log has entries")

    exported = await service.export_backup(fresh["id"])
    check(exported["app"] == "growplan" and exported["format"] == 2, "export format")
    check([e["id"] for e in exported["log"]] == ["x1", "x2"], "export oldest first")
    check(exported["settings"]["checkOff"] == ["d3"] and exported["settings"]["view"] == "heute", "export settings")
    json.dumps(exported)
    copy_plan = await service.create(None, "Kopie", None)
    await service.import_backup(copy_plan["id"], copy.deepcopy(exported))
    check(await service.log(copy_plan["id"]) == await service.log(fresh["id"]), "export and import round trip")
    check(service.get(copy_plan["id"])["data"] == service.get(fresh["id"])["data"], "settings round trip")

    try:
        await service.import_backup(fresh["id"], {"app": "other", "log": []})
    except GrowPlanError as err:
        check("Kein Growplan-Backup" in str(err), "foreign file rejected")

    # tents: assign, conflict, room deleted
    try:
        await service.assign(fresh["id"], "zelt-1")
    except GrowPlanError:
        check(True, "tent already has a plan")
    await service.assign(plan["id"], None)
    await service.assign(fresh["id"], "zelt-1")
    check(service.for_room("zelt-1")["id"] == fresh["id"], "plan moved to the tent")
    await db.delete_room("zelt-1")
    await service.room_deleted("zelt-1")
    check(service.for_room("zelt-1") is None and service.get(fresh["id"])["room_id"] is None, "room deleted")
    stored = {p["id"]: p["room_id"] for p in await db.list_growplans()}
    check(stored[fresh["id"]] is None, "unassigned in the database")

    # the room control follows the plan
    await service.assign(fresh["id"], "zelt-2")

    class HubStub:
        def __init__(self) -> None:
            self.db = db
            self.bus = bus
            self.devices = {}

    control = RoomControl(HubStub(), "Europe/Berlin")  # type: ignore[arg-type]
    control.plan_targets = service.targets_for_room
    cfg = control.normalize("zelt-2", {"enabled": True, "plan_targets": True, "humidity_mode": "vpd"})
    effective, source = control.effective("zelt-2", cfg)
    expected = control_targets(service.get(fresh["id"])["data"], service.today())
    check(effective["vpd"] == expected["vpd"] and effective["temp"] == expected["temp"], "room control uses the plan")
    check(source["stage"] == expected["stage"] and cfg["vpd"]["day"] == 1.2, "stored config unchanged")
    check(control.effective("zelt-9", cfg)[1] is None, "no plan: own targets")
    status = await control._evaluate_room({"id": "zelt-2", "name": "Zelt 2", "day_start": "06:00", "day_end": "00:00"},
                                          cfg, datetime.now(service.tz))
    check(status["plan_source"]["plan_id"] == fresh["id"] and status["plan"]["vpd"] == expected["vpd"], "status")

    await service.clear_log(fresh["id"])
    check(service.summary(service.get(fresh["id"]))["entries"] == 0, "log cleared")
    await service.delete(copy_plan["id"])
    check(copy_plan["id"] not in service.plans and not await db.list_growlog(copy_plan["id"]), "plan deleted")

    # a restart loads everything again
    service2 = GrowPlanService(db, bus, "Europe/Berlin")
    await service2.start()
    check(set(service2.plans) == set(service.plans) and service2.library == service.library, "reload")
    await service2.stop()
    await service.stop()
    await db.close()


def main() -> None:
    test_sanitize()
    test_csv()
    test_phases()
    asyncio.run(test_service())
    print(f"growplan: {ok} checks ok")


if __name__ == "__main__":
    main()

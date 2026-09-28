"""Tests the climate history behind the overview charts against a temporary database.

    cd backend && python tests/test_climate_history.py
"""
from __future__ import annotations

import asyncio
import math
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.climate import climate_history, schedule_nights, vpd_from  # noqa: E402
from app.db import Database  # noqa: E402

TZ = ZoneInfo("Europe/Berlin")


def at(day: int, hour: int, minute: int = 0) -> int:
    return int(datetime(2026, 9, day, hour, minute, tzinfo=TZ).timestamp())


def local(ts: int) -> str:
    return datetime.fromtimestamp(ts, TZ).strftime("%d. %H:%M")


async def main() -> None:
    folder = tempfile.mkdtemp()
    db = Database(Path(folder) / "test.db")
    await db.open()
    now = at(26, 10)  # Saturday 10:00
    start = now - 30 * 3600

    # two climate sensors of different vendors, one sample per minute, lights 06:00-00:00
    rows = []
    for ts in range(start, now + 1, 60):
        hour = datetime.fromtimestamp(ts, TZ).hour
        day = hour >= 6
        rows.append((ts, "sf-a", "temp", 25.0 if day else 21.0))
        rows.append((ts, "vs-b", "temp", 26.0 if day else 22.0))
        rows.append((ts, "sf-a", "humi", 55.0 if day else 65.0))
        rows.append((ts, "vs-b", "humi", 57.0 if day else 63.0))
        rows.append((ts, "sf-a", "vpd", 1.3 if day else 0.8))
    await db.insert_readings(rows)

    # the light switched off at midnight and on at 06:00, a dimming step in between
    await db.insert_control_log(at(24, 6), "sf-a", "light", True, 80, "device")
    await db.insert_control_log(at(25, 0), "sf-a", "light", False, 0, "device")
    await db.insert_control_log(at(25, 6), "sf-a", "light", True, 60, "device")
    await db.insert_control_log(at(25, 12), "sf-a", "light", True, 80, "user")
    await db.insert_control_log(at(26, 0), "sf-a", "light", False, 0, "device")
    await db.insert_control_log(at(26, 6), "sf-a", "light", True, 80, "device")

    common = dict(tz="Europe/Berlin", sample_interval=60, vpd=[], day_start="06:00", day_end="00:00", now=now)
    result = await climate_history(db, hours=24, points=240, temp=["sf-a|temp", "vs-b|temp"],
                                   humi=["sf-a|humi", "vs-b|humi"], light=["sf-a|light"], **common)
    n = len(result["t"])
    assert result["bucket"] == 360, result["bucket"]
    assert n == len(result["temp"]) == len(result["humi"]) == len(result["vpd"]) and 240 <= n <= 242, n
    assert result["t"][0] <= now - 24 * 3600 < result["t"][0] + 360 and result["t"][-1] <= now
    noon = result["t"].index(next(t for t in result["t"] if t >= at(25, 14)))
    night = result["t"].index(next(t for t in result["t"] if t >= at(26, 3)))
    assert result["temp"][noon] == 25.5 and result["humi"][noon] == 56.0, (result["temp"][noon], result["humi"][noon])
    assert result["temp"][night] == 21.5 and result["humi"][night] == 64.0
    assert abs(result["vpd"][noon] - round(vpd_from(25.5, 56.0), 3)) < 1e-9
    assert result["sources"] == {"temp": 2, "humi": 2, "vpd": 2}, result["sources"]
    assert result["night_source"] == "light" and result["nights"] == [[at(26, 0), at(26, 6)]], \
        [(local(a), local(b)) for a, b in result["nights"]]
    print(f"ok   averaged two sensors over {n} buckets, VPD from the averages, "
          f"light off {local(at(26, 0))}-{local(at(26, 6))} from the switch log")

    # the device's own VPD sensor is used when given
    own = await climate_history(db, hours=24, points=240, temp=["sf-a|temp"], humi=["sf-a|humi"],
                                light=[], **{**common, "vpd": ["sf-a|vpd"]})
    assert own["vpd"][noon] == 1.3 and own["vpd"][night] == 0.8
    assert own["night_source"] == "schedule" and own["nights"] == [[at(26, 0), at(26, 6)]]
    print("ok   own VPD sensor used; without lights the light times of the tent apply")

    # a light the log only knows from 03:00 today: before that the light times apply
    await db.insert_control_log(at(26, 3), "vs-b", "light", False, 0, "device")
    await db.insert_control_log(at(26, 7), "vs-b", "light", True, 50, "device")
    mixed = await climate_history(db, hours=24, points=240, temp=["vs-b|temp"], humi=["vs-b|humi"],
                                  light=["vs-b|light"], **{**common, "day_start": "05:00", "day_end": "23:00"})
    assert mixed["night_source"] == "light"
    assert mixed["nights"] == [[at(25, 23), at(26, 3)], [at(26, 3), at(26, 7)]] or \
        mixed["nights"] == [[at(25, 23), at(26, 7)]], [(local(a), local(b)) for a, b in mixed["nights"]]
    print("ok   log-based periods continue the light times where the log starts late:",
          ", ".join(f"{local(a)}-{local(b)}" for a, b in mixed["nights"]))

    # two lights: it is day while any of them is on; the second one only counts once the log knows it
    both = await climate_history(db, hours=24, points=240, temp=["sf-a|temp"], humi=["sf-a|humi"],
                                 light=["sf-a|light", "vs-b|light"], **common)
    assert both["nights"] == [[at(26, 0), at(26, 6)]], [(local(a), local(b)) for a, b in both["nights"]]
    print("ok   two lights: dark only while no known light is on:",
          ", ".join(f"{local(a)}-{local(b)}" for a, b in both["nights"]))

    # a week, gaps stay gaps, unknown sensors give empty series
    week = await climate_history(db, hours=168, points=336, temp=["sf-a|temp", "nope|temp"], humi=[], light=[],
                                 **common)
    assert week["bucket"] == 1800 and week["sources"]["temp"] == 1
    assert week["temp"][0] is None and week["temp"][-1] is not None and all(v is None for v in week["vpd"])
    print(f"ok   7 days: {len(week['t'])} buckets of 30 min, empty before the first sample")

    # schedule edge cases: 24/0, 12/12 over midnight, summer time ends on 25 October
    assert schedule_nights(at(25, 0), at(26, 0), 6 * 60, 6 * 60, TZ) == []
    flower = schedule_nights(at(25, 0), at(26, 0), 18 * 60, 6 * 60, TZ)
    assert flower == [[at(25, 6), at(25, 18)]], [(local(a), local(b)) for a, b in flower]
    oct_start = int(datetime(2026, 10, 24, 12, tzinfo=TZ).timestamp())
    dst = schedule_nights(oct_start, oct_start + 36 * 3600, 6 * 60, 0, TZ)
    length = (dst[0][1] - dst[0][0]) / 3600
    assert math.isclose(length, 7.0), (length, [(a, b) for a, b in dst])
    print("ok   light times: 24/0 without night, 12/12 across midnight, 7 h night when summer time ends")

    for bad in (["sf-a"], ["|temp"], ["x" * 200 + "|temp"]):
        try:
            await climate_history(db, hours=24, points=240, temp=bad, humi=[], light=[], **common)
        except ValueError as err:
            message = str(err)
        else:
            raise AssertionError(f"accepted {bad}")
    print("ok   invalid sources are rejected:", message)
    await db.close()
    print("ALL CLIMATE HISTORY TESTS PASSED")


if __name__ == "__main__":
    asyncio.run(main())

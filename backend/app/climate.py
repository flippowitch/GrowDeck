"""Climate history of one tent for the overview charts.

The overview asks for temperature, humidity and VPD over a period, taken from
the tent's climate sensor or averaged over several sensors (also across
vendors), plus the periods in which the lights were off. The caller names the
sensors and lights, so the charts always use the same sources as the readouts.

Light-off periods come from the switch log of the given lights. Where the log
does not reach back far enough, or the tent has no switchable light, the
tent's configured light times are used instead.
"""
from __future__ import annotations

import math
import re
import time
from datetime import datetime, timedelta
from datetime import time as dtime
from typing import Any
from zoneinfo import ZoneInfo

from .db import Database

MAX_REFS = 24
HHMM = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")


def parse_refs(values: list[str], label: str, limit: int = MAX_REFS) -> list[tuple[str, str]]:
    """'device_id|key' strings -> unique (device_id, key) pairs."""
    refs: list[tuple[str, str]] = []
    for raw in values:
        device_id, sep, key = (raw or "").partition("|")
        device_id, key = device_id.strip(), key.strip()
        if not sep or not device_id or not key or len(device_id) > 120 or len(key) > 80:
            shown = raw if len(raw or "") <= 60 else f"{raw[:57]}…"
            raise ValueError(f"Ungültige Quelle für {label}: „{shown}“.")
        if (device_id, key) not in refs:
            refs.append((device_id, key))
    if len(refs) > limit:
        raise ValueError(f"Höchstens {limit} Quellen für {label}.")
    return refs


def parse_hhmm(value: str, fallback: str) -> int:
    match = HHMM.match((value or "").strip()) or HHMM.match(fallback)
    assert match is not None
    return int(match.group(1)) * 60 + int(match.group(2))


def svp(temp_c: float) -> float:
    return 0.6108 * math.exp(17.27 * temp_c / (temp_c + 237.3))


def vpd_from(temp: float | None, humi: float | None) -> float | None:
    if temp is None or humi is None:
        return None
    return max(0.0, svp(temp) * (1 - humi / 100))


def merge_intervals(intervals: list[list[int]]) -> list[list[int]]:
    merged: list[list[int]] = []
    for a, b in sorted(i for i in intervals if i[1] > i[0]):
        if merged and a <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return merged


def schedule_nights(start: int, end: int, day_start: int, day_end: int, tz: ZoneInfo) -> list[list[int]]:
    """Light-off intervals within [start, end] for a daily light window (minutes after midnight)."""
    if day_start == day_end or end <= start:
        return []  # 24/0: always light
    days: list[tuple[int, int]] = []
    day = datetime.fromtimestamp(start, tz).date() - timedelta(days=1)
    last = datetime.fromtimestamp(end, tz).date() + timedelta(days=1)
    while day <= last:
        on = datetime.combine(day, dtime(day_start // 60, day_start % 60), tzinfo=tz)
        off_day = day if day_end > day_start else day + timedelta(days=1)
        off = datetime.combine(off_day, dtime(day_end // 60, day_end % 60), tzinfo=tz)
        days.append((int(on.timestamp()), int(off.timestamp())))
        day += timedelta(days=1)
    nights: list[list[int]] = []
    cursor = start
    for a, b in sorted(days):
        if b <= cursor:
            continue
        if a > cursor:
            nights.append([cursor, min(a, end)])
        cursor = max(cursor, b)
        if cursor >= end:
            break
    if cursor < end:
        nights.append([cursor, end])
    return merge_intervals(nights)


def light_is_on(row: dict[str, Any] | None) -> bool | None:
    if row is None:
        return None
    on, level = row.get("on_state"), row.get("level")
    if on is None:
        return None if level is None else level > 0
    return bool(on) and (level is None or level > 0)


async def light_nights(db: Database, lights: list[tuple[str, str]], start: int,
                       end: int) -> tuple[list[list[int]], int] | None:
    """Light-off intervals from the switch log, and the time from which the log knows any light.

    Any light on counts as day; a light the log does not know yet does not count.
    Returns None if the log knows nothing about the lights.
    """
    infos: list[tuple[bool | None, list[tuple[int, bool]]]] = []
    for device_id, control_id in lights:
        before = light_is_on(await db.control_state_before(device_id, control_id, start))
        events = []
        for row in await db.control_changes(device_id, control_id, start, end):
            state = light_is_on(row)
            if state is not None:
                events.append((int(row["ts"]), state))
        if before is not None or events:
            infos.append((before, events))
    if not infos:
        return None
    known_from = min(start if before is not None else events[0][0] for before, events in infos)
    states: list[bool | None] = [before for before, _events in infos]
    changes = sorted((ts, index, on) for index, (_before, events) in enumerate(infos) for ts, on in events)
    position = 0
    while position < len(changes) and changes[position][0] <= known_from:
        _ts, index, on = changes[position]
        states[index] = on
        position += 1
    nights: list[list[int]] = []
    off_since = None if any(states) else known_from
    for ts, index, on in changes[position:]:
        states[index] = on
        if any(states):
            if off_since is not None:
                nights.append([off_since, ts])
                off_since = None
        elif off_since is None:
            off_since = ts
    if off_since is not None:
        nights.append([off_since, end])
    return merge_intervals(nights), known_from


async def _averaged(db: Database, refs: list[tuple[str, str]], start: int, end: int,
                    bucket: int) -> tuple[dict[int, float], int]:
    """Per-bucket average over several sensors (each sensor weighted equally)."""
    values: dict[int, list[float]] = {}
    with_data = 0
    for device_id, key in refs:
        rows = await db.query_readings(device_id, key, start, end, bucket)
        if rows:
            with_data += 1
        for ts, avg, _low, _high in rows:
            values.setdefault(ts, []).append(avg)
    return {ts: sum(v) / len(v) for ts, v in values.items()}, with_data


async def climate_history(
    db: Database, *, tz: str, sample_interval: int, hours: float, points: int,
    temp: list[str], humi: list[str], vpd: list[str], light: list[str],
    day_start: str, day_end: str, now: float | None = None,
) -> dict[str, Any]:
    temp_refs = parse_refs(temp, "Temperatur")
    humi_refs = parse_refs(humi, "Luftfeuchte")
    vpd_refs = parse_refs(vpd, "VPD")
    light_refs = parse_refs(light, "Licht")
    zone = ZoneInfo(tz)
    hours = max(0.5, min(float(hours), 24 * 90))
    points = max(20, min(int(points), 1000))
    end = int(now if now is not None else time.time())
    span = int(hours * 3600)
    bucket = max(2 * sample_interval, math.ceil(span / points))
    start = ((end - span) // bucket) * bucket

    temps, temp_n = await _averaged(db, temp_refs, start, end, bucket)
    humis, humi_n = await _averaged(db, humi_refs, start, end, bucket)
    vpds, vpd_n = await _averaged(db, vpd_refs, start, end, bucket)

    grid = list(range(start, end + 1, bucket))
    series: dict[str, list[float | None]] = {"temp": [], "humi": [], "vpd": []}
    for ts in grid:
        t, h = temps.get(ts), humis.get(ts)
        v = vpds.get(ts) if vpd_refs else vpd_from(t, h)
        series["temp"].append(None if t is None else round(t, 2))
        series["humi"].append(None if h is None else round(h, 1))
        series["vpd"].append(None if v is None else round(v, 3))

    day_from = parse_hhmm(day_start, "06:00")
    day_to = parse_hhmm(day_end, "00:00")
    from_log = await light_nights(db, light_refs, start, end) if light_refs else None
    if from_log is None:
        nights = schedule_nights(start, end, day_from, day_to, zone)
        night_source = "schedule"
    else:
        log_nights, known_from = from_log
        nights = merge_intervals(schedule_nights(start, known_from, day_from, day_to, zone) + log_nights)
        night_source = "light"

    return {
        "start": start, "end": end, "bucket": bucket, "t": grid, **series,
        "nights": nights, "night_source": night_source,
        "sources": {"temp": temp_n, "humi": humi_n, "vpd": vpd_n if vpd_refs else min(temp_n, humi_n)},
    }

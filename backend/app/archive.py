"""Grow archive: finished grows with yield, key figures and the whole watering log.

To have climate figures for a whole grow (often longer than the history is kept), GrowDeck
keeps one summary per tent and day: day and night averages of temperature, humidity and
VPD, the share of the time inside the Growplan's target ranges, hours of light and the
daily light integral (DLI) if a PPFD sensor is there. The summaries are made every night
for the day before, and filled in once for the days still in the history.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
import time
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from .climate import _averaged, light_nights, merge_intervals, parse_hhmm, schedule_nights, vpd_from
from .growplan import ENV, GrowPlanError, log_csv, plan_bands, plan_for_next_grow, stage_key
from .hub import Hub
from .tent import climate_refs, list_tents

_LOGGER = logging.getLogger(__name__)

BUCKET = 300
MAX_BACKFILL_DAYS = 400


def _in_night(ts: int, nights: list[list[int]]) -> bool:
    return any(a <= ts < b for a, b in nights)


def _avg(values: list[float]) -> float | None:
    return round(sum(values) / len(values), 3) if values else None


def _date(value: Any) -> date | None:
    try:
        return date.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None


async def summarize_day(hub: Hub, room: dict[str, Any], cfg: dict[str, Any], day: date, tz: ZoneInfo,
                        plan: dict[str, Any] | None) -> dict[str, Any] | None:
    """Climate summary of one tent and day, or None without measurements."""
    start = int(datetime.combine(day, datetime.min.time(), tzinfo=tz).timestamp())
    end = int(datetime.combine(day + timedelta(days=1), datetime.min.time(), tzinfo=tz).timestamp())
    refs = climate_refs(hub, room, cfg)
    if not refs["temp"] and not refs["humi"]:
        return None
    db = hub.db
    temps, _ = await _averaged(db, refs["temp"], start, end - 1, BUCKET)
    humis, _ = await _averaged(db, refs["humi"], start, end - 1, BUCKET)
    vpds, _ = await _averaged(db, refs["vpd"], start, end - 1, BUCKET) if refs["vpd"] else ({}, 0)
    ppfds, _ = await _averaged(db, refs["ppfd"], start, end - 1, BUCKET) if refs["ppfd"] else ({}, 0)
    stamps = sorted(set(temps) | set(humis))
    if not stamps:
        return None
    day_from = parse_hhmm(room.get("day_start", "06:00"), "06:00")
    day_to = parse_hhmm(room.get("day_end", "00:00"), "00:00")
    from_log = await light_nights(db, refs["light"], start, end) if refs["light"] else None
    if from_log is None:
        nights = schedule_nights(start, end, day_from, day_to, tz)
    else:
        log_nights, known_from = from_log
        nights = merge_intervals(schedule_nights(start, known_from, day_from, day_to, tz) + log_nights)
    dark = sum(min(b, end) - max(a, start) for a, b in nights if b > start and a < end)
    bands = plan_bands(plan, day) if plan else None
    values: dict[str, dict[str, list[float]]] = {k: {"day": [], "night": []} for k in ("temp", "humi", "vpd")}
    inside: dict[str, list[int]] = {k: [] for k in ("temp", "humi", "vpd")}
    for ts in stamps:
        phase = "night" if _in_night(ts, nights) else "day"
        t, h = temps.get(ts), humis.get(ts)
        v = vpds.get(ts) if refs["vpd"] else vpd_from(t, h)
        for key, value in (("temp", t), ("humi", h), ("vpd", v)):
            if value is None:
                continue
            values[key][phase].append(value)
            if bands:
                band = bands[key][phase]
                inside[key].append(1 if band[0] <= value <= band[1] else 0)
    result: dict[str, Any] = {"samples": len(stamps), "light_hours": round((end - start - dark) / 3600, 2)}
    for key in ("temp", "humi", "vpd"):
        both = values[key]["day"] + values[key]["night"]
        result[key] = {"day": _avg(values[key]["day"]), "night": _avg(values[key]["night"]),
                       "min": round(min(both), 2) if both else None, "max": round(max(both), 2) if both else None}
    result["in"] = {k: (round(sum(v) / len(v), 3) if v else None) for k, v in inside.items()}
    if ppfds:
        # mol/m² per day: PPFD (µmol/m²/s) summed over the samples, missing buckets count as dark
        result["dli"] = round(sum(max(0.0, v) for v in ppfds.values()) * BUCKET / 1e6, 2)
    if bands:
        result.update({"stage": bands["stage"], "phase": bands["phase"], "week": bands["week"]})
    return result


class ArchiveService:
    def __init__(self, hub: Hub, tz: str, retention_days: int) -> None:
        self.hub = hub
        self.tz = ZoneInfo(tz)
        self.retention_days = retention_days
        self.growplan: Any = None      # set by the app context
        self.room_control: Any = None
        self.watering: Any = None
        self.cameras: Any = None
        self._task: asyncio.Task[None] | None = None
        self._lock = asyncio.Lock()

    async def start(self) -> None:
        self._task = asyncio.create_task(self._loop(), name="archive")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)

    def today(self) -> date:
        return datetime.now(self.tz).date()

    def _cfg(self, room_id: str) -> dict[str, Any]:
        return self.room_control.config(room_id) if self.room_control is not None else {}

    def _plan(self, room_id: str, rooms_exist: bool) -> dict[str, Any] | None:
        record = self.growplan.plan_for_tent(room_id, rooms_exist) if self.growplan is not None else None
        return record["data"] if record else None

    # ------------------------------------------------------------ room days
    async def fill_days(self, room: dict[str, Any], first: date, last: date, *, rooms_exist: bool,
                        overwrite: bool = False) -> int:
        """Makes the missing day summaries of a tent between two dates (both included)."""
        known = set() if overwrite else await self.hub.db.room_day_dates(room["id"])
        plan = self._plan(room["id"], rooms_exist)
        cfg = self._cfg(room["id"])
        made = 0
        day = first
        while day <= last:
            if day.isoformat() not in known:
                summary = await summarize_day(self.hub, room, cfg, day, self.tz, plan)
                if summary is not None:
                    await self.hub.db.save_room_day(room["id"], day.isoformat(), summary)
                    made += 1
                await asyncio.sleep(0)
            day += timedelta(days=1)
        return made

    async def fill_all(self, days_back: int | None = None) -> int:
        tents = await list_tents(self.hub.db, self.hub)
        rooms_exist = any(t["id"] != "alle" for t in tents)
        yesterday = self.today() - timedelta(days=1)
        back = min(MAX_BACKFILL_DAYS, days_back if days_back is not None else self.retention_days)
        made = 0
        for room in tents:
            made += await self.fill_days(room, yesterday - timedelta(days=back - 1), yesterday, rooms_exist=rooms_exist)
        return made

    async def _loop(self) -> None:
        await asyncio.sleep(60)
        while True:
            try:
                async with self._lock:
                    made = await self.fill_all()
                if made:
                    _LOGGER.info("Tageswerte für %d Tage gespeichert", made)
            except Exception:  # noqa: BLE001
                _LOGGER.exception("Tageswerte: Berechnung fehlgeschlagen")
            now = datetime.now(self.tz)
            run = datetime.combine(now.date() + timedelta(days=1), datetime.min.time(), tzinfo=self.tz)
            await asyncio.sleep(max(60.0, (run - now).total_seconds() + 600))  # 00:10

    # ----------------------------------------------------------------- grows
    async def list(self) -> list[dict[str, Any]]:
        return [self.with_ratios(g) for g in await self.hub.db.list_grows()]

    async def get(self, grow_id: str) -> dict[str, Any]:
        grow = next((g for g in await self.hub.db.list_grows() if g["id"] == grow_id), None)
        if grow is None:
            raise GrowPlanError("Diesen Grow gibt es im Archiv nicht.")
        return self.with_ratios(grow)

    @staticmethod
    def with_ratios(grow: dict[str, Any]) -> dict[str, Any]:
        """Figures that depend on the yield, which may be entered later."""
        stats = dict(grow.get("stats") or {})
        yield_g = grow.get("yield_g")
        watts = stats.get("lamp_watts")
        kwh = stats.get("kwh")
        stats["g_per_watt"] = round(yield_g / watts, 2) if yield_g and watts else None
        stats["g_per_kwh"] = round(yield_g / kwh, 2) if yield_g and kwh else None
        stats["cost_per_g"] = round(stats["cost"] / yield_g, 3) if yield_g and stats.get("cost") else None
        return {**grow, "stats": stats}

    async def archive_plan(self, plan_id: str, raw: dict[str, Any]) -> dict[str, Any]:
        async with self._lock:
            record = self.growplan.get(plan_id)
            plan = record["data"]
            log = await self.growplan.log(plan_id)
            harvested = _date(raw.get("harvested")) or self.today()
            details = self._details(raw)
            tents = await list_tents(self.hub.db, self.hub)
            rooms_exist = any(t["id"] != "alle" for t in tents)
            room_id = record.get("room_id") or ("alle" if not rooms_exist else None)
            room = next((t for t in tents if t["id"] == room_id), None)
            started = self._started(plan, log, record, harvested)
            if room is not None:
                await self.fill_days(room, started, min(harvested, self.today() - timedelta(days=1)),
                                     rooms_exist=rooms_exist)
            stats = await self._stats(plan, log, room, started, harvested)
            now = int(time.time())
            active = [p for p in plan.get("plants", []) if not p.get("gone")]
            strains = sorted({p.get("strain") for p in active if p.get("strain")})
            grow = {
                "id": f"grow-{secrets.token_hex(4)}", "room_id": room_id,
                "room_name": room["name"] if room else None, "plan_name": record.get("name") or "",
                "name": details.get("name") or record.get("name") or (room["name"] if room else "Grow"),
                "strain": details.get("strain", ", ".join(strains)),
                "started": started.isoformat(), "harvested": harvested.isoformat(),
                "flower_start": plan.get("floStart") or None,
                "yield_g": details.get("yield_g"), "rating": details.get("rating"), "notes": details.get("notes", ""),
                "plants": active, "medium": plan.get("medium"), "lamp": plan.get("lamp"), "sched": plan.get("sched"),
                "stats": stats, "plan": plan, "log": log, "created": now, "updated": now,
            }
            await self.hub.db.save_grow(grow)
        if raw.get("reset"):
            await self.growplan.update(plan_id, plan_for_next_grow(plan))
            await self.growplan.clear_log(plan_id)
            if self.watering is not None:
                await self.watering.dismiss(plan_id)
        self.hub.bus.publish("grows", {"changed": True})
        await self.hub.add_event("info", "growplan", f"Grow „{grow['name']}“ abgeschlossen und im Archiv gespeichert.")
        return self.with_ratios(grow)

    @staticmethod
    def _details(raw: dict[str, Any]) -> dict[str, Any]:
        details: dict[str, Any] = {}
        if "name" in raw:
            details["name"] = str(raw.get("name") or "").strip()[:80]
        if "strain" in raw:
            details["strain"] = str(raw.get("strain") or "").strip()[:120]
        if "notes" in raw:
            details["notes"] = str(raw.get("notes") or "").strip()[:4000]
        if "yield_g" in raw:
            value = raw.get("yield_g")
            if value in (None, ""):
                details["yield_g"] = None
            else:
                try:
                    number = float(str(value).replace(",", "."))
                except ValueError as err:
                    raise GrowPlanError("Den Ertrag bitte in Gramm als Zahl angeben.") from err
                if not 0 <= number <= 100000:
                    raise GrowPlanError("Den Ertrag bitte in Gramm angeben (0 bis 100000).")
                details["yield_g"] = round(number, 1)
        if "rating" in raw:
            rating = raw.get("rating")
            details["rating"] = None if rating in (None, "", 0) else max(1, min(5, int(rating)))
        return details

    def _started(self, plan: dict[str, Any], log: list[dict[str, Any]], record: dict[str, Any],
                 harvested: date) -> date:
        candidates = [_date(plan.get("vegStart"))]
        candidates += [_date(p.get("start")) for p in plan.get("plants", [])]
        candidates += [_date(e.get("date")) for e in log]
        found = [d for d in candidates if d is not None and d <= harvested]
        if found:
            return min(found)
        return datetime.fromtimestamp(record["created"], self.tz).date()

    async def _stats(self, plan: dict[str, Any], log: list[dict[str, Any]], room: dict[str, Any] | None,
                     started: date, harvested: date) -> dict[str, Any]:
        flower = _date(plan.get("floStart"))
        veg = _date(plan.get("vegStart")) or started
        waterings = [e for e in log if e.get("type") != "note"]

        def mean(key: str) -> float | None:
            values = [float(e[key]) for e in log if e.get(key) is not None]
            return round(sum(values) / len(values), 2) if values else None

        stats: dict[str, Any] = {
            "days": (harvested - started).days,
            "veg_days": (flower - veg).days if flower and flower >= veg else None,
            "flower_days": (harvested - flower).days if flower and harvested >= flower else None,
            "waterings": len(waterings), "feeds": sum(1 for e in log if e.get("type") == "feed"),
            "liters": round(sum(float(e.get("liters") or 0) for e in waterings), 1),
            "notes": sum(1 for e in log if e.get("type") == "note"),
            "ec_in": mean("ecIn"), "ph_in": mean("phIn"), "ec_out": mean("ecOut"), "ph_out": mean("phOut"),
        }
        lamp = plan.get("lamp") or {}
        watts = float(lamp.get("watt") or 0) * float(plan.get("dim") or 100) / 100
        stats["lamp_watts"] = round(watts) if watts else None
        days = await self.hub.db.room_days(room["id"], started.isoformat(), harvested.isoformat()) if room else []
        today = self.today()
        if room is not None and started <= today <= harvested and all(d["date"] != today.isoformat() for d in days):
            # harvest day: today so far counts too (not stored, the night job makes the whole day)
            tents = await list_tents(self.hub.db, self.hub)
            partial = await summarize_day(self.hub, room, self._cfg(room["id"]), today, self.tz,
                                          self._plan(room["id"], any(t["id"] != "alle" for t in tents)) or plan)
            if partial is not None:
                # light hours and DLI only make sense for a whole day
                partial.pop("light_hours", None)
                partial.pop("dli", None)
                days.append({"date": today.isoformat(), **partial, "partial": True})
        by_date = {d["date"]: d for d in days}
        phases: dict[str, dict[str, list[float]]] = {}
        counted: dict[str, int] = {}
        kwh = 0.0
        day = started
        while day <= harvested:
            summary = by_date.get(day.isoformat())
            phase = "flower" if flower and day >= flower else "veg"
            if summary and summary.get("light_hours") is not None:
                hours = float(summary["light_hours"])
            else:
                position = ("flower", (day - flower).days // 7 + 1) if flower and day >= flower else \
                    ("veg", max(1, (day - veg).days // 7 + 1))
                key = stage_key(position[0], min(position[1], plan.get("floWeeks", 8)), plan.get("floWeeks", 8))
                hours = float(((plan.get("envOv") or {}).get(key) or {}).get("h", ENV[key]["h"]))
            kwh += watts * hours / 1000
            if summary:
                counted[phase] = counted.get(phase, 0) + 1
                bucket = phases.setdefault(phase, {})
                for name, value in (
                    ("temp_day", summary["temp"].get("day")), ("temp_night", summary["temp"].get("night")),
                    ("humi_day", summary["humi"].get("day")), ("humi_night", summary["humi"].get("night")),
                    ("vpd_day", summary["vpd"].get("day")), ("vpd_night", summary["vpd"].get("night")),
                    ("in_temp", summary["in"].get("temp")), ("in_humi", summary["in"].get("humi")),
                    ("in_vpd", summary["in"].get("vpd")), ("dli", summary.get("dli")),
                    ("light_hours", summary.get("light_hours")),
                ):
                    if value is not None:
                        bucket.setdefault(name, []).append(float(value))
            day += timedelta(days=1)
        stats["climate"] = {phase: {name: round(sum(v) / len(v), 3) for name, v in values.items()}
                            | {"days": counted.get(phase, 0)}
                            for phase, values in phases.items()}
        stats["climate_days"] = len(days)
        stats["kwh"] = round(kwh, 1) if watts else None
        price = float(lamp.get("price") or 0)
        stats["cost"] = round(kwh * price, 2) if watts and price else None
        stats["price"] = price or None
        if room is not None:
            start_ts = int(datetime.combine(started, datetime.min.time(), tzinfo=self.tz).timestamp())
            end_ts = int(datetime.combine(harvested + timedelta(days=1), datetime.min.time(), tzinfo=self.tz).timestamp())
            photos = await self.hub.db.list_photos(room_id=room["id"], start=start_ts, end=end_ts, limit=100000)
            stats["photos"] = len(photos)
            if photos:
                stats["photo_first"] = photos[-1]["id"]
                stats["photo_last"] = photos[0]["id"]
                stats["cameras"] = sorted({p["camera_id"] for p in photos})
        return stats

    async def update(self, grow_id: str, raw: dict[str, Any]) -> dict[str, Any]:
        async with self._lock:
            grow = await self.get(grow_id)
            grow.update(self._details(raw))
            harvested = _date(raw.get("harvested")) if "harvested" in raw else None
            if harvested:
                grow["harvested"] = harvested.isoformat()
            grow["updated"] = int(time.time())
            grow.pop("stats", None)
            stored = next(g for g in await self.hub.db.list_grows() if g["id"] == grow_id)
            grow["stats"] = stored.get("stats") or {}
            await self.hub.db.save_grow(grow)
        self.hub.bus.publish("grows", {"changed": True})
        return self.with_ratios(grow)

    async def delete(self, grow_id: str) -> None:
        await self.get(grow_id)
        await self.hub.db.delete_grow(grow_id)
        self.hub.bus.publish("grows", {"changed": True})

    async def csv(self, grow_id: str, lang: str = "de") -> tuple[str, str]:
        grow = await self.get(grow_id)
        log = sorted(grow.get("log") or [], key=lambda e: (e.get("date", ""), e.get("ts", 0)), reverse=True)
        return grow["name"], log_csv(grow.get("plan") or {}, log, lang)

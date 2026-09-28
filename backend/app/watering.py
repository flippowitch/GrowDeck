"""Watering and water: reminders, waterings recognised by the soil probes, empty tanks.

Per Growplan (so per tent):
- remind when the last watering in the log is N days ago (once a day, from a set time);
- remind when the soil moisture of the tent stays below a limit for half an hour;
- recognise a watering when a soil probe jumps up, and offer it as a log entry in Growplan.
For all devices: a humidifier reporting an almost empty tank.

Everything becomes an event of the category "water"; the notifier sends it on.
"""

from __future__ import annotations

import asyncio
import logging
import re
import secrets
import time
from collections import deque
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

from .hub import Hub
from .tent import list_tents, soil_sensors

_LOGGER = logging.getLogger(__name__)

SAMPLE_INTERVAL = 60
WINDOW = 45 * 60           # a watering shows as a rise within this time
RISE = 8.0                 # percentage points
SUGGEST_GAP = 2 * 3600     # at most one recognised watering per tent in this time
SOIL_LOW_FOR = 30 * 60     # soil below the limit this long before a reminder
SOIL_REPEAT = 12 * 3600
MAX_SUGGESTIONS = 5
HHMM = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")

DEFAULTS = {"days": 0, "time": "09:00", "soil_below": None, "detect": True}


def _de(value: float, digits: int = 0) -> str:
    return f"{value:.{digits}f}".replace(".", ",")


def clean_settings(raw: Any) -> dict[str, Any]:
    src = raw if isinstance(raw, dict) else {}
    result = dict(DEFAULTS)
    try:
        result["days"] = max(0, min(30, int(src.get("days", 0) or 0)))
    except (TypeError, ValueError):
        pass
    if isinstance(src.get("time"), str) and HHMM.match(src["time"]):
        result["time"] = src["time"]
    soil = src.get("soil_below")
    if soil not in (None, ""):
        try:
            soil = float(soil)
            result["soil_below"] = soil if 1 <= soil <= 99 else None
        except (TypeError, ValueError):
            result["soil_below"] = None
    result["detect"] = src.get("detect", True) is not False
    return result


class WateringService:
    def __init__(self, hub: Hub, tz: str) -> None:
        self.hub = hub
        self.tz = ZoneInfo(tz)
        self.growplan: Any = None  # set by the app context
        self.settings: dict[str, dict[str, Any]] = {}
        self.suggestions: dict[str, list[dict[str, Any]]] = {}
        self.state: dict[str, dict[str, Any]] = {}
        self._samples: dict[tuple[str, str], deque[tuple[float, float]]] = {}
        self._water_warn: dict[tuple[str, str], bool] = {}
        self._task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        db = self.hub.db
        stored = await db.get_setting("watering", {}) or {}
        self.settings = {k: clean_settings(v) for k, v in stored.items()} if isinstance(stored, dict) else {}
        self.suggestions = await db.get_setting("watering_suggestions", {}) or {}
        self.state = await db.get_setting("watering_state", {}) or {}
        self._task = asyncio.create_task(self._loop(), name="watering")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)

    # --------------------------------------------------------------- settings
    def settings_for(self, plan_id: str) -> dict[str, Any]:
        return dict(self.settings.get(plan_id) or DEFAULTS)

    async def save_settings(self, plan_id: str, raw: Any) -> dict[str, Any]:
        self.settings[plan_id] = clean_settings(raw)
        await self.hub.db.set_setting("watering", self.settings)
        self._publish()
        return self.settings[plan_id]

    def payload(self) -> dict[str, Any]:
        return {"settings": self.settings, "suggestions": self.suggestions}

    def _publish(self) -> None:
        self.hub.bus.publish("watering", self.payload())

    async def dismiss(self, plan_id: str, suggestion_id: str | None = None) -> None:
        items = self.suggestions.get(plan_id) or []
        self.suggestions[plan_id] = [s for s in items if suggestion_id and s["id"] != suggestion_id]
        await self.hub.db.set_setting("watering_suggestions", self.suggestions)
        self._publish()

    async def plan_removed(self, plan_id: str) -> None:
        for store in (self.settings, self.suggestions, self.state):
            store.pop(plan_id, None)
        await self.hub.db.set_setting("watering", self.settings)
        await self.hub.db.set_setting("watering_suggestions", self.suggestions)
        await self.hub.db.set_setting("watering_state", self.state)

    # ------------------------------------------------------------------- loop
    async def _loop(self) -> None:
        await asyncio.sleep(20)
        while True:
            try:
                await self.check()
            except Exception:  # noqa: BLE001
                _LOGGER.exception("Gieß-Erinnerungen: Prüfung fehlgeschlagen")
            await asyncio.sleep(SAMPLE_INTERVAL)

    async def check(self, now: float | None = None) -> None:
        now = time.time() if now is None else now
        await self._check_tanks()
        if self.growplan is None:
            return
        tents = await list_tents(self.hub.db, self.hub)
        rooms_exist = any(t["id"] != "alle" for t in tents)
        changed_state = False
        for room in tents:
            record = self.growplan.plan_for_tent(room["id"], rooms_exist=rooms_exist)
            if record is None:
                continue
            cfg = self.settings_for(record["id"])
            state = self.state.setdefault(record["id"], {})
            probes = soil_sensors(self.hub, room)
            if cfg["detect"]:
                await self._detect(record, room, probes, now)
            if cfg["days"]:
                changed_state |= await self._remind_days(record, room, cfg, state, now)
            if cfg["soil_below"] is not None:
                changed_state |= await self._remind_soil(record, room, cfg, state, probes, now)
        if changed_state:
            await self.hub.db.set_setting("watering_state", self.state)

    # ---------------------------------------------------------- reminders
    def _last_watering(self, plan_id: str) -> dict[str, Any] | None:
        _count, last = self.growplan._meta.get(plan_id, (0, None))
        return last

    async def _remind_days(self, record: dict[str, Any], room: dict[str, Any], cfg: dict[str, Any],
                           state: dict[str, Any], now: float) -> bool:
        local = datetime.fromtimestamp(now, self.tz)
        today = local.date().isoformat()
        if state.get("days_reminded") == today or local.strftime("%H:%M") < cfg["time"]:
            return False
        last = self._last_watering(record["id"])
        if not last or not last.get("date"):
            return False
        try:
            days = (local.date() - date.fromisoformat(last["date"])).days
        except ValueError:
            return False
        if days < cfg["days"]:
            return False
        state["days_reminded"] = today
        when = date.fromisoformat(last["date"]).strftime("%d.%m.")
        await self.hub.add_event("info", "water", f"{room['name']}: Gießen fällig? Letzte Gießung vor {days} "
                                 f"Tagen ({when}).", None, {"room_id": room["id"], "plan_id": record["id"],
                                                            "reminder": "days", "days": days})
        return True

    async def _remind_soil(self, record: dict[str, Any], room: dict[str, Any], cfg: dict[str, Any],
                           state: dict[str, Any], probes: list[tuple[Any, Any]], now: float) -> bool:
        values = [float(s.value) for d, s in probes if d.online and s.value is not None]
        if not values:
            return False
        moisture = sum(values) / len(values)
        limit = cfg["soil_below"]
        if moisture >= limit + 3:  # clearly above again: re-arm
            changed = bool(state.get("soil_since") or state.get("soil_reminded"))
            state.pop("soil_since", None)
            state.pop("soil_reminded", None)
            return changed
        if moisture >= limit:
            return False
        since = state.setdefault("soil_since", now)
        if now - since < SOIL_LOW_FOR or now - float(state.get("soil_reminded") or 0) < SOIL_REPEAT:
            return since == now
        state["soil_reminded"] = now
        await self.hub.add_event("info", "water", f"{room['name']}: Bodenfeuchte {_de(moisture)} % unter "
                                 f"{_de(limit)} %, Zeit zum Gießen.", None,
                                 {"room_id": room["id"], "plan_id": record["id"], "reminder": "soil",
                                  "value": round(moisture, 1)})
        return True

    # ---------------------------------------------------- recognised waterings
    async def _detect(self, record: dict[str, Any], room: dict[str, Any], probes: list[tuple[Any, Any]],
                      now: float) -> None:
        best: tuple[float, Any, Any, float, float] | None = None
        for device, sensor in probes:
            if not device.online or sensor.value is None:
                continue
            key = (device.id, sensor.key)
            samples = self._samples.setdefault(key, deque())
            value = float(sensor.value)
            samples.append((now, value))
            while samples and now - samples[0][0] > WINDOW:
                samples.popleft()
            low = min(v for _t, v in samples)
            rise = value - low
            if rise >= RISE and (best is None or rise > best[0]):
                best = (rise, device, sensor, low, value)
        if best is None:
            return
        items = self.suggestions.setdefault(record["id"], [])
        if items and now - items[-1]["ts"] < SUGGEST_GAP:
            return
        _rise, device, sensor, low, value = best
        local = datetime.fromtimestamp(now, self.tz)
        suggestion = {
            "id": secrets.token_hex(4), "ts": int(now), "date": local.date().isoformat(),
            "time": local.strftime("%H:%M"), "device": device.name, "sensor": sensor.label,
            "before": round(low, 1), "after": round(value, 1),
        }
        items.append(suggestion)
        del items[:-MAX_SUGGESTIONS]
        for d, s in probes:  # the same watering must not count twice
            self._samples.pop((d.id, s.key), None)
        await self.hub.db.set_setting("watering_suggestions", self.suggestions)
        self._publish()
        await self.hub.add_event(
            "info", "water",
            f"{room['name']}: Bodenfeuchte von {_de(low)} % auf {_de(value)} % gestiegen. Gegossen? "
            f"Im Growplan lässt sich die Gießung mit einem Klick eintragen.", device.id,
            {"room_id": room["id"], "plan_id": record["id"], "suggestion": suggestion["id"]})

    # ------------------------------------------------------------- water tank
    async def _check_tanks(self) -> None:
        for device in list(self.hub.devices.values()):
            for control in device.controls.values():
                if "water_warning" not in control.extra:
                    continue
                key = (device.id, control.id)
                warn = bool(control.extra.get("water_warning"))
                before = self._water_warn.get(key)
                self._water_warn[key] = warn
                if warn and before is False or (warn and before is None and device.online):
                    await self.hub.add_event("warning", "water",
                                             f"{device.name}: Wassertank fast leer, bitte nachfüllen.", device.id,
                                             {"control": control.id, "tank": "low"})
                elif before and not warn:
                    await self.hub.add_event("info", "water", f"{device.name}: Wassertank wieder gefüllt.",
                                             device.id, {"control": control.id, "tank": "ok", "resolved": True})

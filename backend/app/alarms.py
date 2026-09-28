"""Alarms. Each alarm and its all-clear becomes an event; the notifier (notify.py) passes
it on to the web address and Telegram.

Two kinds:
- sensor alarms: one sensor, fixed lower and/or upper limit;
- Growplan alarms: temperature, humidity and VPD of a tent against the target ranges of
  the current week of its Growplan (day and night), so the limits move with the plan.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from .growplan import plan_bands
from .hub import CommandError, Hub
from .tent import climate_now, is_day, list_tents

_LOGGER = logging.getLogger(__name__)

EVAL_INTERVAL = 20

# Growplan alarms: label, unit, words below/above the range, room outside the range before
# an alarm ("deutlich daneben"), and the hysteresis before the all-clear.
PLAN_METRICS = {
    "temp": {"label": "Temperatur", "unit": "°C", "words": ("zu kühl", "zu warm"), "margin": 1.0,
             "hyst": 0.3, "digits": 1},
    "humi": {"label": "Luftfeuchte", "unit": "%", "words": ("zu trocken", "zu feucht"), "margin": 5.0,
             "hyst": 1.5, "digits": 0},
    "vpd": {"label": "VPD", "unit": "kPa", "words": ("zu feucht", "zu trocken"), "margin": 0.15,
            "hyst": 0.04, "digits": 2},
}


def _de(value: float, digits: int | None = None) -> str:
    """German number: 31.2 -> 31,2 and 1.27 -> 1,27; 900.0 -> 900."""
    if digits is not None:
        return f"{float(value):.{digits}f}".replace(".", ",")
    return format(round(float(value), 2), "g").replace(".", ",")


def _range(band: list[float], digits: int) -> str:
    def edge(value: float) -> str:
        return _de(value) if digits < 2 else f"{value:.2f}".rstrip("0").rstrip(",.").replace(".", ",") or "0"
    return f"{edge(band[0])}–{edge(band[1])}"


class AlarmEngine:
    def __init__(self, hub: Hub, tz: str = "Europe/Berlin") -> None:
        self.hub = hub
        self.tz = ZoneInfo(tz)
        self.alarms: list[dict[str, Any]] = []
        self.states: dict[str, dict[str, Any]] = {}
        self._task: asyncio.Task[None] | None = None
        # set by the app context
        self.growplan: Any = None
        self.room_control: Any = None

    async def start(self) -> None:
        await self.reload()
        self._task = asyncio.create_task(self._loop(), name="alarms")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)

    async def reload(self) -> None:
        self.alarms = await self.hub.db.list_json("alarms")
        known = {a["id"] for a in self.alarms}
        for alarm_id in list(self.states):
            if alarm_id not in known:
                self.states.pop(alarm_id)

    async def save(self, alarm: dict[str, Any]) -> dict[str, Any]:
        alarm = dict(alarm)
        alarm["id"] = alarm.get("id") or f"a_{uuid.uuid4().hex[:10]}"
        if alarm.get("kind") == "growplan":
            alarm = await self._clean_plan_alarm(alarm)
        else:
            alarm = self._clean_sensor_alarm(alarm)
        alarm.setdefault("enabled", True)
        await self.hub.db.save_json("alarms", alarm["id"], alarm)
        self.states.pop(alarm["id"], None)
        await self.reload()
        return alarm

    @staticmethod
    def _clean_sensor_alarm(alarm: dict[str, Any]) -> dict[str, Any]:
        alarm.pop("kind", None)
        if not alarm.get("device_id") or not alarm.get("sensor"):
            raise CommandError("Wähle einen Sensor für den Alarm.")
        low = alarm.get("min")
        high = alarm.get("max")
        if low in (None, "") and high in (None, ""):
            raise CommandError("Gib mindestens eine untere oder obere Grenze an.")
        try:
            low = None if low in (None, "") else float(low)
            high = None if high in (None, "") else float(high)
            delay = float(alarm.get("delay_minutes", 5) or 0)
        except (TypeError, ValueError) as err:
            raise CommandError("Grenzen und Verzögerung müssen Zahlen sein.") from err
        if low is not None and high is not None and low >= high:
            raise CommandError("Die untere Grenze muss kleiner als die obere sein.")
        alarm.update({"min": low, "max": high, "delay_minutes": max(0.0, min(1440.0, delay))})
        return alarm

    async def _clean_plan_alarm(self, alarm: dict[str, Any]) -> dict[str, Any]:
        tents = {t["id"]: t for t in await list_tents(self.hub.db, self.hub)}
        room_id = str(alarm.get("room_id") or "")
        if room_id not in tents:
            raise CommandError("Wähle das Zelt, dessen Growplan der Alarm folgen soll.")
        metrics = [m for m in PLAN_METRICS if m in (alarm.get("metrics") or [])]
        if not metrics:
            raise CommandError("Wähle mindestens einen Messwert: Temperatur, Luftfeuchte oder VPD.")
        try:
            delay = float(alarm.get("delay_minutes", 30) or 0)
        except (TypeError, ValueError) as err:
            raise CommandError("Die Verzögerung muss eine Zahl sein.") from err
        name = str(alarm.get("name") or "").strip()[:80] or f"{tents[room_id]['name']}: Growplan-Ziele"
        return {"id": alarm["id"], "kind": "growplan", "name": name, "room_id": room_id, "metrics": metrics,
                "delay_minutes": max(0.0, min(1440.0, delay)), "strict": bool(alarm.get("strict")),
                "enabled": alarm.get("enabled", True) is not False}

    async def delete(self, alarm_id: str) -> None:
        await self.hub.db.delete_json("alarms", alarm_id)
        await self.reload()

    async def _loop(self) -> None:
        await asyncio.sleep(5)
        while True:
            try:
                await self.evaluate()
            except Exception:  # noqa: BLE001
                _LOGGER.exception("Alarm evaluation failed")
            await asyncio.sleep(EVAL_INTERVAL)

    async def evaluate(self, now: float | None = None) -> None:
        now = time.time() if now is None else now
        tents: dict[str, dict[str, Any]] | None = None
        for alarm in self.alarms:
            if alarm.get("kind") == "growplan":
                if tents is None:
                    tents = {t["id"]: t for t in await list_tents(self.hub.db, self.hub)}
                await self._evaluate_plan_alarm(alarm, tents, now)
            else:
                await self._evaluate_sensor_alarm(alarm, now)

    # ------------------------------------------------------------ sensor alarms
    async def _evaluate_sensor_alarm(self, alarm: dict[str, Any], now: float) -> None:
        state = self.states.setdefault(alarm["id"], {"firing": False, "out_since": None, "value": None})
        if not alarm.get("enabled", True):
            state.update(firing=False, out_since=None)
            return
        device = self.hub.devices.get(alarm.get("device_id"))
        sensor = device.sensors.get(alarm.get("sensor")) if device else None
        if device is None or not device.online or sensor is None or sensor.value is None:
            return
        value = float(sensor.value)
        state["value"] = value
        low, high = alarm.get("min"), alarm.get("max")
        # Small margin before resolving so values hovering at the limit do not flap.
        margin = 0.02 * max(abs(low or 0), abs(high or 0), 1)
        if state["firing"]:
            out = (low is not None and value < low + margin) or (high is not None and value > high - margin)
        else:
            out = (low is not None and value < low) or (high is not None and value > high)
        if out:
            state["out_since"] = state["out_since"] or now
            if not state["firing"] and now - state["out_since"] >= float(alarm.get("delay_minutes", 5)) * 60:
                state["firing"] = True
                await self._notify(alarm, device, sensor, value, resolved=False)
        else:
            state["out_since"] = None
            if state["firing"]:
                state["firing"] = False
                await self._notify(alarm, device, sensor, value, resolved=True)

    async def _notify(self, alarm: dict[str, Any], device: Any, sensor: Any, value: float,
                      *, resolved: bool) -> None:
        name = alarm.get("name") or f"{device.name}: {sensor.label}"
        unit = f" {sensor.unit}" if sensor.unit else ""
        if resolved:
            message = f"Wieder im Bereich: {name} ({_de(value)}{unit})"
            level = "info"
        else:
            limits = []
            if alarm.get("min") is not None:
                limits.append(f"min {_de(alarm['min'])}")
            if alarm.get("max") is not None:
                limits.append(f"max {_de(alarm['max'])}")
            message = f"Alarm: {name} liegt bei {_de(value)}{unit} ({', '.join(limits)})"
            level = "alarm"
        await self.hub.add_event(level, "alarm", message, device.id,
                                 {"alarm_id": alarm["id"], "value": value, "resolved": resolved,
                                  "sensor": sensor.label, "unit": sensor.unit})

    # ----------------------------------------------------------- Growplan alarms
    async def _evaluate_plan_alarm(self, alarm: dict[str, Any], tents: dict[str, dict[str, Any]],
                                   now: float) -> None:
        state = self.states.setdefault(alarm["id"], {"firing": False, "value": None, "metrics": {},
                                                     "message": None})
        state["message"] = None
        metric_states: dict[str, dict[str, Any]] = state["metrics"]
        room = tents.get(alarm.get("room_id"))
        record = None
        if room is not None and self.growplan is not None:
            record = self.growplan.plan_for_tent(room["id"], rooms_exist=room["id"] != "alle")
        if not alarm.get("enabled", True) or room is None or record is None:
            for ms in metric_states.values():
                ms.update(firing=False, out_since=None)
            state["firing"] = False
            if room is None:
                state["message"] = "Das Zelt gibt es nicht mehr."
            elif record is None and alarm.get("enabled", True):
                state["message"] = "Das Zelt hat keinen Growplan. Der Alarm wartet, bis es einen gibt."
            return
        cfg = self.room_control.config(room["id"]) if self.room_control is not None else {}
        local = datetime.fromtimestamp(now, self.tz)
        bands = plan_bands(record["data"], local.date())
        day, _ = is_day(self.hub, room, cfg, local)
        phase = "day" if day else "night"
        readings = climate_now(self.hub, room, cfg)
        for metric in alarm.get("metrics") or []:
            spec = PLAN_METRICS.get(metric)
            if spec is None:
                continue
            ms = metric_states.setdefault(metric, {"firing": False, "out_since": None, "value": None, "band": None})
            band = bands[metric][phase]
            ms["band"] = band
            ms["phase"] = phase
            value = readings.get(metric)
            if value is None:
                continue
            ms["value"] = value
            margin = 0.0 if alarm.get("strict") else spec["margin"]
            if ms["firing"]:
                keep = max(0.0, margin - spec["hyst"])  # back inside (with a little room) ends the alarm
                out = value < band[0] - keep or value > band[1] + keep
            else:
                out = value < band[0] - margin or value > band[1] + margin
            if out:
                ms["out_since"] = ms["out_since"] or now
                if not ms["firing"] and now - ms["out_since"] >= float(alarm.get("delay_minutes", 30)) * 60:
                    ms["firing"] = True
                    await self._notify_plan(alarm, room, metric, value, band, bands, now - ms["out_since"],
                                            resolved=False)
            else:
                ms["out_since"] = None
                if ms["firing"]:
                    ms["firing"] = False
                    await self._notify_plan(alarm, room, metric, value, band, bands, 0, resolved=True)
        for metric in list(metric_states):
            if metric not in (alarm.get("metrics") or []):
                metric_states.pop(metric)
        state["firing"] = any(ms["firing"] for ms in metric_states.values())

    async def _notify_plan(self, alarm: dict[str, Any], room: dict[str, Any], metric: str, value: float,
                           band: list[float], bands: dict[str, Any], out_for: float, *, resolved: bool) -> None:
        spec = PLAN_METRICS[metric]
        shown = f"{_de(value, spec['digits'])} {spec['unit']}"
        target = f"{_range(band, spec['digits'])} {spec['unit']}"
        if resolved:
            message = f"{room['name']}: {spec['label']} wieder im Ziel ({shown}, Ziel {target})"
            level = "info"
        else:
            word = spec["words"][0] if value < band[0] else spec["words"][1]
            minutes = int(round(out_for / 60))
            since = f", seit {minutes} min" if minutes >= 1 else ""
            message = (f"{room['name']} {word}: {spec['label']} {shown} statt {target} "
                       f"(Growplan, {bands['stage_name']}{since})")
            level = "alarm"
        await self.hub.add_event(level, "alarm", message, None, {
            "alarm_id": alarm["id"], "room_id": room["id"], "metric": metric, "value": value,
            "band": band, "resolved": resolved, "unit": spec["unit"],
        })

    def status(self) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for alarm_id, state in self.states.items():
            item = {k: v for k, v in state.items() if k != "metrics"}
            if "metrics" in state:
                item["metrics"] = {m: dict(ms) for m, ms in state["metrics"].items()}
            result[alarm_id] = item
        return result

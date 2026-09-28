"""Room ("Zelt") climate control across vendors.

One room can hold devices of Spider Farmer, Vivosun and AC Infinity at the same
time. The room control reads the tent climate (one sensor or the average of all
sensors in the room), decides day or night (by clock or by the actual light
state) and drives every assigned output towards common targets:

    heater / cooler         temperature with hysteresis
    humidifier/dehumidifier relative humidity or VPD band, never both at once
    exhaust                 proportional to "too warm / too humid", throttled
                            while the humidifier, heater or CO2 dosing runs
    circulation             fixed day / night level
    co2                     dosing during the day below the target
    light                   read only, tells the others whether it is day

Outputs are commanded through the hub like any user action, so the vendor
adapters stay unaware of each other; GrowDeck is the translator in between.
"""
from __future__ import annotations

import asyncio
import copy
import logging
import math
import time
from datetime import datetime
from collections.abc import Callable
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo

from .tent import climate_now, is_day
from .hub import CommandError

if TYPE_CHECKING:
    from .hub import Hub

_LOGGER = logging.getLogger(__name__)

EVAL_INTERVAL = 10
SWITCH_INTERVAL = 60   # minimum seconds between on/off changes of one output
LEVEL_INTERVAL = 30    # minimum seconds between level changes of one output
RETRY_INTERVAL = 120   # resend after a failed command or a manual change
ERROR_EVENT_INTERVAL = 1800  # at most one warning per output and half hour when commands fail

ROLES = {
    "light": "Licht",
    "exhaust": "Abluft",
    "circulation": "Umluft",
    "humidifier": "Befeuchter",
    "dehumidifier": "Entfeuchter",
    "heater": "Heizung",
    "cooler": "Kühlung",
    "co2": "CO₂",
}
# control type -> suggested role (used by the UI for "Vorschlag")
TYPE_ROLES = {
    "light": "light", "exhaust_fan": "exhaust", "circulation_fan": "circulation",
    "humidifier": "humidifier", "dehumidifier": "dehumidifier", "heater": "heater",
    "air_conditioner": "cooler",
}

DEFAULT_CONFIG: dict[str, Any] = {
    "enabled": False,
    "sensor_mode": "source",        # "source" = climate sensor of the room, "average" = all sensors in the room
    "day_source": "schedule",       # "schedule" = room day window, "light" = light outputs decide
    "humidity_mode": "rh",          # "rh" or "vpd"
    "temp": {"day": 26.0, "night": 21.0, "tolerance": 1.0},
    "humi": {"day": 60.0, "night": 55.0, "tolerance": 4.0},
    "vpd": {"day": 1.2, "night": 0.9, "tolerance": 0.15},
    "co2": {"enabled": False, "day": 900.0, "tolerance": 100.0},
    "plan_targets": False,          # temperature, humidity and VPD follow the tent's grow plan
    "outputs": [],
}


def _de(value: float, digits: int = 1) -> str:
    return f"{value:.{digits}f}".replace(".", ",")


def svp(temp_c: float) -> float:
    return 0.6108 * math.exp(17.27 * temp_c / (temp_c + 237.3))


def rh_for_vpd(temp_c: float, vpd: float) -> float:
    return max(0.0, min(100.0, 100.0 * (1.0 - vpd / svp(temp_c))))


def _number(value: Any, low: float, high: float, label: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as err:
        raise ValueError(f"{label}: bitte eine Zahl eingeben.") from err
    if not (low <= number <= high):
        raise ValueError(f"{label} muss zwischen {_de(low, 2).rstrip('0').rstrip(',')} und "
                         f"{_de(high, 2).rstrip('0').rstrip(',')} liegen.")
    return number


class RoomControl:
    def __init__(self, hub: Hub, tz: str) -> None:
        self.hub = hub
        self.tz = ZoneInfo(tz)
        self.configs: dict[str, dict[str, Any]] = {}
        self.status: dict[str, dict[str, Any]] = {}
        self._memory: dict[tuple[str, str], dict[str, Any]] = {}
        self._task: asyncio.Task | None = None
        self._wake = asyncio.Event()
        # room id -> targets of the tent's grow plan for this week (set by the app context)
        self.plan_targets: Callable[[str], dict[str, Any] | None] | None = None

    # ------------------------------------------------------------- lifecycle
    async def start(self) -> None:
        self.configs = await self.hub.db.list_room_controls()
        self._task = asyncio.create_task(self._loop(), name="room-control")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _loop(self) -> None:
        await asyncio.sleep(3)
        while True:
            try:
                await self.evaluate()
            except Exception:  # noqa: BLE001 - keep controlling the other rooms
                _LOGGER.exception("Zeltsteuerung: Auswertung fehlgeschlagen")
            self._wake.clear()
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=EVAL_INTERVAL)
            except asyncio.TimeoutError:
                pass

    def wake(self) -> None:
        self._wake.set()

    # --------------------------------------------------------------- config
    def config(self, room_id: str) -> dict[str, Any]:
        merged = copy.deepcopy(DEFAULT_CONFIG)
        stored = self.configs.get(room_id) or {}
        for key, value in stored.items():
            if isinstance(value, dict) and isinstance(merged.get(key), dict):
                merged[key].update(value)
            else:
                merged[key] = value
        return merged

    def managed(self) -> dict[tuple[str, str], str]:
        """Outputs driven by an enabled room control -> room id (lights are only read)."""
        result: dict[tuple[str, str], str] = {}
        for room_id, cfg in self.configs.items():
            if not cfg.get("enabled"):
                continue
            for out in cfg.get("outputs") or []:
                if out.get("role") != "light":
                    result[(out["device_id"], out["control_id"])] = room_id
        return result

    def normalize(self, room_id: str, body: dict[str, Any]) -> dict[str, Any]:
        cfg = copy.deepcopy(DEFAULT_CONFIG)
        cfg["enabled"] = bool(body.get("enabled"))
        cfg["plan_targets"] = bool(body.get("plan_targets"))
        for key, allowed in (("sensor_mode", {"source", "average"}), ("day_source", {"schedule", "light"}),
                             ("humidity_mode", {"rh", "vpd"})):
            value = body.get(key, cfg[key])
            if value not in allowed:
                raise ValueError(f"Ungültiger Wert für {key}.")
            cfg[key] = value
        temp = body.get("temp") or {}
        cfg["temp"] = {
            "day": _number(temp.get("day", 26), 5, 40, "Temperatur Tag"),
            "night": _number(temp.get("night", 21), 5, 40, "Temperatur Nacht"),
            "tolerance": _number(temp.get("tolerance", 1), 0.2, 10, "Temperatur-Toleranz"),
        }
        humi = body.get("humi") or {}
        cfg["humi"] = {
            "day": _number(humi.get("day", 60), 20, 95, "Luftfeuchte Tag"),
            "night": _number(humi.get("night", 55), 20, 95, "Luftfeuchte Nacht"),
            "tolerance": _number(humi.get("tolerance", 4), 1, 30, "Feuchte-Toleranz"),
        }
        vpd = body.get("vpd") or {}
        cfg["vpd"] = {
            "day": _number(vpd.get("day", 1.2), 0.2, 3, "VPD Tag"),
            "night": _number(vpd.get("night", 0.9), 0.2, 3, "VPD Nacht"),
            "tolerance": _number(vpd.get("tolerance", 0.15), 0.02, 1, "VPD-Toleranz"),
        }
        co2 = body.get("co2") or {}
        cfg["co2"] = {
            "enabled": bool(co2.get("enabled")),
            "day": _number(co2.get("day", 900), 300, 3000, "CO₂-Ziel"),
            "tolerance": _number(co2.get("tolerance", 100), 10, 1000, "CO₂-Toleranz"),
        }
        outputs = []
        seen: set[tuple[str, str]] = set()
        taken = {k: v for k, v in self.managed().items() if v != room_id}
        for raw in body.get("outputs") or []:
            role = raw.get("role")
            if role not in ROLES:
                raise ValueError("Unbekannte Aufgabe für einen Ausgang.")
            key = (str(raw.get("device_id") or ""), str(raw.get("control_id") or ""))
            if not all(key):
                raise ValueError(f"Wähle einen Ausgang für „{ROLES[role]}“.")
            if key in seen:
                raise ValueError("Ein Ausgang kann nur eine Aufgabe haben.")
            if key in taken and role != "light":
                raise ValueError("Ein Ausgang wird schon von der Zeltsteuerung eines anderen Raums gesteuert.")
            seen.add(key)
            device = self.hub.devices.get(key[0])
            control = device.controls.get(key[1]) if device else None
            if device is not None and control is None:
                raise ValueError(f"{device.name} hat keinen Ausgang „{key[1]}“.")
            out: dict[str, Any] = {"device_id": key[0], "control_id": key[1], "role": role}
            if control is not None and role != "light" and "on_off" not in control.features \
                    and "level" not in control.features:
                raise ValueError(f"„{control.label}“ an {device.name} lässt sich nicht schalten.")
            has_level = control is not None and "level" in control.features
            lo = float(control.level_min) if has_level else 0.0
            hi = float(control.level_max) if has_level else 100.0
            if control is None:
                # device not connected right now: keep the given levels, they are checked when it returns
                lo, hi = 0.0, 100.0
                has_level = any(raw.get(k) is not None for k in ("min_level", "max_level", "day_level", "night_level"))
            if role == "exhaust" and has_level:
                out["min_level"] = _number(raw.get("min_level", lo), lo, hi, "Abluft minimal")
                out["max_level"] = _number(raw.get("max_level", hi), lo, hi, "Abluft maximal")
                if out["min_level"] > out["max_level"]:
                    raise ValueError("Die minimale Abluft-Stufe liegt über der maximalen.")
            if role == "circulation" and has_level:
                out["day_level"] = _number(raw.get("day_level", hi), lo, hi, "Umluft Tag")
                out["night_level"] = _number(raw.get("night_level", lo), lo, hi, "Umluft Nacht")
            outputs.append(out)
        if len(outputs) > 40:
            raise ValueError("Höchstens 40 Ausgänge pro Raum.")
        cfg["outputs"] = outputs
        return cfg

    async def save(self, room_id: str, body: dict[str, Any]) -> dict[str, Any]:
        cfg = self.normalize(room_id, body)
        await self.hub.db.save_room_control(room_id, cfg)
        self.configs[room_id] = cfg
        for key in [k for k in self._memory if k not in self.managed()]:
            self._memory.pop(key, None)
        self.wake()
        return cfg

    async def delete(self, room_id: str) -> None:
        await self.hub.db.delete_room_control(room_id)
        self.configs.pop(room_id, None)
        self.status.pop(room_id, None)

    # --------------------------------------------------------------- inputs
    def _readings(self, room: dict[str, Any], cfg: dict[str, Any]) -> dict[str, Any]:
        return climate_now(self.hub, room, cfg)

    def _is_day(self, room: dict[str, Any], cfg: dict[str, Any], now: datetime) -> tuple[bool, str]:
        return is_day(self.hub, room, cfg, now)

    # ------------------------------------------------------------- decision
    async def evaluate(self) -> None:
        rooms = {r["id"]: r for r in await self.hub.db.list_rooms()}
        now = datetime.now(self.tz)
        for room_id in list(self.status):
            if room_id not in self.configs or room_id not in rooms:
                self.status.pop(room_id, None)
        for room_id in list(self.configs):
            room = rooms.get(room_id)
            if room is None:
                continue
            cfg = self.config(room_id)
            try:
                self.status[room_id] = await self._evaluate_room(room, cfg, now)
            except Exception as err:  # noqa: BLE001
                _LOGGER.exception("Zeltsteuerung %s", room.get("name"))
                self.status[room_id] = {"enabled": cfg["enabled"], "message": f"Fehler: {err}", "outputs": []}
        if self.configs:
            self.hub.bus.publish("room_control", self.status_all())

    def effective(self, room_id: str, cfg: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any] | None]:
        """Config with the grow plan's targets of this week, if the room follows its plan."""
        if not cfg.get("plan_targets") or self.plan_targets is None:
            return cfg, None
        plan = self.plan_targets(room_id)
        if plan is None:
            return cfg, None
        cfg = copy.deepcopy(cfg)
        for key in ("temp", "humi", "vpd"):
            cfg[key] = dict(plan[key])
        source = {k: plan[k] for k in ("plan_id", "stage", "stage_name", "phase", "week", "light_hours",
                                          "leaf_offset", "leaf_vpd")}
        return cfg, source

    async def _evaluate_room(self, room: dict[str, Any], cfg: dict[str, Any], now: datetime) -> dict[str, Any]:
        cfg, plan_source = self.effective(room["id"], cfg)
        readings = self._readings(room, cfg)
        day, day_by = self._is_day(room, cfg, now)
        phase = "day" if day else "night"
        temp_target = cfg["temp"][phase]
        tol_t = cfg["temp"]["tolerance"]
        temp = readings["temp"]
        humi = readings["humi"]
        targets: dict[str, Any] = {"temp": temp_target, "temp_tolerance": tol_t, "vpd": None, "co2": None}
        if cfg["humidity_mode"] == "vpd":
            vpd_target = cfg["vpd"][phase]
            tol_v = cfg["vpd"]["tolerance"]
            base_t = temp if temp is not None else temp_target
            humi_target = rh_for_vpd(base_t, vpd_target)
            humi_high = rh_for_vpd(base_t, max(0.05, vpd_target - tol_v))
            humi_low = rh_for_vpd(base_t, vpd_target + tol_v)
            targets["vpd"] = vpd_target
            targets["vpd_tolerance"] = tol_v
        else:
            humi_target = cfg["humi"][phase]
            humi_high = humi_target + cfg["humi"]["tolerance"]
            humi_low = humi_target - cfg["humi"]["tolerance"]
        targets.update({"humi": round(humi_target, 1), "humi_low": round(humi_low, 1), "humi_high": round(humi_high, 1)})
        co2_cfg = cfg["co2"]
        if co2_cfg["enabled"]:
            targets["co2"] = co2_cfg["day"]

        status: dict[str, Any] = {
            "enabled": cfg["enabled"], "day": day, "day_by": day_by, "readings": readings,
            "targets": targets, "outputs": [], "message": None, "updated": time.time(),
            # day and night targets, e.g. for the target band in the overview charts
            "plan": {key: copy.deepcopy(cfg[key]) for key in
                     ("sensor_mode", "day_source", "humidity_mode", "temp", "humi", "vpd")},
            # set when temperature, humidity and VPD come from the tent's grow plan
            "plan_source": plan_source,
        }
        if cfg.get("plan_targets") and plan_source is None:
            status["message"] = ("Die Ziele sollen aus dem Growplan kommen, aber das Zelt hat noch keinen Growplan. "
                                 "Bis dahin gelten die eingestellten Werte.")
        if temp is None or humi is None:
            status["message"] = "Keine Messwerte für Temperatur und Luftfeuchte im Raum. Die Ausgänge bleiben, wie sie sind."

        def prev_on(out: dict[str, Any]) -> bool:
            mem = self._memory.get((out["device_id"], out["control_id"]))
            if mem is not None and mem.get("want_on") is not None:
                return bool(mem["want_on"])
            device = self.hub.devices.get(out["device_id"])
            control = device.controls.get(out["control_id"]) if device else None
            return bool(control.on) if control is not None else False

        # --- on/off decisions for the climate actors
        decisions: dict[int, tuple[dict[str, Any] | None, str]] = {}
        running: dict[str, bool] = {}
        ok = temp is not None and humi is not None
        order = ["heater", "cooler", "dehumidifier", "humidifier", "co2", "circulation", "exhaust", "light"]
        indexed = sorted(enumerate(cfg["outputs"]), key=lambda item: order.index(item[1]["role"]))
        for index, out in indexed:
            role = out["role"]
            if role == "light":
                decisions[index] = (None, "bestimmt Tag und Nacht" if cfg["day_source"] == "light" else "nur Anzeige")
                continue
            if not ok:
                decisions[index] = (None, "wartet auf Messwerte")
                continue
            was_on = prev_on(out)
            if role == "heater":
                want = temp < temp_target if was_on else temp < temp_target - tol_t
                reason = (f"{_de(temp)} °C unter {_de(temp_target - tol_t)} °C" if want and not was_on else
                          f"heizt bis {_de(temp_target)} °C" if want else "Temperatur im Zielbereich")
            elif role == "cooler":
                want = temp > temp_target if was_on else temp > temp_target + tol_t
                reason = (f"{_de(temp)} °C über {_de(temp_target + tol_t)} °C" if want and not was_on else
                          f"kühlt bis {_de(temp_target)} °C" if want else "Temperatur im Zielbereich")
            elif role == "dehumidifier":
                want = humi > humi_target if was_on else humi > humi_high
                want = want and not running.get("humidifier")
                reason = (f"{_de(humi, 0)} % über {_de(humi_high, 0)} %" if want and not was_on else
                          f"entfeuchtet bis {_de(humi_target, 0)} %" if want else "Luftfeuchte im Zielbereich")
            elif role == "humidifier":
                want = humi < humi_target if was_on else humi < humi_low
                if running.get("dehumidifier"):
                    want = False
                reason = (f"{_de(humi, 0)} % unter {_de(humi_low, 0)} %" if want and not was_on else
                          f"befeuchtet bis {_de(humi_target, 0)} %" if want else "Luftfeuchte im Zielbereich")
                if cfg["humidity_mode"] == "vpd" and readings["vpd"] is not None and want:
                    reason += f" (VPD {_de(readings['vpd'], 2)} kPa)"
            elif role == "co2":
                co2 = readings["co2"]
                if not co2_cfg["enabled"]:
                    want, reason = False, "CO₂-Regelung ist aus"
                elif not day:
                    want, reason = False, "nachts keine CO₂-Zugabe"
                elif co2 is None:
                    want, reason = False, "kein CO₂-Messwert"
                else:
                    target = co2_cfg["day"]
                    want = co2 < target if was_on else co2 < target - co2_cfg["tolerance"]
                    reason = f"{_de(co2, 0)} ppm, Ziel {_de(target, 0)} ppm"
            elif role == "circulation":
                want, reason = True, "Tagbetrieb" if day else "Nachtbetrieb"
            else:  # exhaust handled after all others know whether they run
                continue
            running[role] = running.get(role, False) or want
            decisions[index] = ({"on": want}, reason)

        # --- exhaust: proportional to "too warm / too humid"
        for index, out in indexed:
            if out["role"] != "exhaust" or not ok:
                continue
            span_h = max(1.0, humi_high - humi_target)
            demand = max(0.0, (temp - temp_target) / (2 * tol_t), (humi - humi_target) / (2 * span_h))
            reason = "Grundlüftung"
            if demand > 0:
                parts = []
                if temp > temp_target:
                    parts.append(f"+{_de(temp - temp_target)} °C")
                if humi > humi_target:
                    parts.append(f"+{_de(humi - humi_target, 0)} % Feuchte")
                reason = "zu warm oder feucht: " + ", ".join(parts)
            holders = [ROLES[r] for r in ("humidifier", "heater", "co2") if running.get(r)]
            if holders and (temp <= temp_target + tol_t):
                demand = 0.0
                reason = f"gedrosselt, solange {' und '.join(holders)} läuft"
            demand = min(1.0, demand)
            decisions[index] = ({"demand": demand}, reason)

        # --- apply
        for index, out in enumerate(cfg["outputs"]):
            want, reason = decisions.get(index, (None, ""))
            entry = await self._apply(room, cfg, out, want, reason, day)
            status["outputs"].append(entry)
        return status

    async def _apply(self, room: dict[str, Any], cfg: dict[str, Any], out: dict[str, Any],
                     want: dict[str, Any] | None, reason: str, day: bool) -> dict[str, Any]:
        key = (out["device_id"], out["control_id"])
        device = self.hub.devices.get(out["device_id"])
        control = device.controls.get(out["control_id"]) if device else None
        entry: dict[str, Any] = {
            "device_id": out["device_id"], "control_id": out["control_id"], "role": out["role"],
            "label": control.label if control else out["control_id"],
            "device_name": device.name if device else "Unbekanntes Gerät",
            "vendor": device.vendor if device else None,
            "online": bool(device and device.online),
            "on": control.on if control else None,
            "level": control.level if control else None,
            "reason": reason, "error": None, "want": None,
        }
        if control is None or device is None:
            entry["error"] = "Gerät nicht gefunden."
            return entry
        if want is None:
            return entry
        has_level = "level" in control.features
        patch: dict[str, Any] = {}
        if "demand" in want:
            demand = want["demand"]
            if has_level:
                lo = float(out.get("min_level", control.level_min))
                hi = float(out.get("max_level", control.level_max))
                step = float(control.level_step or 1)
                level = lo + demand * (hi - lo)
                level = round(level / step) * step
                level = max(float(control.level_min), min(float(control.level_max), level))
                patch = {"on": level > 0, "level": level} if level > 0 else {"on": False}
            else:
                mem = self._memory.get(key) or {}
                on = demand >= 0.5 or (bool(mem.get("want_on")) and demand > 0)
                patch = {"on": on}
        elif out["role"] == "circulation" and has_level:
            level = float(out.get("day_level" if day else "night_level", control.level_max))
            patch = {"on": level > 0, "level": level} if level > 0 else {"on": False}
        else:
            patch = {"on": bool(want["on"])}
        entry["want"] = patch
        mem = self._memory.setdefault(key, {"ts": 0.0, "level_ts": 0.0, "want_on": None, "ok": True})
        mem["want_on"] = patch.get("on")
        if not cfg["enabled"]:
            return entry
        if not device.online:
            entry["error"] = f"{device.name} ist offline."
            return entry
        now_ts = time.time()
        on_differs = "on" in patch and control.on is not None and bool(control.on) != bool(patch["on"])
        level_differs = False
        if patch.get("on") and patch.get("level") is not None and control.level is not None:
            span = max(1.0, float(control.level_max) - float(control.level_min))
            level_differs = abs(float(control.level) - float(patch["level"])) >= max(float(control.level_step or 1), span * 0.05)
        if not on_differs and not level_differs:
            mem["ok"] = True
            return entry
        interval = SWITCH_INTERVAL if on_differs else LEVEL_INTERVAL
        last = mem["ts"] if on_differs else mem["level_ts"]
        if not mem.get("ok", True):
            interval = max(interval, RETRY_INTERVAL)
        if now_ts - last < interval:
            return entry
        send = patch if on_differs or not patch.get("on") else {"level": patch["level"], "on": True}
        try:
            await self.hub.command(out["device_id"], out["control_id"], send, source=f"room:{room['id']}")
            mem["ok"] = True
            if on_differs:
                mem["ts"] = now_ts
                await self.hub.add_event(
                    "info", "automation",
                    f"Zeltsteuerung {room['name']}: {ROLES[out['role']]} ({control.label}, {device.name}) "
                    f"{'an' if patch['on'] else 'aus'}, {reason}",
                    out["device_id"], {"room_id": room["id"], "role": out["role"]})
            mem["level_ts"] = now_ts
        except CommandError as err:
            mem["ok"] = False
            mem["ts"] = mem["level_ts"] = now_ts
            entry["error"] = str(err)
            if now_ts - mem.get("error_event", 0) > ERROR_EVENT_INTERVAL:
                mem["error_event"] = now_ts
                await self.hub.add_event(
                    "warning", "automation",
                    f"Zeltsteuerung {room['name']}: {ROLES[out['role']]} ({control.label}, {device.name}) "
                    f"ließ sich nicht schalten: {err}",
                    out["device_id"], {"room_id": room["id"], "role": out["role"]})
        return entry

    def status_all(self) -> dict[str, Any]:
        result = {}
        for room_id, cfg in self.configs.items():
            status = self.status.get(room_id) or {"enabled": cfg.get("enabled"), "outputs": [], "message": "Wird ausgewertet …"}
            result[room_id] = {**status, "enabled": bool(cfg.get("enabled"))}
        return result

"""Vendor-independent automation engine.

Rules have one trigger and one target output:

    threshold  sensor above/below a value, with hysteresis and optional night value
    schedule   daily time window on selected weekdays
    cycle      N minutes on / M minutes off, optionally only inside a time window

Every evaluation computes the desired action per output. If several rules drive
the same output, the rule that is further down the list wins. An action is
sent when the desired action changes, or - with "enforce" - when the device
drifts away from it (e.g. someone switched it in the vendor app).
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from .hub import CommandError, Hub

_LOGGER = logging.getLogger(__name__)

EVAL_INTERVAL = 10
ENFORCE_GRACE = 90
ENFORCE_RETRY = 120


def parse_hhmm(value: Any, default: str = "00:00") -> int:
    text = str(value or default)
    try:
        hours, minutes = text.split(":")[:2]
        return (int(hours) % 24) * 60 + int(minutes) % 60
    except (ValueError, AttributeError):
        hours, minutes = default.split(":")
        return int(hours) * 60 + int(minutes)


def in_window(now: datetime, start: Any, end: Any, days: list[int] | None = None) -> bool:
    """True if `now` lies in [start, end). Windows may cross midnight."""
    s = parse_hhmm(start, "00:00")
    e = parse_hhmm(end, "00:00")
    minute = now.hour * 60 + now.minute
    if s == e:
        inside = True
        day_ref = now
    elif s < e:
        inside = s <= minute < e
        day_ref = now
    else:
        inside = minute >= s or minute < e
        # A window that started yesterday belongs to yesterday's weekday.
        day_ref = now - timedelta(days=1) if minute < e else now
    if days is not None and len(days) < 7:
        return inside and day_ref.weekday() in days
    return inside


def action_label(action: dict[str, Any] | None) -> str:
    if not action:
        return "nichts"
    parts = []
    if "on" in action:
        parts.append("Ein" if action["on"] else "Aus")
    if action.get("level") is not None:
        parts.append(f"Stufe {action['level']:g}" if isinstance(action["level"], int | float) else str(action["level"]))
    if action.get("mode") is not None:
        parts.append(f"Modus {action['mode']}")
    if action.get("option") is not None:
        parts.append(str(action["option"]))
    return ", ".join(parts) or "Änderung"


class RuleState:
    __slots__ = ("active", "value", "since", "error", "last_eval")

    def __init__(self) -> None:
        self.active: bool | None = None
        self.value: float | None = None
        self.since: float | None = None
        self.error: str | None = None
        self.last_eval: float | None = None


class AutomationEngine:
    def __init__(self, hub: Hub, tz: str) -> None:
        self.hub = hub
        self.tz = ZoneInfo(tz)
        self.rules: list[dict[str, Any]] = []
        self.states: dict[str, RuleState] = {}
        self.enabled = True
        # (device_id, control_id) -> {"action", "ts", "rule", "ok"}
        self._sent: dict[tuple[str, str], dict[str, Any]] = {}
        self._mismatch_since: dict[tuple[str, str], float] = {}
        self._task: asyncio.Task[None] | None = None
        self._last_error_event: dict[str, float] = {}
        self._wake = asyncio.Event()
        # set by the app: outputs driven by a room control -> room id
        self.managed = None

    async def start(self) -> None:
        await self.reload()
        self.enabled = bool(await self.hub.db.get_setting("automation_enabled", True))
        self._task = asyncio.create_task(self._loop(), name="automation")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)

    async def reload(self) -> None:
        self.rules = await self.hub.db.list_json("rules")
        known = {r["id"] for r in self.rules}
        for rule_id in list(self.states):
            if rule_id not in known:
                self.states.pop(rule_id, None)
        self._wake.set()

    async def set_enabled(self, enabled: bool) -> None:
        self.enabled = enabled
        await self.hub.db.set_setting("automation_enabled", enabled)
        if enabled:
            self._sent.clear()
            self._wake.set()

    # -------------------------------------------------------------------- crud
    async def save_rule(self, rule: dict[str, Any]) -> dict[str, Any]:
        rule = dict(rule)
        rule_id = rule.get("id") or f"r_{uuid.uuid4().hex[:10]}"
        rule["id"] = rule_id
        self.validate(rule)
        sort = next((i for i, r in enumerate(self.rules) if r["id"] == rule_id), len(self.rules))
        await self.hub.db.save_json("rules", rule_id, rule, sort=sort)
        self.states.pop(rule_id, None)
        await self.reload()
        return rule

    async def delete_rule(self, rule_id: str) -> None:
        await self.hub.db.delete_json("rules", rule_id)
        await self.reload()

    async def reorder(self, ids: list[str]) -> None:
        by_id = {r["id"]: r for r in self.rules}
        for index, rule_id in enumerate(ids):
            if rule_id in by_id:
                await self.hub.db.save_json("rules", rule_id, by_id[rule_id], sort=index)
        await self.reload()

    @staticmethod
    def validate(rule: dict[str, Any]) -> None:
        if not str(rule.get("name", "")).strip():
            raise CommandError("Bitte gib der Regel einen Namen.")
        trigger = rule.get("trigger") or {}
        ttype = trigger.get("type")
        if ttype not in {"threshold", "schedule", "cycle", "device_state"}:
            raise CommandError("Unbekannte Bedingung.")
        if ttype == "device_state":
            if not trigger.get("device_id") or not trigger.get("control_id"):
                raise CommandError("Wähle das Gerät, dessen Zustand die Regel auslöst.")
            if trigger.get("state") not in {"on", "off"}:
                raise CommandError("Wähle „ist an“ oder „ist aus“.")
            target = rule.get("target") or {}
            if (trigger.get("device_id"), trigger.get("control_id")) == (target.get("device_id"), target.get("control_id")):
                raise CommandError("Ein Ausgang kann nicht auf sich selbst reagieren.")
        if ttype == "threshold":
            if not trigger.get("device_id") or not trigger.get("sensor"):
                raise CommandError("Wähle den Sensor, der die Regel auslöst.")
            if trigger.get("op") not in {"above", "below"}:
                raise CommandError("Wähle „über“ oder „unter“.")
            try:
                float(trigger.get("value"))
                float(trigger.get("hysteresis", 0) or 0)
                if trigger.get("night_value") not in (None, ""):
                    float(trigger["night_value"])
            except (TypeError, ValueError) as err:
                raise CommandError("Grenzwerte müssen Zahlen sein.") from err
        if ttype == "cycle":
            try:
                on_m = float(trigger.get("on_minutes"))
                off_m = float(trigger.get("off_minutes"))
            except (TypeError, ValueError) as err:
                raise CommandError("An- und Aus-Dauer müssen Zahlen sein.") from err
            if on_m <= 0 or off_m <= 0:
                raise CommandError("An- und Aus-Dauer müssen größer als 0 sein.")
        target = rule.get("target") or {}
        if not target.get("device_id") or not target.get("control_id"):
            raise CommandError("Wähle das Gerät, das geschaltet werden soll.")
        if not isinstance(rule.get("active_action"), dict) or not rule["active_action"]:
            raise CommandError("Lege fest, was bei erfüllter Bedingung passieren soll.")

    # ---------------------------------------------------------------- evaluate
    async def _loop(self) -> None:
        await asyncio.sleep(3)
        while True:
            try:
                await self.evaluate()
            except Exception:  # noqa: BLE001
                _LOGGER.exception("Automation evaluation failed")
            self._wake.clear()
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=EVAL_INTERVAL)
            except TimeoutError:
                pass

    def _is_day(self, device_id: str | None, now: datetime, rooms: dict[str, dict[str, Any]],
                default_window: tuple[str, str]) -> bool:
        room_id = None
        if device_id and device_id in self.hub.devices:
            room_id = self.hub.devices[device_id].info.get("room_id")
        room = rooms.get(room_id) if room_id else None
        start, end = (room["day_start"], room["day_end"]) if room else default_window
        return in_window(now, start, end)

    def _rule_active(self, rule: dict[str, Any], state: RuleState, now: datetime,
                     rooms: dict[str, dict[str, Any]], default_window: tuple[str, str]) -> bool | None:
        trigger = rule.get("trigger") or {}
        ttype = trigger.get("type")
        days = trigger.get("days")
        if ttype == "schedule":
            return in_window(now, trigger.get("start", "06:00"), trigger.get("end", "00:00"), days)
        if ttype == "cycle":
            if trigger.get("start") and trigger.get("end"):
                if not in_window(now, trigger["start"], trigger["end"], days):
                    return False
                origin = parse_hhmm(trigger["start"])
            else:
                if days is not None and len(days) < 7 and now.weekday() not in days:
                    return False
                origin = 0
            on_s = float(trigger.get("on_minutes", 5)) * 60
            off_s = float(trigger.get("off_minutes", 25)) * 60
            seconds = (now.hour * 3600 + now.minute * 60 + now.second - origin * 60) % 86400
            return (seconds % (on_s + off_s)) < on_s
        if ttype == "device_state":
            device = self.hub.devices.get(trigger.get("device_id"))
            control = device.controls.get(trigger.get("control_id")) if device else None
            if device is None or not device.online or control is None or control.on is None:
                state.value = None
                return None
            if days is not None and len(days) < 7 and now.weekday() not in days:
                return False
            state.value = 1.0 if control.on else 0.0
            return bool(control.on) == (trigger.get("state") == "on")
        if ttype == "threshold":
            device = self.hub.devices.get(trigger.get("device_id"))
            sensor = device.sensors.get(trigger.get("sensor")) if device else None
            if device is None or not device.online or sensor is None or sensor.value is None:
                state.value = None
                return None
            if days is not None and len(days) < 7 and now.weekday() not in days:
                return False
            value = float(sensor.value)
            state.value = value
            threshold = float(trigger.get("value"))
            if trigger.get("night_value") not in (None, ""):
                if not self._is_day(device.id, now, rooms, default_window):
                    threshold = float(trigger["night_value"])
            hysteresis = abs(float(trigger.get("hysteresis", 0) or 0))
            if trigger.get("op") == "above":
                return value > (threshold - hysteresis if state.active else threshold)
            return value < (threshold + hysteresis if state.active else threshold)
        return None

    @staticmethod
    def _satisfied(control: Any, action: dict[str, Any]) -> bool:
        if "on" in action and control.on is not None and bool(control.on) != bool(action["on"]):
            return False
        if action.get("on") is False:
            return True
        if action.get("level") is not None and control.level is not None:
            if abs(float(control.level) - float(action["level"])) > max(0.5, float(control.level_step or 1) / 2):
                return False
        if action.get("mode") is not None and control.mode is not None and str(control.mode) != str(action["mode"]):
            return False
        if action.get("option") is not None and control.value is not None and str(control.value) != str(action["option"]):
            return False
        return True

    async def evaluate(self) -> None:
        now_ts = time.time()
        now = datetime.now(self.tz)
        rooms = {r["id"]: r for r in await self.hub.db.list_rooms()}
        default_window = (
            await self.hub.db.get_setting("day_start", "06:00"),
            await self.hub.db.get_setting("day_end", "00:00"),
        )
        desired: dict[tuple[str, str], tuple[dict[str, Any], dict[str, Any]]] = {}
        for rule in self.rules:
            state = self.states.setdefault(rule["id"], RuleState())
            state.last_eval = now_ts
            if not rule.get("enabled", True):
                state.active = None
                continue
            try:
                active = self._rule_active(rule, state, now, rooms, default_window)
            except (TypeError, ValueError) as err:
                state.error = f"Regel fehlerhaft: {err}"
                continue
            if active is None:
                continue  # sensor missing/offline: keep the last output untouched
            if active != state.active:
                state.since = now_ts
            state.active = active
            action = rule.get("active_action") if active else rule.get("inactive_action")
            target = rule.get("target") or {}
            if action:
                desired[(target.get("device_id"), target.get("control_id"))] = (action, rule)

        if not self.enabled:
            return
        managed = self.managed() if self.managed else {}

        for key, (action, rule) in desired.items():
            device_id, control_id = key
            if key in managed:
                room = rooms.get(managed[key]) or {}
                self.states[rule["id"]].error = (f"Wird von der Zeltsteuerung „{room.get('name', managed[key])}“ "
                                                 "gesteuert. Die Regel schaltet diesen Ausgang nicht.")
                continue
            device = self.hub.devices.get(device_id)
            control = device.controls.get(control_id) if device else None
            state = self.states[rule["id"]]
            if device is None or control is None:
                state.error = "Zielgerät nicht gefunden oder offline."
                continue
            if not device.online:
                state.error = f"{device.name} ist offline."
                continue
            previous = self._sent.get(key)
            changed = previous is None or previous["action"] != action or previous["rule"] != rule["id"]
            satisfied = self._satisfied(control, action)
            if changed:
                self._mismatch_since.pop(key, None)
                if satisfied:
                    self._sent[key] = {"action": action, "ts": now_ts, "rule": rule["id"], "ok": True}
                    state.error = None
                    continue
                await self._send(rule, device.name, control, key, action, now_ts)
                continue
            if satisfied:
                self._mismatch_since.pop(key, None)
                if previous is not None and not previous["ok"]:
                    previous["ok"] = True
                    state.error = None
                continue
            retry_due = now_ts - previous["ts"] >= ENFORCE_RETRY
            if not previous["ok"] and retry_due:
                await self._send(rule, device.name, control, key, action, now_ts)
                continue
            if not rule.get("enforce"):
                continue
            since = self._mismatch_since.setdefault(key, now_ts)
            if now_ts - since >= ENFORCE_GRACE and retry_due:
                await self._send(rule, device.name, control, key, action, now_ts, enforced=True)

    async def _send(self, rule: dict[str, Any], device_name: str, control: Any,
                    key: tuple[str, str], action: dict[str, Any], now_ts: float, enforced: bool = False) -> None:
        state = self.states[rule["id"]]
        patch = {k: v for k, v in action.items() if k in {"on", "level", "mode", "option"} and v is not None}
        try:
            await self.hub.command(key[0], key[1], patch, source=f"automation:{rule['id']}")
            self._sent[key] = {"action": action, "ts": now_ts, "rule": rule["id"], "ok": True}
            state.error = None
            verb = "stellt erneut" if enforced else "schaltet"
            await self.hub.add_event("info", "automation",
                                     f"„{rule.get('name')}“ {verb} {control.label} an {device_name}: {action_label(action)}",
                                     key[0], {"rule_id": rule["id"], "action": action})
        except CommandError as err:
            state.error = str(err)
            self._sent[key] = {"action": action, "ts": now_ts, "rule": rule["id"], "ok": False}
            if now_ts - self._last_error_event.get(rule["id"], 0) > 600:
                self._last_error_event[rule["id"]] = now_ts
                await self.hub.add_event("warning", "automation",
                                         f"„{rule.get('name')}“ konnte nicht schalten: {err}", key[0])

    def status(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "rules": {
                rule_id: {"active": s.active, "value": s.value, "since": s.since, "error": s.error,
                          "last_eval": s.last_eval}
                for rule_id, s in self.states.items()
            },
        }

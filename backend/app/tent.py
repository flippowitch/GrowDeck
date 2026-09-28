"""What GrowDeck knows about one tent (room): its devices, the climate right now, whether it
is day, and which sensors and lights its history is built from.

Without any room, one implicit tent "alle" stands for all devices; its light times are
the ones under Optionen (day_start/day_end). The rules match the overview, so alarms,
reminders and the grow archive see the same values as the readouts and charts.
"""

from __future__ import annotations

import math
from datetime import datetime
from typing import Any

from .automation import in_window
from .db import Database
from .hub import Hub
from .model import Device, Sensor

IMPLICIT = "alle"


def svp(temp_c: float) -> float:
    return 0.6108 * math.exp(17.27 * temp_c / (temp_c + 237.3))


async def list_tents(db: Database, hub: Hub) -> list[dict[str, Any]]:
    rooms = await db.list_rooms()
    if rooms:
        return rooms
    if not any(not d.info.get("hidden") for d in hub.devices.values()):
        return []
    return [{
        "id": IMPLICIT, "name": "Alle Geräte", "climate_device_id": None, "climate_group": None,
        "day_start": await db.get_setting("day_start", "06:00"), "day_end": await db.get_setting("day_end", "00:00"),
        "stage": "veg",
    }]


def tent_devices(hub: Hub, room: dict[str, Any]) -> list[Device]:
    devices = [d for d in hub.devices.values() if not d.info.get("hidden")]
    if room["id"] == IMPLICIT:
        return devices
    return [d for d in devices if d.info.get("room_id") == room["id"]]


def _primary(device: Device, kind: str, group: str | None) -> Sensor | None:
    candidates = [s for s in device.sensors.values() if s.kind == kind and (not group or s.group == group)]
    primary = next((s for s in candidates if "." not in s.key), candidates[0] if candidates else None)
    if primary is None:
        primary = next((s for s in device.sensors.values() if s.kind == kind and "." not in s.key), None)
    return primary


def climate_device(hub: Hub, room: dict[str, Any], online_only: bool = True) -> Device | None:
    in_room = [d for d in tent_devices(hub, room) if d.online or not online_only]
    device = hub.devices.get(room.get("climate_device_id") or "")
    if device is None or (online_only and not device.online):
        device = next((d for d in in_room if d.sensors.get("temp") and d.sensors.get("humi")), None)
        if device is None:
            device = next((d for d in in_room if any(s.kind == "temp" for s in d.sensors.values())
                           and any(s.kind == "humi" for s in d.sensors.values())), None)
    return device


def climate_now(hub: Hub, room: dict[str, Any], cfg: dict[str, Any]) -> dict[str, Any]:
    """Temperature, humidity, VPD and CO₂ of the tent: its climate sensor or the average of all."""
    in_room = [d for d in tent_devices(hub, room) if d.online]
    values: dict[str, list[float]] = {"temp": [], "humi": [], "co2": []}
    sources: list[str] = []
    if cfg.get("sensor_mode") == "average":
        for device in in_room:
            used = False
            for kind in values:
                sensor = device.sensors.get(kind)
                if sensor is not None and sensor.value is not None:
                    values[kind].append(float(sensor.value))
                    used = used or kind in ("temp", "humi")
            if used:
                sources.append(device.name)
    else:
        device = climate_device(hub, room)
        if device is not None and device.online:
            group = room.get("climate_group")
            for kind in values:
                primary = _primary(device, kind, group)
                if primary is None and device.sensors.get(kind) is not None:
                    primary = device.sensors[kind]
                if primary is not None and primary.value is not None:
                    values[kind].append(float(primary.value))
            sources.append(device.name)
    avg = {k: (sum(v) / len(v) if v else None) for k, v in values.items()}
    vpd = None
    if avg["temp"] is not None and avg["humi"] is not None:
        vpd = max(0.0, svp(avg["temp"]) * (1 - avg["humi"] / 100))
    return {"temp": avg["temp"], "humi": avg["humi"], "vpd": vpd, "co2": avg["co2"], "sources": sources}


def light_states(hub: Hub, cfg: dict[str, Any]) -> list[bool]:
    states = []
    for out in cfg.get("outputs") or []:
        if out.get("role") != "light":
            continue
        device = hub.devices.get(out["device_id"])
        control = device.controls.get(out["control_id"]) if device else None
        if device is not None and device.online and control is not None and control.on is not None:
            states.append(bool(control.on) and (control.level is None or control.level > 0))
    return states


def is_day(hub: Hub, room: dict[str, Any], cfg: dict[str, Any], now: datetime) -> tuple[bool, str]:
    if cfg.get("day_source") == "light":
        states = light_states(hub, cfg)
        if states:
            return any(states), "light"
    return in_window(now, room.get("day_start", "06:00"), room.get("day_end", "00:00")), "schedule"


def climate_refs(hub: Hub, room: dict[str, Any], cfg: dict[str, Any]) -> dict[str, list[tuple[str, str]]]:
    """Sensors and lights behind the tent's history (like the overview charts)."""
    devices = tent_devices(hub, room)
    refs: dict[str, list[tuple[str, str]]] = {"temp": [], "humi": [], "vpd": [], "light": [], "ppfd": []}
    with_climate = [d for d in devices if d.sensors.get("temp") and d.sensors.get("humi")]
    if cfg.get("sensor_mode") == "average" and len(with_climate) > 1:
        for device in devices:
            if device.sensors.get("temp"):
                refs["temp"].append((device.id, "temp"))
            if device.sensors.get("humi"):
                refs["humi"].append((device.id, "humi"))
    else:
        device = climate_device(hub, room, online_only=False)
        if device is not None:
            for kind in ("temp", "humi", "vpd"):
                sensor = _primary(device, kind, room.get("climate_group"))
                if sensor is not None:
                    refs[kind].append((device.id, sensor.key))
    source = climate_device(hub, room, online_only=False)
    for device in ([source] if source else []) + [d for d in devices if d is not source]:
        sensor = _primary(device, "ppfd", None)
        if sensor is not None:
            refs["ppfd"].append((device.id, sensor.key))
            break
    configured = [(o["device_id"], o["control_id"]) for o in cfg.get("outputs") or [] if o.get("role") == "light"]
    if configured:
        refs["light"] = configured
    else:
        refs["light"] = [(d.id, c.id) for d in devices for c in d.controls.values()
                         if c.type == "light" and not c.extra.get("empty")]
    return refs


def soil_sensors(hub: Hub, room: dict[str, Any]) -> list[tuple[Device, Sensor]]:
    """Soil moisture probes of the tent; a device's average probe only when it has no single ones."""
    found: list[tuple[Device, Sensor]] = []
    for device in tent_devices(hub, room):
        probes = [s for s in device.sensors.values() if s.kind == "soil_moisture"]
        single = [s for s in probes if "avg" not in s.key]
        for sensor in single or probes:
            found.append((device, sensor))
    return found

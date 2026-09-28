"""Vivosun GrowHub adapter.

Maps AWS IoT shadow documents and point-log telemetry of the Vivosun cloud to
the vendor-neutral device model and translates control changes back into
`state.desired` shadow updates.

Covered device families (by shadow keys, so new models with the same keys work):
    GrowHub controllers (E42A, E42A+, E42, E25): light, cFan, dFan + climate probes
    AeroStream humidifiers (hmdf), AeroFlux heaters (heat),
    AeroDrain dehumidifiers (dhmdf), AeroLush air conditioners (aircd),
    VCure curing boxes (ctlGlass/ctlLight/ctlLock + curing presets),
    GrowCam cameras (listed with their RTSP login, no MQTT control).
"""

from __future__ import annotations

import asyncio
import copy
import logging
import re
import time
from typing import Any

from ...model import Control, Device, make_sensor
from ..base import Adapter, AdapterError
from .cloud import CloudDevice

_LOGGER = logging.getLogger(__name__)

SENTINEL = -6666
CFAN_LEVELS = (0, 44, 51, 60, 64, 70, 75, 80, 85, 90, 100)
DFAN_LEVELS = (0, 30, 35, 40, 50, 60, 70, 80, 85, 90, 100)
NATURAL_WIND = 200
STALE_AFTER = 900

CURE_PRESETS = {
    "quick": ("Quick Cycle", "234193+1756947323"),
    "refine": ("Refine Cycle", "234194+1756947323"),
    "cure": ("Nur Curing", "234195+1756947324"),
    "cold": ("Kaltlagerung", "234196+1756947324"),
    "extract": ("Extrakt-Curing", "234197+1757484248"),
}
AC_FUNCTIONS = {"1": "Kühlen", "2": "Heizen", "3": "Entfeuchten", "4": "Lüften"}

MODEL_NAMES = [
    ("VSCTLA10", "GrowHub A10 Steckdose"),
    ("VSCTLA22", "GrowHub A22 Steckdose"),
    ("VSCTLE42AP", "GrowHub E42A+"),
    ("VSCTLE42A", "GrowHub E42A"),
    ("VSCTLE42", "GrowHub E42"),
    ("VSCTLE25", "GrowHub E25"),
    ("VSCTL", "GrowHub Controller"),
    ("VSHMD", "AeroStream Luftbefeuchter"),
    ("VSHUM", "AeroStream Luftbefeuchter"),
    ("VSHT", "AeroFlux Heizung"),
    ("VSDRY", "AeroDrain Entfeuchter"),
    ("VSACA", "AeroLush Klimagerät"),
    ("VSCB", "VCure Curing-Box"),
]
KIND_FALLBACK_NAMES = {
    "controller": "GrowHub Controller", "humidifier": "AeroStream Luftbefeuchter",
    "heater": "AeroFlux Heizung", "dehumidifier": "AeroDrain Entfeuchter",
    "air_conditioner": "AeroLush Klimagerät", "curing_box": "VCure Curing-Box",
    "camera": "GrowCam", "outlet": "GrowHub Steckdose", "unknown": "Vivosun-Gerät",
}

# Smart plugs (GrowHub A10/A22): their shadow format is not documented anywhere. GrowDeck
# takes every block that looks like a switch: a key named like an outlet with an on/off
# field (or a plain 0/1 value). What it finds is shown as outlets; the raw data under
# "Fehlersuche" shows the format if something is missing.
OUTLET_KEY = re.compile(r"^(outlet|otlt|otl|socket|sckt|skt|plug|plg|sw|switch|relay|port|usb|out)[_-]?(\d{0,2})$",
                        re.I)
ON_FIELDS = ("on", "onOff", "sw", "switch", "power", "pwr", "state", "st")
KNOWN_KEYS = {"light", "cFan", "dFan", "hmdf", "heat", "dhmdf", "aircd", "ctlGlass", "ctlLight", "ctlLock", "cure",
              "plan", "connection", "connected", "netVer", "tUnit", "timeZone", "tz"}


def outlet_blocks(reported: dict[str, Any], any_name: bool) -> list[tuple[str, str | None, bool]]:
    """(key, on field or None for a plain value, on) of everything that looks like a switchable outlet."""
    found = []
    for key, value in reported.items():
        if key in KNOWN_KEYS or not isinstance(key, str):
            continue
        named = bool(OUTLET_KEY.match(key))
        if isinstance(value, dict) and (named or any_name):
            field = next((f for f in ON_FIELDS if isinstance(value.get(f), (bool, int)) and value.get(f) in (0, 1)), None)
            if field is not None:
                found.append((key, field, bool(value[field])))
        elif named and isinstance(value, (bool, int)) and value in (0, 1):
            found.append((key, None, bool(value)))
    return sorted(found, key=lambda item: (item[0].lower().startswith("usb"), item[0]))


def model_name(device: CloudDevice) -> str:
    token = device.model_token.upper()
    for prefix, name in MODEL_NAMES:
        if token.startswith(prefix):
            return name
    return KIND_FALLBACK_NAMES.get(device.device_type, "Vivosun-Gerät")


def deep_merge(target: dict[str, Any], source: dict[str, Any]) -> None:
    for key, value in source.items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            deep_merge(target[key], value)
        else:
            target[key] = copy.deepcopy(value)


def _int(value: Any) -> int | None:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return None if value == SENTINEL else value
    if isinstance(value, float):
        return None if int(value) == SENTINEL else int(value)
    return None


def _scaled(value: Any, factor: float = 100.0) -> float | None:
    number = _int(value)
    return None if number is None else number / factor


def step_from_shadow(value: int | None, table: tuple[int, ...]) -> int | None:
    if value is None:
        return None
    if value <= 0:
        return 0
    return min(range(1, len(table)), key=lambda i: abs(table[i] - value))


class VivosunState:
    def __init__(self, info: CloudDevice) -> None:
        self.info = info
        self.reported: dict[str, Any] = {}
        self.telemetry: dict[str, Any] = {}
        self.last_seen = time.time()
        self.telemetry_at: float | None = None


class VivosunAdapter(Adapter):
    vendor = "vivosun"
    title = "Vivosun"

    def __init__(self, cloud: Any) -> None:
        super().__init__()
        self.cloud = cloud
        self._states: dict[str, VivosunState] = {}
        cloud.on_devices = self._on_devices
        cloud.on_shadow = self._on_shadow
        cloud.on_telemetry = self._on_telemetry

    async def start(self, hub) -> None:  # type: ignore[override]
        await super().start(hub)
        await self.cloud.start()

    async def stop(self) -> None:
        await self.cloud.stop()

    def status(self) -> dict[str, Any]:
        return {
            "vendor": self.vendor,
            "title": self.title,
            "state": self.cloud.state,
            "error": self.cloud.last_error,
            "devices": len(self._states),
            "last_sync": self.cloud.last_sync,
            "simulated": bool(getattr(self.cloud, "simulated", False)),
        }

    # -------------------------------------------------------------- callbacks
    def _on_devices(self, devices: list[CloudDevice]) -> None:
        seen = set()
        for info in devices:
            seen.add(info.device_id)
            state = self._states.get(info.device_id)
            if state is None:
                self._states[info.device_id] = VivosunState(info)
            else:
                state.info = info
            self._publish(info.device_id)
        if self.hub is not None:
            for device_id in list(self._states):
                if device_id not in seen:
                    self._states.pop(device_id, None)
                    self.hub.remove_device(f"vs-{device_id}")

    def _on_shadow(self, device_id: str, fragment: dict[str, Any], full: bool) -> None:
        state = self._states.get(device_id)
        if state is None:
            return
        if full:
            state.reported = copy.deepcopy(fragment)
        else:
            deep_merge(state.reported, fragment)
        state.last_seen = time.time()
        self._publish(device_id)

    def _on_telemetry(self, device_id: str, values: dict[str, Any]) -> None:
        state = self._states.get(device_id)
        if state is None:
            return
        state.telemetry.update(values)
        state.telemetry_at = time.time()
        state.last_seen = time.time()
        self._publish(device_id)

    def _publish(self, device_id: str) -> None:
        state = self._states.get(device_id)
        if state is None or self.hub is None:
            return
        self.hub.update_device(self._build(state))

    # ---------------------------------------------------------------- mapping
    def _build(self, state: VivosunState) -> Device:
        info = state.info
        reported = state.reported
        connected = reported.get("connected")
        if isinstance(reported.get("connection"), dict):
            connected = reported["connection"].get("connected", connected)
        online = info.online if connected is None else bool(connected)
        if self.cloud.state not in ("connected", "degraded"):
            online = False
        device_type = info.device_type
        if device_type == "controller" and not any(k in reported for k in ("light", "cFan", "dFan")) \
                and outlet_blocks(reported, any_name=False):
            device_type = "outlet"  # a smart plug the name did not give away
        device = Device(
            id=f"vs-{info.device_id}",
            vendor=self.vendor,
            native_id=info.device_id,
            model=model_name(info) if device_type == info.device_type else KIND_FALLBACK_NAMES["outlet"],
            kind={"unknown": "controller", "outlet": "outlet_strip"}.get(device_type, device_type),
            name=info.name or model_name(info),
            online=online and (time.time() - state.last_seen < STALE_AFTER or info.device_type == "camera"),
            last_seen=state.last_seen,
            raw={"reported": copy.deepcopy(reported), "telemetry": dict(state.telemetry)},
            config=copy.deepcopy(reported),
            simulated=bool(getattr(self.cloud, "simulated", False)),
        )
        device.info.update({
            "model_token": info.model_token,
            "firmware": reported.get("netVer"),
            "rssi": _int(state.telemetry.get("rssi")),
            "stale_after": STALE_AFTER,
            "telemetry_at": state.telemetry_at,
            "cloud": True,
        })
        if info.device_type == "camera":
            device.online = info.online and self.cloud.state in ("connected", "degraded")
            device.info["camera"] = {
                "username": info.camera_username,
                "password": info.camera_password,
                "hint": "RTSP im LAN: rtsp://<Benutzer>:<Passwort>@<Kamera-IP>:554/",
            }
            return device
        self._build_sensors(device, state)
        self._build_controls(device, reported)
        if device.kind == "outlet_strip":
            self._build_outlets(device, reported)
        return device

    def _build_outlets(self, device: Device, reported: dict[str, Any]) -> None:
        blocks = outlet_blocks(reported, any_name=True)
        plain = [key for key, _field, _on in blocks if not key.lower().startswith("usb")]
        for key, field, on in blocks:
            usb = key.lower().startswith("usb")
            number = plain.index(key) + 1 if key in plain else 0
            label = "USB" if usb else (f"Steckdose {number}" if len(plain) > 1 else "Steckdose")
            block = reported.get(key)
            control = Control(id=f"o:{key}", type="outlet", label=label, on=on, features=["on_off"],
                              native={"key": key, "field": field, "reported": block})
            if isinstance(block, dict) and _int(block.get("mode")) is not None:
                control.modes = [{"key": "0", "label": "Manuell"}] + [
                    {"key": str(m), "label": f"Programm {m} (App)"} for m in range(1, 6)]
                self._mode(control, block.get("mode"))
            device.controls[control.id] = control
        if not blocks and reported:
            device.info["notice"] = ("GrowDeck kennt das Datenformat dieser Steckdose noch nicht und zeigt deshalb "
                                     "keinen Schalter. Unter „Fehlersuche“ stehen die Rohdaten des Geräts; damit "
                                     "lässt sich die Anbindung ergänzen.")

    def _build_sensors(self, device: Device, state: VivosunState) -> None:
        t = state.telemetry
        groups = [("in", "Innen"), ("p", "Sonde"), ("b", "Controller"), ("out", "Außen")]
        primary = next((prefix for prefix, _ in groups if _scaled(t.get(f"{prefix}Temp")) is not None), None)
        for prefix, label in groups:
            temp = _scaled(t.get(f"{prefix}Temp"))
            humi = _scaled(t.get(f"{prefix}Humi"))
            vpd = _scaled(t.get(f"{prefix}Vpd"))
            if temp is None and humi is None:
                continue
            key_prefix = "" if prefix == primary else f"{prefix}."
            group = "Zelt" if prefix == primary and device.kind == "controller" else label
            if device.kind == "curing_box" and prefix == primary:
                group = "Box"
            for kind, value in (("temp", temp), ("humi", humi), ("vpd", vpd)):
                if value is not None:
                    key = f"{key_prefix}{kind}"
                    device.sensors[key] = make_sensor(key, kind, value, group=group)
        water = _int(t.get("waterLv"))
        if water is not None:
            device.sensors["water"] = make_sensor("water", "water", water / 1000.0, group="Tank")
        core = _scaled(t.get("coreTemp"))
        if core is not None:
            device.sensors["core_temp"] = make_sensor("core_temp", "temp", core, label="Gerätetemperatur",
                                                      group="Gerät")
        rssi = _int(t.get("rssi"))
        if rssi is not None:
            device.sensors["rssi"] = make_sensor("rssi", "rssi", rssi, group="Gerät")
        if state.telemetry_at is not None:
            for sensor in device.sensors.values():
                sensor.updated = state.telemetry_at

    def _build_controls(self, device: Device, reported: dict[str, Any]) -> None:
        light = reported.get("light")
        if isinstance(light, dict):
            manu = light.get("manu") if isinstance(light.get("manu"), dict) else {}
            level = _int(light.get("lv"))
            if level is None:
                level = _int(manu.get("lv"))
            control = Control(
                id="light", type="light", label="Licht",
                on=None if level is None else level > 0, level=level,
                level_min=25, level_max=100, level_step=1, level_unit="%",
                modes=[{"key": "0", "label": "Manuell"}, {"key": "1", "label": "Zeitplan (App)"},
                       {"key": "2", "label": "Anbauplan (App)"}],
                features=["on_off", "level", "mode", "spectrum"],
                native={"key": "light", "reported": light},
            )
            spec = _int(manu.get("spec") if "spec" in manu else light.get("spec"))
            control.extra["spectrum"] = spec
            control.extra["in_plan"] = bool(light.get("inPlan"))
            self._mode(control, light.get("mode"))
            if control.extra["in_plan"]:
                control.note = "Ein Anbauplan aus der Vivosun-App ist aktiv und kann manuelle Befehle übersteuern."
            device.controls["light"] = control

        cfan = reported.get("cFan")
        if isinstance(cfan, dict):
            manu = cfan.get("manu") if isinstance(cfan.get("manu"), dict) else {}
            raw = _int(cfan.get("lv"))
            if raw is None:
                raw = _int(manu.get("lv"))
            natural = raw == NATURAL_WIND
            step = None if raw is None else (step_from_shadow(raw, CFAN_LEVELS) if not natural else 10)
            control = Control(
                id="cFan", type="circulation_fan", label="Umluft",
                on=None if raw is None else raw > 0, level=step,
                level_min=1, level_max=10, level_step=1, level_unit="Stufe",
                modes=[{"key": "0", "label": "Manuell"}, {"key": "1", "label": "Zeitplan (App)"},
                       {"key": "2", "label": "Anbauplan (App)"}],
                features=["on_off", "level", "mode", "natural_wind", "oscillate", "night_mode"],
                native={"key": "cFan", "reported": cfan},
            )
            control.extra.update({"natural_wind": natural, "oscillate": bool(cfan.get("osc")),
                                  "night_mode": bool(cfan.get("nw"))})
            self._mode(control, cfan.get("mode"))
            device.controls["cFan"] = control

        dfan = reported.get("dFan")
        if isinstance(dfan, dict):
            manu = dfan.get("manu") if isinstance(dfan.get("manu"), dict) else {}
            raw = _int(dfan.get("lv"))
            if raw is None:
                raw = _int(manu.get("lv"))
            control = Control(
                id="dFan", type="exhaust_fan", label="Abluft",
                on=None if raw is None else raw > 0, level=step_from_shadow(raw, DFAN_LEVELS),
                level_min=1, level_max=10, level_step=1, level_unit="Stufe",
                modes=[{"key": "0", "label": "Manuell"}, {"key": "1", "label": "Automatik"},
                       {"key": "2", "label": "Anbauplan (App)"}],
                features=["on_off", "level", "mode", "vs_dfan_auto"],
                native={"key": "dFan", "reported": dfan},
            )
            auto = dfan.get("auto") if isinstance(dfan.get("auto"), dict) else {}
            control.extra["auto"] = {
                "tMin": _scaled(auto.get("tMin")), "tMax": _scaled(auto.get("tMax")),
                "hMin": _scaled(auto.get("hMin")), "hMax": _scaled(auto.get("hMax")),
                "vpdMin": _scaled(auto.get("vpdMin")), "vpdMax": _scaled(auto.get("vpdMax")),
            }
            self._mode(control, dfan.get("mode"))
            device.controls["dFan"] = control

        hmdf = reported.get("hmdf")
        if isinstance(hmdf, dict):
            manu = hmdf.get("manu") if isinstance(hmdf.get("manu"), dict) else {}
            level = _int(hmdf.get("lv"))
            if level is None or level == 0:
                level = _int(manu.get("lv"))
            control = Control(
                id="hmdf", type="humidifier", label="Befeuchter",
                on=bool(hmdf.get("on")), level=level, level_min=1, level_max=10, level_step=1,
                level_unit="Stufe",
                modes=[{"key": "0", "label": "Manuell"}, {"key": "1", "label": "Automatik"}],
                features=["on_off", "level", "mode", "target_humi"],
                native={"key": "hmdf", "reported": hmdf},
            )
            control.extra.update({"target_humi": _scaled(hmdf.get("targetHumi")),
                                  "water_warning": bool(hmdf.get("waterWarn"))})
            if control.extra["water_warning"]:
                control.note = "Wassertank fast leer."
            self._mode(control, hmdf.get("mode"))
            device.controls["hmdf"] = control

        heat = reported.get("heat")
        if isinstance(heat, dict):
            manu = heat.get("manu") if isinstance(heat.get("manu"), dict) else {}
            level = _int(heat.get("lv"))
            if level is None or level == 0:
                level = _int(manu.get("lv"))
            control = Control(
                id="heat", type="heater", label="Heizung",
                on=bool(heat.get("on")), level=level, level_min=1, level_max=10, level_step=1,
                level_unit="Stufe",
                modes=[{"key": "0", "label": "Manuell"}, {"key": "1", "label": "Automatik"}],
                features=["on_off", "level", "mode", "target_temp"],
                native={"key": "heat", "reported": heat},
            )
            control.extra["target_temp"] = _scaled(heat.get("targetTemp"))
            control.extra["heating"] = bool(heat.get("state"))
            self._mode(control, heat.get("mode"))
            device.controls["heat"] = control

        dhmdf = reported.get("dhmdf")
        if isinstance(dhmdf, dict):
            auto = dhmdf.get("auto") if isinstance(dhmdf.get("auto"), dict) else {}
            pause = _int(dhmdf.get("pause"))
            control = Control(
                id="dhmdf", type="dehumidifier", label="Entfeuchter",
                on=None if pause is None else pause == 0,
                features=["on_off", "target_humi"],
                native={"key": "dhmdf", "reported": dhmdf},
            )
            control.extra["target_humi"] = _scaled(auto.get("tHumi"))
            control.extra["running"] = bool(dhmdf.get("state"))
            device.controls["dhmdf"] = control

        aircd = reported.get("aircd")
        if isinstance(aircd, dict):
            func = _int(aircd.get("func"))
            control = Control(
                id="aircd", type="air_conditioner", label="Klimagerät",
                on=_int(aircd.get("state")) == 1,
                features=["on_off", "option", "target_temp", "target_humi", "fan_level"],
                options=[{"key": k, "label": v} for k, v in AC_FUNCTIONS.items()],
                value=None if func is None else str(func),
                native={"key": "aircd", "reported": aircd},
            )
            control.extra.update({
                "target_temp": _scaled(aircd.get("tTemp")),
                "target_humi": _scaled(aircd.get("tHumi")),
                "fan_level": "quiet" if _int(aircd.get("wdLv")) == 50 else "standard",
                "paused": bool(aircd.get("pause")),
            })
            device.controls["aircd"] = control

        for key, label in (("ctlGlass", "Sichtschutzglas"), ("ctlLight", "Innenlicht"), ("ctlLock", "Türschloss")):
            if key in reported:
                device.controls[key] = Control(id=key, type="switch", label=label,
                                               on=bool(_int(reported.get(key))), features=["on_off"],
                                               native={"key": key})

        if device.kind == "curing_box" or isinstance(reported.get("cure"), dict):
            plan = reported.get("plan") if isinstance(reported.get("plan"), dict) else {}
            stage = plan.get("stage1") if isinstance(plan.get("stage1"), dict) else {}
            cure = reported.get("cure") if isinstance(reported.get("cure"), dict) else {}
            current = "stopped"
            if stage.get("startT") and cure.get("inPlan"):
                prefix = str(stage.get("contId", "")).split("+", 1)[0]
                current = next((k for k, (_, cid) in CURE_PRESETS.items() if cid.split("+")[0] == prefix),
                               "custom")
            options = [{"key": k, "label": v[0]} for k, v in CURE_PRESETS.items()]
            options.append({"key": "stopped", "label": "Gestoppt"})
            device.controls["cure_mode"] = Control(
                id="cure_mode", type="select", label="Curing-Programm", features=["option"],
                options=options, value=current, native={"key": "plan"},
            )

    @staticmethod
    def _mode(control: Control, raw: Any) -> None:
        value = _int(raw)
        if value is None:
            return
        control.mode = str(value)
        control.mode_label = next((m["label"] for m in control.modes if m["key"] == str(value)),
                                  f"Modus {value}")

    # --------------------------------------------------------------- commands
    def _state_for(self, device: Device) -> VivosunState:
        state = self._states.get(device.native_id)
        if state is None:
            raise AdapterError("Gerät ist im Vivosun-Konto nicht mehr vorhanden.")
        return state

    async def _send(self, state: VivosunState, desired: dict[str, Any]) -> None:
        try:
            await self.cloud.publish_desired(state.info.device_id, desired)
        except ConnectionError as err:
            raise AdapterError(str(err)) from err
        # Optimistic merge: AWS echoes desired as update/accepted anyway.
        deep_merge(state.reported, desired)
        for key, block in desired.items():
            target = state.reported.get(key)
            if isinstance(block, dict) and isinstance(block.get("manu"), dict) and isinstance(target, dict):
                if "lv" in block["manu"]:
                    target["lv"] = block["manu"]["lv"]
        self._publish(state.info.device_id)

    async def apply(self, device: Device, control_id: str, patch: dict[str, Any]) -> None:
        state = self._state_for(device)
        control = device.controls.get(control_id)
        if control is None:
            raise AdapterError("Unbekannter Ausgang.")
        desired: dict[str, Any] = {}
        on = patch.get("on")
        level = patch.get("level")

        if control_id == "light":
            block: dict[str, Any] = {}
            if "mode" in patch:
                block["mode"] = int(patch["mode"])
            if level is not None or on is not None:
                if level is None:
                    last = control.level if control.level and control.level > 0 else None
                    manu_lv = _int((control.native.get("reported") or {}).get("manu", {}).get("lv"))
                    level = (last or manu_lv or 60) if on else 0
                elif on is False:
                    level = 0
                lv = int(round(float(level)))
                lv = 0 if lv <= 0 else max(25, min(100, lv))
                block.setdefault("mode", 0)
                block["manu"] = {"lv": lv}
            if "spectrum" in patch:
                block.setdefault("manu", {})["spec"] = max(0, min(100, int(patch["spectrum"])))
            desired["light"] = block
        elif control_id == "cFan":
            block = {}
            if "mode" in patch:
                block["mode"] = int(patch["mode"])
            if patch.get("natural_wind") is True:
                block.update({"mode": 0, "manu": {"lv": NATURAL_WIND}})
            elif level is not None or on is not None or patch.get("natural_wind") is False:
                step = control.level if level is None else level
                step = int(round(float(step or 5)))
                if on is False:
                    step = 0
                block.update({"mode": 0, "manu": {"lv": CFAN_LEVELS[max(0, min(10, step))]}})
            if "oscillate" in patch:
                block["osc"] = 1 if patch["oscillate"] else 0
            if "night_mode" in patch:
                block["nw"] = 1 if patch["night_mode"] else 0
            desired["cFan"] = block
        elif control_id == "dFan":
            block = {}
            if "mode" in patch:
                block["mode"] = int(patch["mode"])
            if level is not None or on is not None:
                step = control.level if level is None else level
                step = int(round(float(step or 5)))
                if on is False:
                    step = 0
                block.update({"mode": block.get("mode", 0), "manu": {"lv": DFAN_LEVELS[max(0, min(10, step))]}})
            if isinstance(patch.get("auto"), dict):
                auto = {}
                for key in ("tMin", "tMax", "hMin", "hMax", "vpdMin", "vpdMax"):
                    if key in patch["auto"]:
                        value = patch["auto"][key]
                        auto[key] = SENTINEL if value is None else int(round(float(value) * 100))
                block["auto"] = auto
            desired["dFan"] = block
        elif control_id in {"hmdf", "heat"}:
            block = {}
            if on is not None:
                block["on"] = 1 if on else 0
            if level is not None:
                lv = max(0, min(10, int(round(float(level)))))
                block.update({"mode": 0, "manu": {"lv": lv}})
                if on is None and lv > 0:
                    block["on"] = 1
            if "mode" in patch:
                block["mode"] = int(patch["mode"])
            if control_id == "hmdf" and "target_humi" in patch:
                block["targetHumi"] = int(round(float(patch["target_humi"]) * 100))
            if control_id == "heat" and "target_temp" in patch:
                block["targetTemp"] = int(round(float(patch["target_temp"]) * 100))
            desired[control_id] = block
        elif control_id == "dhmdf":
            block = {}
            if on is not None:
                block["pause"] = 0 if on else 1
            if "target_humi" in patch:
                block["auto"] = {"tHumi": int(round(float(patch["target_humi"]) * 100))}
            desired["dhmdf"] = block
        elif control_id == "aircd":
            block = {}
            if on is not None:
                block["state"] = 1 if on else 0
                if on and not control.value:
                    block["func"] = 4  # fan only until the user picks a function
            if "option" in patch:
                block.update({"state": 1, "func": int(patch["option"])})
            if "target_temp" in patch:
                value = int(round(float(patch["target_temp"]) * 100))
                if not 1000 <= value <= 4000:
                    raise AdapterError("Zieltemperatur muss zwischen 10 und 40 °C liegen.")
                block["tTemp"] = value
            if "target_humi" in patch:
                block["tHumi"] = max(0, min(10000, int(round(float(patch["target_humi"]) * 100))))
            if "fan_level" in patch:
                block["wdLv"] = 50 if patch["fan_level"] == "quiet" else 100
            desired["aircd"] = block
        elif control_id.startswith("o:"):
            key, field = control.native.get("key"), control.native.get("field")
            if on is None and "mode" not in patch:
                raise AdapterError("Nur Ein/Aus möglich.")
            if field is None:
                if on is None:
                    raise AdapterError("Nur Ein/Aus möglich.")
                desired[key] = 1 if on else 0
            else:
                block = {}
                if on is not None:
                    block[field] = 1 if on else 0
                    if control.mode not in (None, "0"):
                        block["mode"] = 0  # switching by hand means manual, like the app does
                if "mode" in patch:
                    block["mode"] = int(patch["mode"])
                desired[key] = block
        elif control_id in {"ctlGlass", "ctlLight", "ctlLock"}:
            if on is None:
                raise AdapterError("Nur Ein/Aus möglich.")
            desired[control_id] = 1 if on else 0
        elif control_id == "cure_mode":
            option = patch.get("option")
            if option not in {*CURE_PRESETS, "stopped"}:
                raise AdapterError("Unbekanntes Curing-Programm.")
            await self._send(state, {"plan": {"stage1": {"startT": 0}}})
            if option != "stopped":
                await asyncio.sleep(2)
                await self._send(state, {"plan": {"stage1": {"startT": int(time.time()),
                                                             "contId": CURE_PRESETS[option][1]}}})
            return
        else:
            raise AdapterError("Dieser Ausgang wird noch nicht unterstützt.")

        desired = {k: v for k, v in desired.items() if v not in ({}, None)}
        if not desired:
            raise AdapterError("Keine unterstützte Änderung angegeben.")
        await self._send(state, desired)

    async def native(self, device: Device, payload: dict[str, Any]) -> dict[str, Any]:
        state = self._state_for(device)
        action = payload.get("action", "get")
        if action == "get":
            await self.cloud.request_shadow(state.info.device_id)
            return {"reported": copy.deepcopy(state.reported), "telemetry": dict(state.telemetry)}
        if action == "set":
            desired = payload.get("desired")
            if not isinstance(desired, dict) or not desired:
                raise AdapterError("desired muss ein Objekt sein, z. B. {\"light\": {\"mode\": 0}}.")
            await self._send(state, desired)
            return {"desired": desired}
        raise AdapterError("Unbekannte Aktion.")

    async def refresh(self, device: Device) -> None:
        await self.cloud.request_shadow(device.native_id)
        self.cloud.request_poll()

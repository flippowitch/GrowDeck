"""Spider Farmer GGS adapter.

Spider Farmer modules (GGS Controller, AC5/AC10 power strips, Light Controller)
talk MQTT over TLS to the vendor cloud. The `spiderproxy` from Schedule 4 Real
terminates that connection locally and re-publishes everything on the local
broker using this topic layout:

    ggs/<type>/<mac>/status|sensors|system|config|events|down   (device -> us)
    ggs/<type>/<mac>/cmd                                        (us -> device)

Commands use the native firmware methods (getDevSta, getSysSta, getConfigField,
setConfigField). setConfigField REPLACES a whole config section, therefore we
always read the current section first and only change the fields we own.

Capabilities are derived from what a device actually reports, not from its
type, so new GGS models (e.g. the S Station) show up with whatever they send.
"""

from __future__ import annotations

import asyncio
import copy
import itertools
import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any

from ..model import Control, Device, make_sensor
from .base import Adapter, AdapterError
from .mqtt_bus import MqttBus

_LOGGER = logging.getLogger(__name__)

# Status flags in the sensor block (isDaySensor, isDayEnvTarget, ...): 0/1, no readings.
FLAG_KEY = re.compile(r"^is[A-Z]")
DAY_FLAGS = {"isDaySensor": "day", "isDayEnvTarget": "day_targets"}

TYPE_NAMES = {
    "cb": ("GGS Controller", "controller"),
    "ps5": ("GGS Power Strip AC5", "power_strip"),
    "ps10": ("GGS Power Strip AC10", "power_strip"),
    "lc": ("GGS Light Controller", "light_controller"),
    "ss": ("GGS S Station", "power_strip"),
}

OUTLET_MODES = [
    {"key": "0", "label": "Manuell"},
    {"key": "1", "label": "Zeitplan"},
    {"key": "2", "label": "Zyklus"},
    {"key": "3", "label": "Temperatur"},
    {"key": "4", "label": "Luftfeuchte"},
    {"key": "5", "label": "CO₂"},
    {"key": "14", "label": "Bewässerung"},
]
LIGHT_MODES = [
    {"key": "0", "label": "Manuell"},
    {"key": "1", "label": "Zeitplan"},
    {"key": "2", "label": "Zyklus"},
    {"key": "12", "label": "PPFD-Automatik"},
]
FAN_MODES = [
    {"key": "0", "label": "Manuell"},
    {"key": "1", "label": "Zeitplan"},
    {"key": "2", "label": "Zyklus"},
    {"key": "3", "label": "Klima"},
    {"key": "4", "label": "Luftfeuchte"},
    {"key": "7", "label": "Temperatur zuerst"},
    {"key": "8", "label": "Feuchte zuerst"},
    {"key": "13", "label": "Temperatur + Feuchte"},
]
MODULE_MODES = [{"key": "0", "label": "Manuell"}]

MODULES = {
    # key: (control type, label, default config used when the device never sent one)
    "blower": ("exhaust_fan", "Abluft", {"modeType": 0, "minSpeed": 0, "maxSpeed": 0,
                                         "closeCO2": 0, "mOnOff": 0, "mLevel": 50}),
    "fan": ("circulation_fan", "Umluft", {"modeType": 0, "minSpeed": 0, "maxSpeed": 0,
                                          "shakeLevel": 0, "natural": 0, "mOnOff": 0, "mLevel": 5}),
    "heater": ("heater", "Heizung", {"modeType": 0, "mOnOff": 0, "mLevel": 0}),
    "humidifier": ("humidifier", "Befeuchter", {"modeType": 0, "mOnOff": 0, "mLevel": 0}),
    "dehumidifier": ("dehumidifier", "Entfeuchter", {"modeType": 0, "mOnOff": 0, "mLevel": 0}),
}

CONFIG_PATHS = {
    "cb": [["device"], ["target"], ["alarm"], ["system"], ["outlet"], ["plan"]],
    "ps5": [["device"], ["target"], ["light2"], ["plan"]] + [["outlet", f"O{i}"] for i in range(1, 6)],
    "ps10": [["device"], ["target"], ["light2"], ["plan"]] + [["outlet", f"O{i}"] for i in range(1, 11)],
    "lc": [["device"], ["light2"]],
}
DEFAULT_CONFIG_PATHS = [["device"], ["outlet"], ["target"]]

STALE_AFTER = 90


def _num(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int | float):
        return float(value)
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _on(value: dict[str, Any]) -> bool | None:
    for key in ("on", "mOnOff", "isOn"):
        if key in value and value[key] is not None:
            return bool(value[key])
    level = _num(value.get("level", value.get("mLevel")))
    return None if level is None else level > 0


def _level(value: dict[str, Any]) -> float | None:
    for key in ("level", "mLevel", "brightness"):
        number = _num(value.get(key))
        if number is not None:
            return number
    return None


def get_in(data: Any, path: list[str]) -> Any:
    current = data
    for key in path:
        if not isinstance(current, dict) or key not in current:
            return None
        current = current[key]
    return current


def set_in(data: dict[str, Any], path: list[str], value: Any) -> None:
    current = data
    for key in path[:-1]:
        nxt = current.get(key)
        if not isinstance(nxt, dict):
            nxt = {}
            current[key] = nxt
        current = nxt
    current[path[-1]] = value


@dataclass
class SFDevice:
    type: str
    mac: str
    uid: str = ""
    status: dict[str, Any] = field(default_factory=dict)
    config: dict[str, Any] = field(default_factory=dict)
    sys: dict[str, Any] = field(default_factory=dict)
    last_seen: float = field(default_factory=time.time)
    config_fetched: bool = False
    simulated: bool = False


class SpiderFarmerAdapter(Adapter):
    vendor = "spiderfarmer"
    title = "Spider Farmer"

    def __init__(self, bus: MqttBus, *, simulated_macs: set[str] | None = None) -> None:
        super().__init__()
        self.bus = bus
        self._devs: dict[str, SFDevice] = {}
        self._pending: dict[str, tuple[asyncio.Future[dict[str, Any]], list[str] | None]] = {}
        self._msg_counter = itertools.count(1)
        self._last_uid = ""
        self._simulated_macs = simulated_macs or set()
        self._tasks: set[asyncio.Task[Any]] = set()

    # ---------------------------------------------------------------- lifecycle
    async def start(self, hub) -> None:  # type: ignore[override]
        await super().start(hub)
        for kind in ("status", "sensors", "system", "config", "events", "down"):
            self.bus.subscribe(f"ggs/+/+/{kind}", self._on_message)
        await self.bus.start()

    async def stop(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        await self.bus.stop()

    def status(self) -> dict[str, Any]:
        return {
            "vendor": self.vendor,
            "title": self.title,
            "state": "connected" if self.bus.connected else "disconnected",
            "broker": f"{self.bus.host}:{self.bus.port}",
            "error": self.bus.last_error,
            "devices": len(self._devs),
            "messages_in": self.bus.messages_in,
            "messages_out": self.bus.messages_out,
        }

    def _spawn(self, coro: Any) -> None:
        task = asyncio.get_running_loop().create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    # ---------------------------------------------------------------- intake
    def _on_message(self, topic: str, payload: bytes) -> None:
        parts = topic.split("/")
        if len(parts) != 4 or parts[0] != "ggs":
            return
        dtype, mac, kind = parts[1].lower(), parts[2].lower(), parts[3]
        if not mac or dtype.startswith("_") or dtype in {"system", "ha"}:
            return
        try:
            message = json.loads(payload)
        except (ValueError, UnicodeDecodeError):
            return
        if not isinstance(message, dict):
            return

        pending_path: list[str] | None = None
        msg_id = message.get("msgId")
        if msg_id is not None and str(msg_id) in self._pending:
            future, pending_path = self._pending.pop(str(msg_id))
            if not future.done():
                future.set_result(message)

        dev = self._devs.get(mac)
        if dev is None:
            dev = SFDevice(type=dtype, mac=mac, simulated=mac in self._simulated_macs)
            self._devs[mac] = dev
            _LOGGER.info("Spider Farmer Gerät erkannt: %s %s", dtype.upper(), mac)
        dev.type = dtype
        data = message.get("data") if isinstance(message.get("data"), dict) else message
        uid = message.get("uid") or (data.get("uid") if isinstance(data, dict) else None)
        if uid:
            dev.uid = str(uid)
            self._last_uid = dev.uid

        if kind == "status":
            if isinstance(data, dict):
                dev.status.update({k: v for k, v in data.items() if k not in {"uid", "msgId", "method"}})
        elif kind == "sensors":
            if isinstance(data, dict):
                sensor = dict(dev.status.get("sensor") or {})
                sensor.update({k: v for k, v in data.items() if isinstance(v, int | float)})
                dev.status["sensor"] = sensor
        elif kind == "system":
            sys_info = data.get("sys") if isinstance(data, dict) else None
            if isinstance(sys_info, dict):
                dev.sys = sys_info
        elif kind == "config":
            if isinstance(data, dict):
                self._merge_config(dev, data, pending_path)
        elif kind == "down":
            # Commands sent by the Spider Farmer app/cloud: keep our config view in sync.
            if message.get("method") == "setConfigField":
                params = message.get("params") or {}
                path = params.get("keyPath")
                if isinstance(path, list) and path and path[-1] in params:
                    set_in(dev.config, [str(p) for p in path], params[path[-1]])
        # events are not needed for state
        if kind != "down":
            dev.last_seen = time.time()
        self._publish(dev)
        if not dev.config_fetched:
            dev.config_fetched = True
            self._spawn(self._fetch_all_config(dev))

    def _merge_config(self, dev: SFDevice, data: dict[str, Any], path: list[str] | None) -> None:
        if path:
            value = get_in(data, path)
            if value is None and path[-1] in data:
                value = data[path[-1]]
            if value is not None:
                set_in(dev.config, path, value)
                return
        for key, value in data.items():
            if key in {"uid", "msgId", "method", "pid", "UTC", "code"}:
                continue
            if isinstance(value, dict) and isinstance(dev.config.get(key), dict):
                dev.config[key] = {**dev.config[key], **value}
            else:
                dev.config[key] = value

    # ---------------------------------------------------------------- requests
    def _command(self, dev: SFDevice, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        msg_id = f"{int(time.time() * 1000)}{next(self._msg_counter) % 1000:03d}"
        cmd: dict[str, Any] = {
            "method": method,
            "pid": dev.mac.upper(),
            "msgId": msg_id,
            "uid": dev.uid or self._last_uid,
            "UTC": int(time.time()),
        }
        if params is not None:
            cmd["params"] = params
        return cmd

    async def _send(self, dev: SFDevice, cmd: dict[str, Any]) -> None:
        try:
            await self.bus.publish(f"ggs/{dev.type}/{dev.mac}/cmd", json.dumps(cmd, separators=(",", ":")))
        except ConnectionError as err:
            raise AdapterError(str(err)) from err

    async def _request(self, dev: SFDevice, method: str, params: dict[str, Any] | None = None,
                       timeout: float = 5.0, path: list[str] | None = None) -> dict[str, Any] | None:
        cmd = self._command(dev, method, params)
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[cmd["msgId"]] = (future, path)
        try:
            await self._send(dev, cmd)
            return await asyncio.wait_for(future, timeout)
        except (TimeoutError, AdapterError):
            return None
        finally:
            self._pending.pop(cmd["msgId"], None)

    async def get_config(self, dev: SFDevice, path: list[str], timeout: float = 4.0) -> Any:
        response = await self._request(dev, "getConfigField", {"keyPath": path}, timeout, path)
        if response is None:
            return None
        data = response.get("data") if isinstance(response.get("data"), dict) else response
        value = get_in(data, path)
        if value is None and isinstance(data, dict) and path[-1] in data:
            value = data[path[-1]]
        if value is not None:
            set_in(dev.config, path, value)
            self._publish(dev)
        return value

    async def set_config(self, dev: SFDevice, path: list[str], value: dict[str, Any]) -> None:
        cmd = self._command(dev, "setConfigField", {"keyPath": path, path[-1]: value})
        await self._send(dev, cmd)
        set_in(dev.config, path, copy.deepcopy(value))
        self._spawn(self._verify_later(dev, path))

    async def _verify_later(self, dev: SFDevice, path: list[str]) -> None:
        await asyncio.sleep(1.5)
        await self.get_config(dev, path, timeout=4.0)
        await self._request(dev, "getDevSta", None, timeout=4.0)

    async def _fetch_all_config(self, dev: SFDevice) -> None:
        await asyncio.sleep(0.5)
        paths = CONFIG_PATHS.get(dev.type, DEFAULT_CONFIG_PATHS)
        results = await asyncio.gather(*(self.get_config(dev, p) for p in paths), return_exceptions=True)
        missing = sum(1 for r in results if r is None or isinstance(r, Exception))
        if missing == len(paths):
            _LOGGER.info("Keine Konfiguration von %s %s erhalten, neuer Versuch später",
                         dev.type, dev.mac)
            await asyncio.sleep(60)
            dev.config_fetched = False
        else:
            await self._request(dev, "getSysSta", None, timeout=4.0)

    async def refresh(self, device: Device) -> None:
        dev = self._devs.get(device.native_id)
        if dev is None:
            return
        dev.config_fetched = True
        await self._fetch_all_config(dev)
        await self._request(dev, "getDevSta", None, timeout=4.0)

    # ---------------------------------------------------------------- mapping
    def _publish(self, dev: SFDevice) -> None:
        if self.hub is None:
            return
        self.hub.update_device(self._build(dev))

    def _build(self, dev: SFDevice) -> Device:
        model, kind = TYPE_NAMES.get(dev.type, (f"GGS {dev.type.upper()}", "controller"))
        status = dev.status
        config = dev.config
        device = Device(
            id=f"sf-{dev.mac}",
            vendor=self.vendor,
            native_id=dev.mac,
            model=model,
            kind=kind,
            name=f"{model} {dev.mac[-4:].upper()}",
            online=time.time() - dev.last_seen < STALE_AFTER,
            last_seen=dev.last_seen,
            raw=copy.deepcopy(status),
            config=copy.deepcopy(config),
            simulated=dev.simulated,
        )
        device.info.update({
            "type": dev.type,
            "mac": dev.mac,
            "firmware": dev.sys.get("ver"),
            "rssi": (dev.sys.get("wifi") or {}).get("rssi") if isinstance(dev.sys.get("wifi"), dict) else None,
            "uptime": dev.sys.get("upTime"),
            "stale_after": STALE_AFTER,
        })
        self._build_sensors(device, status)
        self._build_controls(device, dev, status, config)
        return device

    def _build_sensors(self, device: Device, status: dict[str, Any]) -> None:
        sensor = status.get("sensor") if isinstance(status.get("sensor"), dict) else {}
        known = {"temp": "temp", "humi": "humi", "vpd": "vpd", "co2": "co2", "ppfd": "ppfd"}
        for key, kind in known.items():
            value = _num(sensor.get(key))
            if value is not None:
                device.sensors[key] = make_sensor(key, kind, value, group="Zelt")
        for key, value in sensor.items():
            number = _num(value)
            if key in known or number is None or key in {"uid"}:
                continue
            if FLAG_KEY.match(key):
                # Status flags such as isDaySensor/isDayEnvTarget are not readings.
                if key in DAY_FLAGS:
                    device.info[DAY_FLAGS[key]] = bool(number)
                continue
            label = {"leafVpd": "Blatt-VPD", "vpdLeaf": "Blatt-VPD", "dewPoint": "Taupunkt"}.get(key, key)
            kind = "vpd" if "vpd" in key.lower() else ("temp" if "temp" in key.lower() else "other")
            device.sensors[f"sensor.{key}"] = make_sensor(f"sensor.{key}", kind, number,
                                                          label=label, group="Zelt")
        soil = status.get("sensors")
        if isinstance(soil, list):
            for item in soil:
                if not isinstance(item, dict):
                    continue
                sid = str(item.get("id", "?"))
                group = "Boden Ø" if sid == "avg" else f"Bodensonde {sid}"
                prefix = "soil_avg" if sid == "avg" else f"soil{sid}"
                for field_key, kind in (("tempSoil", "soil_temp"), ("humiSoil", "soil_moisture"),
                                        ("ECSoil", "soil_ec")):
                    value = _num(item.get(field_key))
                    if value is not None:
                        key = f"{prefix}.{kind.split('_')[1]}"
                        device.sensors[key] = make_sensor(key, kind, value, group=group)

    def _build_controls(self, device: Device, dev: SFDevice, status: dict[str, Any],
                        config: dict[str, Any]) -> None:
        dev_cfg = config.get("device") if isinstance(config.get("device"), dict) else {}

        # Lights ------------------------------------------------------------
        light_sources: list[tuple[str, dict[str, Any] | None, list[str], str]] = [
            ("light", status.get("light") if isinstance(status.get("light"), dict) else None,
             ["device", "light"], "Licht 1"),
            ("light2", status.get("light2") if isinstance(status.get("light2"), dict) else None,
             ["light2"], "Licht 2"),
        ]
        if light_sources[0][1] is None and ("brightness" in status or "mode" in status):
            # Light Controller reports a flat structure.
            light_sources[0] = ("light", {"modeType": status.get("mode"), "level": status.get("brightness")},
                                ["device", "light"], "Licht 1")
        for cid, state, path, label in light_sources:
            cfg = get_in(config, path)
            if state is None and not isinstance(cfg, dict):
                continue
            state = state or {}
            cfg = cfg if isinstance(cfg, dict) else {}
            mode_raw = cfg.get("modeType", state.get("modeType"))
            control = Control(
                id=cid, type="light", label=label,
                on=_on(state) if state else _on(cfg),
                level=_level(state) if _level(state) is not None else _level(cfg),
                level_min=0, level_max=100, level_step=1, level_unit="%",
                modes=LIGHT_MODES, features=["on_off", "level", "mode", "sf_schedule"],
                native={"keyPath": path, "config": cfg, "state": state},
            )
            self._set_mode(control, mode_raw, LIGHT_MODES)
            device.controls[cid] = control

        # Modules (blower, fan, heater, humidifier, dehumidifier) ------------
        for key, (ctype, label, _defaults) in MODULES.items():
            state = status.get(key) if isinstance(status.get(key), dict) else None
            cfg = dev_cfg.get(key) if isinstance(dev_cfg.get(key), dict) else None
            if state is None and cfg is None:
                continue
            state = state or {}
            cfg = cfg or {}
            level = _level(state)
            if level is None:
                level = _level(cfg)
            control = Control(id=key, type=ctype, label=label, on=_on(state) if state else _on(cfg),
                              level=level, native={"keyPath": ["device", key], "config": cfg, "state": state})
            if key == "blower":
                control.level_min, control.level_max, control.level_step = 25, 100, 1
                control.features = ["on_off", "level", "mode", "sf_schedule"]
                control.modes = FAN_MODES
                control.extra["close_co2"] = bool(cfg.get("closeCO2", state.get("closeCO2", 0)))
            elif key == "fan":
                control.level_min, control.level_max, control.level_step = 1, 10, 1
                control.level_unit = "Stufe"
                control.features = ["on_off", "level", "mode", "natural_wind", "sf_schedule"]
                control.modes = FAN_MODES
                control.extra["natural_wind"] = bool(cfg.get("natural", state.get("natural", 0)))
                control.extra["oscillation"] = cfg.get("shakeLevel", state.get("shakeLevel"))
            else:
                control.features = ["on_off", "mode"]
                control.modes = MODULE_MODES
            self._set_mode(control, cfg.get("modeType", state.get("modeType")), control.modes)
            device.controls[key] = control

        # Outlets -------------------------------------------------------------
        outlets = status.get("outlet") if isinstance(status.get("outlet"), dict) else {}
        outlet_cfg = config.get("outlet") if isinstance(config.get("outlet"), dict) else {}
        keys = sorted(
            {k for k in outlets if k.startswith("O")} | {k for k in outlet_cfg if k.startswith("O")},
            key=lambda k: int(k[1:]) if k[1:].isdigit() else 99,
        )
        for key in keys:
            state = outlets.get(key) if isinstance(outlets.get(key), dict) else {}
            cfg = outlet_cfg.get(key) if isinstance(outlet_cfg.get(key), dict) else {}
            number = key[1:]
            control = Control(
                id=key, type="outlet", label=f"Steckdose {number}",
                on=_on(state) if state else _on(cfg),
                modes=OUTLET_MODES, features=["on_off", "mode", "sf_outlet"],
                native={"keyPath": ["outlet", key], "config": cfg, "state": state},
            )
            self._set_mode(control, cfg.get("modeType", state.get("modeType")), OUTLET_MODES)
            device.controls[key] = control

        # Power strips attached to a controller (read-only mirror).
        for strip in ("ps5", "ps10"):
            nested = status.get(strip)
            if not isinstance(nested, dict):
                continue
            for key, state in nested.items():
                if not (key.startswith("O") and isinstance(state, dict)):
                    continue
                cid = f"{strip}.{key}"
                control = Control(id=cid, type="outlet",
                                  label=f"{strip.upper()} Steckdose {key[1:]}", on=_on(state),
                                  features=[], native={"state": state},
                                  note="Wird über die Steckdosenleiste selbst geschaltet.")
                self._set_mode(control, state.get("modeType"), OUTLET_MODES)
                device.controls[cid] = control

    @staticmethod
    def _set_mode(control: Control, raw: Any, modes: list[dict[str, str]]) -> None:
        if raw is None:
            return
        key = str(int(raw)) if isinstance(raw, int | float) else str(raw)
        control.mode = key
        label = next((m["label"] for m in modes if m["key"] == key), None)
        if key == "99":
            label = "Automatik (Schedule 4 Real)"
        control.mode_label = label or f"Modus {key}"

    # ---------------------------------------------------------------- commands
    def _dev_for(self, device: Device) -> SFDevice:
        dev = self._devs.get(device.native_id)
        if dev is None:
            raise AdapterError("Gerät ist nicht mehr verbunden.")
        return dev

    async def _current(self, dev: SFDevice, path: list[str], defaults: dict[str, Any] | None = None) -> dict[str, Any]:
        cached = get_in(dev.config, path)
        if not isinstance(cached, dict):
            cached = await self.get_config(dev, path, timeout=3.0)
        base = copy.deepcopy(cached) if isinstance(cached, dict) else {}
        if defaults:
            for key, value in defaults.items():
                base.setdefault(key, value)
        return base

    async def apply(self, device: Device, control_id: str, patch: dict[str, Any]) -> None:
        dev = self._dev_for(device)
        control = device.controls.get(control_id)
        if control is None:
            raise AdapterError("Unbekannter Ausgang.")
        if not control.features:
            raise AdapterError(control.note or "Dieser Ausgang ist nur lesbar.")

        path = list(control.native.get("keyPath") or [])
        if not path:
            raise AdapterError("Für diesen Ausgang fehlt die Zuordnung.")
        defaults = MODULES[control_id][2] if control_id in MODULES else None
        cfg = await self._current(dev, path, defaults)

        on = patch.get("on")
        level = patch.get("level")
        if "mode" in patch:
            cfg["modeType"] = int(patch["mode"])
        elif on is not None or level is not None:
            # A manual change always switches the channel to manual mode.
            cfg["modeType"] = 0

        if control.type == "light":
            if level is not None:
                lv = int(round(float(level)))
                cfg["mLevel"] = lv
                if "level" in cfg:
                    cfg["level"] = lv
                if on is None:
                    on = lv > 0
                periods = cfg.get("timePeriod")
                if isinstance(periods, list) and periods:
                    idx = next((i for i, p in enumerate(periods) if isinstance(p, dict) and p.get("enabled")), 0)
                    if isinstance(periods[idx], dict):
                        periods[idx]["brightness"] = lv
            if on is not None:
                cfg["mOnOff"] = 1 if on else 0
                if "on" in cfg:
                    cfg["on"] = cfg["mOnOff"]
        elif control_id == "blower":
            if level is not None:
                lv = int(round(float(level)))
                if 0 < lv < 25:
                    lv = 25
                cfg["mLevel"] = max(0, min(100, lv))
                if on is None:
                    on = lv > 0
            if on is not None:
                cfg["mOnOff"] = 1 if on else 0
                if on and not cfg.get("mLevel"):
                    cfg["mLevel"] = 50
            if "close_co2" in patch:
                cfg["closeCO2"] = 1 if patch["close_co2"] else 0
        elif control_id == "fan":
            if level is not None:
                lv = int(round(float(level)))
                cfg["mLevel"] = max(1, min(10, lv)) if lv > 0 else 0
                if on is None:
                    on = lv > 0
            if on is not None:
                cfg["mOnOff"] = 1 if on else 0
                if on and not cfg.get("mLevel"):
                    cfg["mLevel"] = 5
            if "natural_wind" in patch:
                cfg["natural"] = 1 if patch["natural_wind"] else 0
        elif control_id in MODULES:
            if on is not None:
                cfg["mOnOff"] = 1 if on else 0
                if not on:
                    cfg["mLevel"] = 0
        elif control.type == "outlet":
            if on is not None:
                cfg["mOnOff"] = 1 if on else 0
        else:
            raise AdapterError("Dieser Ausgang wird noch nicht unterstützt.")

        await self.set_config(dev, path, cfg)
        self._optimistic(dev, control_id, control.type, cfg)
        self._publish(dev)

    def _optimistic(self, dev: SFDevice, control_id: str, ctype: str, cfg: dict[str, Any]) -> None:
        """Mirror the command in the cached status until the device reports back."""
        on = cfg.get("mOnOff")
        level = cfg.get("mLevel")
        if ctype == "outlet":
            outlets = dict(dev.status.get("outlet") or {})
            state = dict(outlets.get(control_id) or {})
            state.update({"on": on, "modeType": cfg.get("modeType")})
            outlets[control_id] = state
            dev.status["outlet"] = outlets
            return
        target = control_id
        state = dict(dev.status.get(target) or {})
        if on is not None:
            state["on"] = on
        if level is not None and not (ctype in {"heater", "humidifier", "dehumidifier"}):
            state["level"] = level
        state["modeType"] = cfg.get("modeType")
        if target == "light" and "brightness" in dev.status and "light" not in dev.status:
            dev.status["brightness"] = level if on else 0
            dev.status["mode"] = cfg.get("modeType")
            return
        dev.status[target] = state

    async def native(self, device: Device, payload: dict[str, Any]) -> dict[str, Any]:
        dev = self._dev_for(device)
        action = payload.get("action", "get")
        path = payload.get("keyPath")
        if not isinstance(path, list) or not path or not all(isinstance(p, str) for p in path):
            raise AdapterError("keyPath muss eine Liste von Namen sein, z. B. [\"outlet\", \"O1\"].")
        if action == "get":
            value = await self.get_config(dev, path, timeout=5.0)
            if value is None:
                raise AdapterError("Das Gerät hat nicht geantwortet.")
            return {"keyPath": path, "value": value}
        if action == "set":
            value = payload.get("value")
            if not isinstance(value, dict):
                raise AdapterError("value muss ein Objekt sein.")
            await self.set_config(dev, path, value)
            self._publish(dev)
            return {"keyPath": path, "value": value}
        raise AdapterError("Unbekannte Aktion.")

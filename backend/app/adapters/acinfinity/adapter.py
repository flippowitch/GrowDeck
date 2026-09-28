"""AC Infinity adapter (UIS cloud).

Covers every controller that syncs to the AC Infinity cloud:
    Controller 69 WiFi / 69 Pro / 69 Pro+ (UIS ports with levels 0-10),
    Controller AI+ (UIS ports plus plug-in sensors and sensor modes),
    UIS Outlet AI / AI+ (switched outlets).
Bluetooth-only controllers (Controller 67, 69 without WiFi) never reach the
cloud and therefore cannot appear here.

Each controller becomes one device. Each port becomes one control with on/off,
the "on" level, the controller's mode (Off, On, Auto, timers, cycle, schedule,
VPD and the AI sensor modes) and an editor for the mode settings.
"""
from __future__ import annotations

import logging
import time
from typing import Any

from ...model import Control, Device, make_sensor
from ..base import Adapter, AdapterError
from .cloud import ACInfinityCloud, flatten_settings
from .vendor.const import AI_CONTROLLER_TYPES, AtType, ControllerType

_LOGGER = logging.getLogger(__name__)

MODEL_NAMES = {
    ControllerType.UIS_69_PRO: "Controller 69 Pro",
    ControllerType.UIS_69_PRO_PLUS: "Controller 69 Pro+",
    ControllerType.UIS_89_AI_PLUS: "Controller AI+",
    ControllerType.UIS_OUTLET_AI: "Outlet AI",
    ControllerType.UIS_OUTLET_AI_PLUS: "Outlet AI+",
}
OUTLET_TYPES = {ControllerType.UIS_OUTLET_AI, ControllerType.UIS_OUTLET_AI_PLUS}

MODE_LABELS = {
    AtType.OFF: "Aus", AtType.ON: "An", AtType.AUTO: "Auto", AtType.TIMER_TO_ON: "Timer bis An",
    AtType.TIMER_TO_OFF: "Timer bis Aus", AtType.CYCLE: "Zyklus", AtType.SCHEDULE: "Zeitplan",
    AtType.VPD: "VPD", AtType.CO2: "CO₂", AtType.CO2_FAN: "CO₂-Lüfter", AtType.MOISTURE: "Bodenfeuchte",
    AtType.WATER_TEMP: "Wassertemperatur", AtType.PH: "pH", AtType.EC: "EC/TDS",
    AtType.WATER_DETECT: "Wassermelder",
}
BASE_MODES = [AtType.OFF, AtType.ON, AtType.AUTO, AtType.TIMER_TO_ON, AtType.TIMER_TO_OFF,
              AtType.CYCLE, AtType.SCHEDULE, AtType.VPD]

# port load types (device type chosen in the app) -> GrowDeck control type
LOAD_TYPES = {
    1: "light", 2: "humidifier", 3: "dehumidifier", 4: "heater", 5: "air_conditioner", 6: "exhaust_fan",
    8: "outlet", 128: "outlet", 129: "light", 130: "humidifier", 131: "dehumidifier", 132: "heater",
    133: "air_conditioner", 134: "circulation_fan", 135: "exhaust_fan", 136: "outlet", 137: "outlet",
    138: "switch",
}

# AI plug-in sensor types -> (key, kind, label, group)
SENSOR_MAP = {
    0: ("temp", "temp", None, "Zelt"), 1: ("temp", "temp", None, "Zelt"),
    2: ("humi", "humi", None, "Zelt"), 3: ("vpd", "vpd", None, "Zelt"),
    4: ("ctl.temp", "temp", "Temperatur", "Controller"), 5: ("ctl.temp", "temp", "Temperatur", "Controller"),
    6: ("ctl.humi", "humi", "Luftfeuchte", "Controller"), 7: ("ctl.vpd", "vpd", "VPD", "Controller"),
    11: ("co2", "co2", None, "Zelt"), 12: ("light", "light", "Licht", "Zelt"),
    13: ("hydro.ph", "ph", "pH-Wert", "Wasser"), 14: ("hydro.ec", "ec", "EC", "Wasser"),
    15: ("hydro.ec", "ec", "EC", "Wasser"), 16: ("hydro.tds", "tds", "TDS", "Wasser"),
    17: ("hydro.tds", "tds", "TDS", "Wasser"), 18: ("hydro.temp", "temp", "Wassertemperatur", "Wasser"),
    19: ("hydro.temp", "temp", "Wassertemperatur", "Wasser"),
}
SENSOR_MODES = {  # sensor type -> modes it unlocks on AI controllers
    11: [AtType.CO2, AtType.CO2_FAN], 10: [AtType.MOISTURE], 18: [AtType.WATER_TEMP],
    19: [AtType.WATER_TEMP], 13: [AtType.PH], 14: [AtType.EC], 15: [AtType.EC], 16: [AtType.EC],
    17: [AtType.EC], 20: [AtType.WATER_DETECT],
}


def _num(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def sensor_value(sensor: dict[str, Any]) -> float | None:
    data = _num(sensor.get("sensorData"))
    if data is None:
        return None
    precision = int(sensor.get("sensorPrecision") or 1)
    value = data / (10 ** (precision - 1)) if precision > 1 else data
    if sensor.get("sensorType") in (0, 4, 18) or (sensor.get("sensorType") in (1, 5, 19)
                                                  and int(sensor.get("sensorUnit") or 0) == 0):
        value = (value - 32) * 5 / 9  # Fahrenheit reading
    if sensor.get("sensorType") == 14:
        value = value / 1000  # µS/cm -> mS/cm
    if sensor.get("sensorType") == 17:
        value = value * 1000  # ppt -> ppm
    return round(value, 3)


def _minutes_to_time(value: Any) -> str | None:
    number = _num(value)
    if number is None or int(number) == 65535 or int(number) // 60 > 23:
        return None
    return f"{int(number) // 60:02d}:{int(number) % 60:02d}"


def _time_to_minutes(value: Any) -> int:
    if not value:
        return 65535
    try:
        hours, minutes = (int(x) for x in str(value).split(":")[:2])
    except ValueError as err:
        raise AdapterError(f"Ungültige Uhrzeit „{value}“.") from err
    if not (0 <= hours <= 23 and 0 <= minutes <= 59):
        raise AdapterError(f"Ungültige Uhrzeit „{value}“.")
    return hours * 60 + minutes


def _check(value: Any, low: float, high: float, label: str) -> float:
    number = _num(value)
    if number is None or not (low <= number <= high):
        raise AdapterError(f"{label} muss zwischen {low:g} und {high:g} liegen.")
    return number


def _flag(value: Any) -> int:
    return 1 if value else 0


def settings_to_editor(settings: dict[str, Any], *, ai: bool, outlet: bool) -> dict[str, Any]:
    f = flatten_settings(settings)

    def on(key: str) -> bool:
        return bool(int(_num(f.get(key)) or 0))

    def scaled(key: str, factor: float) -> float | None:
        number = _num(f.get(key))
        return None if number is None else round(number / factor, 2)

    data: dict[str, Any] = {
        "mode": str(int(_num(f.get("atType")) or AtType.OFF)),
        "on_speed": _num(f.get("onSelfSpead" if ai else "onSpead")),
        "off_speed": None if ai or outlet else _num(f.get("offSpead")),
        "auto": {
            "temp_high": _num(f.get("devHt")), "temp_high_on": on("activeHt"),
            "temp_low": _num(f.get("devLt")), "temp_low_on": on("activeLt"),
            "humi_high": _num(f.get("devHh")), "humi_high_on": on("activeHh"),
            "humi_low": _num(f.get("devLh")), "humi_low_on": on("activeLh"),
            "target_mode": int(_num(f.get("settingMode")) or 0) == 1,
            "target_temp": _num(f.get("targetTemp")), "target_temp_on": on("targetTSwitch"),
            "target_humi": _num(f.get("targetHumi")), "target_humi_on": on("targetHumiSwitch"),
        },
        "vpd": {
            "high": scaled("activeHtVpdNums", 10), "high_on": on("activeHtVpd"),
            "low": scaled("activeLtVpdNums", 10), "low_on": on("activeLtVpd"),
            "target_mode": int(_num(f.get("vpdSettingMode")) or 0) == 1,
            "target": scaled("targetVpd", 10), "target_on": on("targetVpdSwitch"),
        },
        "timer": {"to_on": scaled("acitveTimerOn", 60), "to_off": scaled("acitveTimerOff", 60)},
        "cycle": {"on": scaled("activeCycleOn", 60), "off": scaled("activeCycleOff", 60)},
        "schedule": {"start": _minutes_to_time(f.get("schedStartTime")), "end": _minutes_to_time(f.get("schedEndtTime"))},
        "ai": None,
    }
    if ai:
        data["ai"] = {
            "co2_low": _num(f.get("co2LowValue")), "co2_low_on": on("co2LowSwitch"),
            "co2_fan_high": _num(f.get("co2FanHighValue")), "co2_fan_high_on": on("co2FanHighSwitch"),
            "moisture_low": _num(f.get("moistureLowValue")), "moisture_low_on": on("moistureLowSwitch"),
            "water_temp_high": _num(f.get("waterTempHighValue")), "water_temp_high_on": on("waterTempHighSwitch"),
            "water_temp_low": _num(f.get("waterTempLowValue")), "water_temp_low_on": on("waterTempLowSwitch"),
            "ph_high": scaled("phHighValue", 10), "ph_high_on": on("phHighSwitch"),
            "ph_low": scaled("phLowValue", 10), "ph_low_on": on("phLowSwitch"),
        }
    return data


def editor_to_settings(value: dict[str, Any], *, ai: bool, outlet: bool, modes: list[int]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if value.get("mode") not in (None, ""):
        mode = int(_check(value["mode"], 1, 15, "Modus"))
        if mode not in modes:
            raise AdapterError("Diesen Modus unterstützt der Port nicht.")
        out["atType"] = mode
    if value.get("on_speed") is not None and not outlet:
        out["onSelfSpead" if ai else "onSpead"] = int(_check(value["on_speed"], 0, 10, "Stufe bei An"))
    if value.get("off_speed") is not None and not ai and not outlet:
        out["offSpead"] = int(_check(value["off_speed"], 0, 10, "Stufe bei Aus"))

    def temp_pair(src: dict[str, Any], key: str, c_key: str, f_key: str, label: str) -> None:
        if src.get(key) is not None:
            celsius = int(round(_check(src[key], 0, 90, label)))
            out[c_key] = celsius
            out[f_key] = int(round(celsius * 1.8 + 32))

    auto = value.get("auto") or {}
    temp_pair(auto, "temp_high", "devHt", "devHtf", "Temperatur oben")
    temp_pair(auto, "temp_low", "devLt", "devLtf", "Temperatur unten")
    temp_pair(auto, "target_temp", "targetTemp", "targetTempF", "Zieltemperatur")
    for key, api_key, label in (("humi_high", "devHh", "Luftfeuchte oben"), ("humi_low", "devLh", "Luftfeuchte unten"),
                                ("target_humi", "targetHumi", "Zielfeuchte")):
        if auto.get(key) is not None:
            out[api_key] = int(round(_check(auto[key], 0, 100, label)))
    for key, api_key in (("temp_high_on", "activeHt"), ("temp_low_on", "activeLt"), ("humi_high_on", "activeHh"),
                         ("humi_low_on", "activeLh"), ("target_temp_on", "targetTSwitch"),
                         ("target_humi_on", "targetHumiSwitch")):
        if key in auto:
            out[api_key] = _flag(auto[key])
    if "target_mode" in auto:
        out["settingMode"] = _flag(auto["target_mode"])

    vpd = value.get("vpd") or {}
    for key, api_key, label in (("high", "activeHtVpdNums", "VPD oben"), ("low", "activeLtVpdNums", "VPD unten"),
                                ("target", "targetVpd", "Ziel-VPD")):
        if vpd.get(key) is not None:
            out[api_key] = int(round(_check(vpd[key], 0, 9.9, label) * 10))
    for key, api_key in (("high_on", "activeHtVpd"), ("low_on", "activeLtVpd"), ("target_on", "targetVpdSwitch")):
        if key in vpd:
            out[api_key] = _flag(vpd[key])
    if "target_mode" in vpd:
        out["vpdSettingMode"] = _flag(vpd["target_mode"])

    for group, fields in (("timer", (("to_on", "acitveTimerOn", "Timer bis An"), ("to_off", "acitveTimerOff", "Timer bis Aus"))),
                          ("cycle", (("on", "activeCycleOn", "Zyklus an"), ("off", "activeCycleOff", "Zyklus aus")))):
        src = value.get(group) or {}
        for key, api_key, label in fields:
            if src.get(key) is not None:
                out[api_key] = int(round(_check(src[key], 0, 1440, f"{label} (Minuten)") * 60))

    schedule = value.get("schedule")
    if isinstance(schedule, dict):
        if "start" in schedule:
            out["schedStartTime"] = _time_to_minutes(schedule.get("start"))
        if "end" in schedule:
            out["schedEndtTime"] = _time_to_minutes(schedule.get("end"))

    extra = value.get("ai") or {}
    if ai and extra:
        for key, api_key, low, high, factor, label in (
            ("co2_low", "co2LowValue", 0, 9999, 1, "CO₂ unten"),
            ("co2_fan_high", "co2FanHighValue", 0, 9999, 1, "CO₂ oben"),
            ("moisture_low", "moistureLowValue", 0, 100, 1, "Bodenfeuchte unten"),
            ("ph_high", "phHighValue", 0, 14, 10, "pH oben"),
            ("ph_low", "phLowValue", 0, 14, 10, "pH unten"),
        ):
            if extra.get(key) is not None:
                out[api_key] = int(round(_check(extra[key], low, high, label) * factor))
        temp_pair(extra, "water_temp_high", "waterTempHighValue", "waterTempHighValueF", "Wassertemperatur oben")
        temp_pair(extra, "water_temp_low", "waterTempLowValue", "waterTempLowValueF", "Wassertemperatur unten")
        for key, api_key in (("co2_low_on", "co2LowSwitch"), ("co2_fan_high_on", "co2FanHighSwitch"),
                             ("moisture_low_on", "moistureLowSwitch"), ("water_temp_high_on", "waterTempHighSwitch"),
                             ("water_temp_low_on", "waterTempLowSwitch"), ("ph_high_on", "phHighSwitch"),
                             ("ph_low_on", "phLowSwitch")):
            if key in extra:
                out[api_key] = _flag(extra[key])
    return out


class ACInfinityAdapter(Adapter):
    vendor = "acinfinity"
    title = "AC Infinity"

    def __init__(self, cloud: ACInfinityCloud) -> None:
        super().__init__()
        self.cloud = cloud
        self._known: set[str] = set()
        cloud.on_update = self._publish_all

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
            "devices": len(self.cloud.controllers),
            "last_sync": self.cloud.last_sync,
            "poll_interval": self.cloud.poll_interval,
            "simulated": self.cloud.simulated,
        }

    # ---------------------------------------------------------------- mapping
    def _publish_all(self) -> None:
        if self.hub is None:
            return
        seen = set()
        for controller_id, controller in self.cloud.controllers.items():
            try:
                device = self._build(controller_id, controller)
            except Exception:  # noqa: BLE001 - one odd controller must not hide the others
                _LOGGER.exception("AC Infinity: Controller %s konnte nicht gelesen werden", controller_id)
                continue
            seen.add(device.id)
            self.hub.update_device(device)
        for device_id in self._known - seen:
            self.hub.remove_device(device_id)
        self._known = seen

    @staticmethod
    def _is_ai(controller: dict[str, Any]) -> bool:
        return controller.get("devType") in AI_CONTROLLER_TYPES

    def _modes(self, controller: dict[str, Any], current: int | None) -> list[int]:
        modes = list(BASE_MODES)
        if self._is_ai(controller):
            for sensor in (controller.get("deviceInfo") or {}).get("sensors") or []:
                for mode in SENSOR_MODES.get(sensor.get("sensorType"), []):
                    if mode not in modes:
                        modes.append(mode)
        if current and current not in modes and current in MODE_LABELS:
            modes.append(current)
        return modes

    def _build(self, controller_id: str, controller: dict[str, Any]) -> Device:
        info = controller.get("deviceInfo") or {}
        dev_type = controller.get("devType")
        ai = self._is_ai(controller)
        outlet = dev_type in OUTLET_TYPES
        model = MODEL_NAMES.get(dev_type, f"UIS-Controller (Typ {dev_type})")
        online = int(_num(controller.get("online")) or 0) == 1 and self.cloud.state == "connected"
        device = Device(
            id=f"aci-{controller_id}",
            vendor=self.vendor,
            native_id=controller_id,
            model=model,
            kind="outlet_strip" if outlet else "controller",
            name=controller.get("devName") or model,
            online=online,
            last_seen=self.cloud.last_sync or time.time(),
            raw={"controller": controller},
            config={"ports": {str(port): flatten_settings(s) for (cid, port), s in self.cloud.port_settings.items()
                              if cid == controller_id}},
            simulated=self.cloud.simulated,
        )
        device.info.update({
            "firmware": controller.get("firmwareVersion"),
            "hardware": controller.get("hardwareVersion"),
            "mac": controller.get("devMacAddr"),
            "timezone": controller.get("zoneId"),
            "controller_type": dev_type,
            "cloud": True,
            "stale_after": max(180, self.cloud.poll_interval * 12),
        })

        # ------------------------------------------------------------ sensors
        sensors = info.get("sensors") or []
        by_key: dict[str, tuple[int, Any]] = {}
        for sensor in sensors:
            stype = sensor.get("sensorType")
            port = sensor.get("accessPort")
            if stype == 10:
                key, kind, label, group = f"soil{port}.moisture", "soil_moisture", "Bodenfeuchte", f"Bodensensor {port}"
            elif stype == 20:
                key, kind, label, group = f"leak{port}", "leak", "Wassermelder", "Wasser"
            elif stype in SENSOR_MAP:
                key, kind, label, group = SENSOR_MAP[stype]
            else:
                continue
            value = sensor_value(sensor)
            if stype == 20 and value is not None:
                value = 1.0 if value else 0.0
            # prefer Celsius readings when the API sends both units
            rank = 1 if stype in (1, 5, 19) else 0
            if key in by_key and by_key[key][0] > rank:
                continue
            by_key[key] = (rank, make_sensor(key, kind, value, label=label, group=group))
        if "temp" not in by_key and _num(info.get("temperature")) is not None:
            by_key["temp"] = (0, make_sensor("temp", "temp", _num(info["temperature"]) / 100, group="Zelt"))
        if "humi" not in by_key and _num(info.get("humidity")) is not None:
            by_key["humi"] = (0, make_sensor("humi", "humi", _num(info["humidity"]) / 100, group="Zelt"))
        if "vpd" not in by_key and _num(info.get("vpdnums")) is not None:
            by_key["vpd"] = (0, make_sensor("vpd", "vpd", _num(info["vpdnums"]) / 100, group="Zelt"))
        order = ["temp", "humi", "vpd", "co2", "light"]
        for key in sorted(by_key, key=lambda k: (order.index(k) if k in order else len(order), k)):
            device.sensors[key] = by_key[key][1]

        # ----------------------------------------------------------- controls
        for port_json in info.get("ports") or []:
            port = int(port_json.get("port") or 0)
            if port <= 0:
                continue
            raw_settings = self.cloud.port_settings.get((controller_id, port)) or {}
            settings = flatten_settings(raw_settings)
            at_type = int(_num(settings.get("atType")) or _num(port_json.get("curMode")) or 0) or None
            # the device type chosen in the app lives in the device settings
            load_type = (raw_settings.get("devSetting") or {}).get("loadType",
                                                                   settings.get("loadType", port_json.get("loadType")))
            ctype = LOAD_TYPES.get(int(_num(load_type) or 0)) or ("outlet" if outlet else "exhaust_fan")
            speak = _num(port_json.get("speak"))
            running = (speak or 0) > 0 or int(_num(port_json.get("loadState")) or 0) == 1
            modes = self._modes(controller, at_type)
            features = ["on_off", "mode", "aci_port"]
            if not outlet:
                features.insert(1, "level")
            note = None
            if int(_num(port_json.get("overcurrentStatus")) or 0):
                note = "Überstrom erkannt, der Port wurde abgeschaltet."
            elif int(_num(port_json.get("abnormalState")) or 0):
                note = "Das angeschlossene Gerät meldet eine Störung."
            elif int(_num(port_json.get("online")) or 0) == 0 and not outlet:
                note = "An diesem Port ist kein Gerät erkannt."
            remaining = int(_num(port_json.get("remainTime")) or 0)
            if note is None and remaining > 0 and at_type in (AtType.TIMER_TO_ON, AtType.TIMER_TO_OFF, AtType.CYCLE):
                minutes = max(1, round(remaining / 60))
                note = f"Nächster Wechsel in {minutes} min."
            label = port_json.get("portName") or f"Port {port}"
            device.controls[f"p{port}"] = Control(
                id=f"p{port}",
                type=ctype,
                label=label,
                on=running,
                level=None if outlet else _num(settings.get("onSelfSpead" if ai else "onSpead")),
                level_min=0,
                level_max=10,
                level_step=1,
                level_unit="Stufe",
                mode=str(at_type) if at_type else None,
                mode_label=MODE_LABELS.get(at_type) if at_type else None,
                modes=[{"key": str(m), "label": MODE_LABELS[m]} for m in modes],
                features=features,
                extra={
                    "current_level": None if outlet else speak,
                    "level_caption": None if outlet else "Stufe im Modus An",
                    "remaining": remaining or None,
                    "port": port,
                    "empty": int(_num(port_json.get("online")) or 0) == 0 and not outlet,
                },
                native={"controller_id": controller_id, "port": port, "ai": ai, "outlet": outlet},
                note=note,
            )
        return device

    # --------------------------------------------------------------- commands
    def _target(self, device: Device, control_id: str) -> tuple[str, int, bool, bool, Control]:
        control = device.controls.get(control_id)
        if control is None or "aci_port" not in control.features:
            raise AdapterError("Unbekannter Port.")
        native = control.native
        return native["controller_id"], int(native["port"]), bool(native["ai"]), bool(native["outlet"]), control

    async def apply(self, device: Device, control_id: str, patch: dict[str, Any]) -> None:
        controller_id, port, ai, outlet, control = self._target(device, control_id)
        settings = flatten_settings(self.cloud.port_settings.get((controller_id, port)))
        current_mode = int(_num(settings.get("atType")) or _num(control.mode) or AtType.OFF)
        allowed = [int(m["key"]) for m in control.modes]
        values: dict[str, Any] = {}
        if patch.get("mode") is not None:
            mode = int(_num(patch["mode"]) or 0)
            if mode not in allowed:
                raise AdapterError("Diesen Modus unterstützt der Port nicht.")
            values["atType"] = mode
        if patch.get("level") is not None:
            if outlet:
                raise AdapterError("Steckdosen lassen sich nur ein- und ausschalten.")
            values["onSelfSpead" if ai else "onSpead"] = int(round(_check(patch["level"], 0, 10, "Stufe")))
            if "atType" not in values and patch.get("on") is None and current_mode == AtType.OFF:
                values["atType"] = AtType.ON
        if patch.get("on") is True and "atType" not in values:
            values["atType"] = AtType.ON
        elif patch.get("on") is False:
            values["atType"] = AtType.OFF
        if not values:
            raise AdapterError("Für diesen Port gibt es hier nichts zu ändern.")
        try:
            await self.cloud.set_port(controller_id, port, values, ai=ai)
        except AdapterError:
            raise
        except Exception as err:  # noqa: BLE001
            raise AdapterError(f"AC Infinity hat den Befehl nicht angenommen ({type(err).__name__}).") from err
        self._publish_all()

    async def native(self, device: Device, payload: dict[str, Any]) -> dict[str, Any]:
        control_id = payload.get("control_id") or f"p{payload.get('port')}"
        controller_id, port, ai, outlet, control = self._target(device, control_id)
        action = payload.get("action", "get")
        try:
            if action == "get":
                settings = await self.cloud.get_port(controller_id, port)
                return {"value": settings_to_editor(settings, ai=ai, outlet=outlet),
                        "modes": control.modes, "ai": ai, "outlet": outlet}
            if action == "set":
                value = payload.get("value")
                if not isinstance(value, dict):
                    raise AdapterError("Es fehlen die Einstellungen.")
                allowed = [int(m["key"]) for m in control.modes]
                values = editor_to_settings(value, ai=ai, outlet=outlet, modes=allowed)
                if not values:
                    raise AdapterError("Es wurde nichts geändert.")
                await self.cloud.set_port(controller_id, port, values, ai=ai)
                self._publish_all()
                return {"ok": True, "applied": values}
        except AdapterError:
            raise
        except Exception as err:  # noqa: BLE001
            raise AdapterError(f"AC Infinity hat nicht geantwortet ({type(err).__name__}).") from err
        raise AdapterError("Unbekannte Aktion.")

    async def refresh(self, device: Device) -> None:
        self.cloud.request_refresh(device.native_id)

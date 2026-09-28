"""Simulated Vivosun account for demo mode and tests.

Implements the same interface as VivosunCloud. Device shadows follow the
schemas documented by the Home Assistant integration; desired changes are
echoed like AWS IoT does (update/accepted first, reported ~1 s later).
"""

from __future__ import annotations

import asyncio
import copy
import logging
import random
import time
from collections.abc import Callable
from typing import Any

from ...model import calc_vpd
from .cloud import CloudDevice

_LOGGER = logging.getLogger(__name__)

CFAN = (0, 44, 51, 60, 64, 70, 75, 80, 85, 90, 100)
DFAN = (0, 30, 35, 40, 50, 60, 70, 80, 85, 90, 100)


def _deep_merge(target: dict[str, Any], source: dict[str, Any]) -> None:
    for key, value in source.items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            _deep_merge(target[key], value)
        else:
            target[key] = copy.deepcopy(value)


def _dev(device_id: str, token: str, name: str, device_type: str, scene: int = 70001) -> CloudDevice:
    return CloudDevice(
        device_id=device_id,
        client_id=f"vivosun-{token}-900000000000000001-{device_id}" if device_type != "camera" else "",
        topic_prefix=f"vivosun/VS_COMMON/{token}/900000000000000001/{device_id}" if device_type != "camera" else "",
        name=name,
        online=True,
        scene_id=scene if device_type not in {"curing_box", "camera"} else 0,
        device_type=device_type,
        model_token=token,
        camera_username="admin" if device_type == "camera" else None,
        camera_password="growcam" if device_type == "camera" else None,
        supports_point_log=device_type != "camera",
    )


class FakeVivosunCloud:
    simulated = True

    def __init__(self, interval: float = 10.0) -> None:
        self.interval = interval
        self.state = "stopped"
        self.last_error: str | None = None
        self.last_sync: float | None = None
        self.on_devices: Callable[[list[CloudDevice]], None] = lambda devices: None
        self.on_shadow: Callable[[str, dict[str, Any], bool], None] = lambda d, s, f: None
        self.on_telemetry: Callable[[str, dict[str, Any]], None] = lambda d, t: None
        self._task: asyncio.Task[None] | None = None
        hub = _dev("900000000000000101", "VSCTLE42A", "GrowHub Zelt 2", "controller")
        hum = _dev("900000000000000102", "VSHMDH19", "AeroStream H19", "humidifier")
        heat = _dev("900000000000000103", "VSHTW70", "AeroFlux W70", "heater")
        dry = _dev("900000000000000104", "VSDRYD12", "AeroDrain D12", "dehumidifier")
        ac = _dev("900000000000000105", "VSACAC08", "AeroLush C08", "air_conditioner")
        cure = _dev("900000000000000106", "VSCBC80", "VCure C80", "curing_box")
        cam = _dev("900000000000000107", "VSCAMC4", "GrowCam C4", "camera")
        # smart plugs: the shadow format here is GrowDeck's assumption (Vivosun documents none)
        plug = _dev("900000000000000108", "VSCTLA10", "GrowHub A10", "outlet")
        plug2 = _dev("900000000000000109", "VSCTLA22S", "GrowHub A22", "outlet")
        self.devices: dict[str, CloudDevice] = {d.device_id: d for d in (hub, hum, heat, dry, ac, cure, cam, plug, plug2)}
        self.reported: dict[str, dict[str, Any]] = {
            hub.device_id: {
                "light": {"mode": 0, "lv": 70, "manu": {"lv": 70, "spec": 40}, "inPlan": 0},
                "cFan": {"mode": 0, "lv": 60, "manu": {"lv": 60}, "osc": 1, "nw": 0},
                "dFan": {"mode": 0, "lv": 50, "manu": {"lv": 50},
                         "auto": {"tMin": -6666, "tMax": 2800, "hMin": -6666, "hMax": 7000,
                                  "vpdMin": -6666, "vpdMax": 160, "lvMin": 30, "lvMax": 100}},
                "tUnit": 0, "connected": True, "netVer": "1.2.9-sim",
            },
            hum.device_id: {"hmdf": {"on": 1, "mode": 1, "lv": 4, "manu": {"lv": 4},
                                     "targetHumi": 6200, "waterWarn": 0}, "connected": True},
            heat.device_id: {"heat": {"on": 0, "mode": 0, "lv": 0, "manu": {"lv": 5},
                                      "targetTemp": 2300, "state": 0}, "connected": True},
            dry.device_id: {"dhmdf": {"pause": 1, "mode": 0, "state": 0, "auto": {"tHumi": 6500}},
                            "connected": True},
            ac.device_id: {"aircd": {"state": 0, "func": 1, "tTemp": 2400, "tHumi": 5500, "wdLv": 100,
                                     "pause": 0, "mode": 0}, "connected": True},
            cure.device_id: {"ctlGlass": 0, "ctlLight": 0, "ctlLock": 1, "cure": {"inPlan": 0},
                             "plan": {"stage1": {"startT": 0, "contId": ""}}, "connected": True},
            plug.device_id: {"outlet": {"on": 1, "mode": 0}, "connected": True, "netVer": "1.0.4-sim"},
            plug2.device_id: {"outlet1": {"on": 0, "mode": 0}, "outlet2": {"on": 1, "mode": 1}, "usb": {"on": 1},
                              "connected": True, "netVer": "1.0.4-sim"},
        }
        self.temp = 25.2
        self.humi = 61.0
        self.box_temp = 18.5
        self.box_humi = 62.0
        self.water = 71000

    async def start(self) -> None:
        self.state = "connected"
        self.on_devices(list(self.devices.values()))
        for device_id, reported in self.reported.items():
            self.on_shadow(device_id, copy.deepcopy(reported), True)
        self._emit_telemetry()
        self._task = asyncio.create_task(self._loop(), name="vivosun-sim")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
        self.state = "stopped"

    def request_poll(self) -> None:
        self._emit_telemetry()

    async def request_shadow(self, device_id: str) -> None:
        if device_id in self.reported:
            self.on_shadow(device_id, copy.deepcopy(self.reported[device_id]), True)

    async def publish_desired(self, device_id: str, desired: dict[str, Any]) -> None:
        if device_id not in self.reported:
            raise ConnectionError("Gerät unterstützt keine Steuerung.")
        # AWS IoT: update/accepted echoes desired right away ...
        self.on_shadow(device_id, copy.deepcopy(desired), False)
        asyncio.get_running_loop().call_later(0.8, self._apply, device_id, copy.deepcopy(desired))

    def _apply(self, device_id: str, desired: dict[str, Any]) -> None:
        reported = self.reported[device_id]
        _deep_merge(reported, desired)
        # ... and the device firmware derives the effective level fields.
        for key in ("light", "cFan", "dFan", "hmdf", "heat"):
            block = reported.get(key)
            if isinstance(block, dict) and isinstance(block.get("manu"), dict):
                if key in desired and "manu" in desired.get(key, {}) and "lv" in desired[key]["manu"]:
                    block["lv"] = block["manu"]["lv"]
                if key in {"hmdf", "heat"} and "on" in desired.get(key, {}):
                    block["lv"] = block["manu"].get("lv", 0) if block.get("on") else 0
        stage = (desired.get("plan") or {}).get("stage1") if isinstance(desired.get("plan"), dict) else None
        if isinstance(stage, dict):
            reported.setdefault("cure", {})["inPlan"] = 1 if stage.get("startT") else 0
        self.on_shadow(device_id, copy.deepcopy(reported), True)

    async def _loop(self) -> None:
        while True:
            await asyncio.sleep(self.interval)
            self._step(self.interval)
            self._emit_telemetry()
            self.last_sync = time.time()

    def _step(self, dt: float) -> None:
        hub = self.reported["900000000000000101"]
        light = hub["light"].get("lv", 0) or 0
        exhaust = hub["dFan"].get("lv", 0) or 0
        hmdf = self.reported["900000000000000102"]["hmdf"]
        heat = self.reported["900000000000000103"]["heat"]
        dry = self.reported["900000000000000104"]["dhmdf"]
        ac = self.reported["900000000000000105"]["aircd"]
        # humidifier auto mode keeps its own target
        if hmdf.get("mode") == 1:
            hmdf["on"] = 1 if self.humi < hmdf.get("targetHumi", 6000) / 100 - 1 else (
                0 if self.humi > hmdf.get("targetHumi", 6000) / 100 + 1 else hmdf.get("on", 0))
        if heat.get("mode") == 1:
            heat["on"] = 1 if self.temp < heat.get("targetTemp", 2200) / 100 - 0.5 else (
                0 if self.temp > heat.get("targetTemp", 2200) / 100 + 0.5 else heat.get("on", 0))
        cooling = ac.get("state") == 1 and ac.get("func") == 1
        heating_ac = ac.get("state") == 1 and ac.get("func") == 2
        target_t = 21.5 + light * 0.06 - exhaust * 0.02 + (3.5 if heat.get("on") else 0) \
            - (5 if cooling else 0) + (3 if heating_ac else 0)
        target_h = 52 + (16 if hmdf.get("on") else 0) - (14 if dry.get("pause") == 0 else 0) - exhaust * 0.06
        k = min(1.0, dt / 200.0)
        self.temp += (target_t - self.temp) * k + random.uniform(-0.04, 0.04)
        self.humi += (target_h - self.humi) * k + random.uniform(-0.2, 0.2)
        self.humi = max(25.0, min(92.0, self.humi))
        if hmdf.get("on"):
            self.water = max(0, self.water - int(dt * 8))
        hmdf["waterWarn"] = 1 if self.water < 10000 else 0
        self.box_temp += (18.0 - self.box_temp) * k + random.uniform(-0.02, 0.02)
        self.box_humi += (62.0 - self.box_humi) * k + random.uniform(-0.1, 0.1)

    def _emit_telemetry(self) -> None:
        def scaled(v: float) -> int:
            return int(round(v * 100))

        vpd = calc_vpd(self.temp, self.humi) or 0
        out_t, out_h = 21.0, 48.0
        self.on_telemetry("900000000000000101", {
            "inTemp": scaled(self.temp), "inHumi": scaled(self.humi), "inVpd": scaled(vpd),
            "outTemp": scaled(out_t), "outHumi": scaled(out_h), "outVpd": scaled(calc_vpd(out_t, out_h) or 0),
            "coreTemp": 3810, "rssi": -48, "time": int(time.time()),
        })
        probe = {"pTemp": scaled(self.temp - 0.3), "pHumi": scaled(self.humi + 0.8),
                 "pVpd": scaled(calc_vpd(self.temp - 0.3, self.humi + 0.8) or 0)}
        self.on_telemetry("900000000000000102", {**probe, "waterLv": self.water, "coreTemp": 3120})
        self.on_telemetry("900000000000000103", dict(probe))
        self.on_telemetry("900000000000000104", dict(probe))
        self.on_telemetry("900000000000000105", {**probe, "outTemp": scaled(out_t), "outHumi": scaled(out_h)})
        box_vpd = calc_vpd(self.box_temp, self.box_humi) or 0
        self.on_telemetry("900000000000000109", {"pTemp": scaled(self.temp - 0.1), "pHumi": scaled(self.humi + 0.4),
                                                  "rssi": -61})
        self.on_telemetry("900000000000000106", {
            "pTemp": scaled(self.box_temp), "pHumi": scaled(self.box_humi), "pVpd": scaled(box_vpd),
            "outTemp": scaled(out_t), "outHumi": scaled(out_h), "coreTemp": 2950, "rssi": -57,
        })

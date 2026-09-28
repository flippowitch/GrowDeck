"""Simulated Spider Farmer GGS modules for demo mode and tests.

Behaves like the spiderproxy plus real modules on the MQTT side: publishes
status/system messages and answers getConfigField/setConfigField/getDevSta
commands. A small climate model makes readings react to lights, fans, heater
and humidifier so automations can be tried without hardware.
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import math
import random
import time
from datetime import datetime
from typing import Any

from ..model import calc_vpd
from .mqtt_bus import MqttBus
from .spiderfarmer import get_in, set_in

_LOGGER = logging.getLogger(__name__)

SIM_UID = "sim-sf-user"
SIM_DEVICES = {
    "5ff0cb000001": "cb",
    "5ff0a5000002": "ps5",
    "5ff0aa000003": "ps10",
    "5ff01c000004": "lc",
}


def _period(start_h: float, end_h: float, **extra: Any) -> dict[str, Any]:
    return {"enabled": 1, "weekmask": 127, "startTime": int(start_h * 3600),
            "endTime": int(end_h * 3600), **extra}


class _Tent:
    """Very small first-order climate model."""

    def __init__(self, temp: float, humi: float) -> None:
        self.temp = temp
        self.humi = humi
        self.co2 = 620.0
        self.soil = [42.0, 38.0, 45.0]

    def step(self, dt: float, *, light: float, blower: float, heater: bool, humidifier: bool,
             dehumidifier: bool, drip: bool) -> None:
        ambient_t, ambient_h = 21.0, 50.0
        target_t = ambient_t + light * 0.07 + (4.0 if heater else 0.0) - blower * 0.025
        target_h = ambient_h + (22.0 if humidifier else 0.0) - (18.0 if dehumidifier else 0.0) \
            - blower * 0.08 + light * 0.03
        k = min(1.0, dt / 240.0)
        self.temp += (target_t - self.temp) * k + random.uniform(-0.03, 0.03)
        self.humi += (target_h - self.humi) * k + random.uniform(-0.15, 0.15)
        self.humi = max(20.0, min(95.0, self.humi))
        co2_target = 450 + (900 - 450) * (1 - min(1.0, blower / 100.0)) - light * 1.2
        self.co2 += (co2_target - self.co2) * k + random.uniform(-4, 4)
        for i in range(len(self.soil)):
            self.soil[i] += (8.0 if drip else -0.015) * dt / 60.0 + random.uniform(-0.02, 0.02)
            self.soil[i] = max(5.0, min(70.0, self.soil[i]))


class SpiderFarmerSimulator:
    def __init__(self, bus: MqttBus, interval: float = 5.0) -> None:
        self.bus = bus
        self.interval = interval
        self.tent = _Tent(24.5, 58.0)
        self.devices: dict[str, dict[str, Any]] = {}
        self._task: asyncio.Task[None] | None = None
        self._boot = time.time()
        for mac, dtype in SIM_DEVICES.items():
            self.devices[mac] = {"type": dtype, "config": self._initial_config(dtype)}

    @property
    def macs(self) -> set[str]:
        return set(SIM_DEVICES)

    # ----------------------------------------------------------------- config
    @staticmethod
    def _initial_config(dtype: str) -> dict[str, Any]:
        target = {"dayTime": {"startTime": 6 * 3600, "endTime": 0},
                  "temp": {"targetDay": 26, "targetNight": 21, "deadband": 1},
                  "humi": {"targetDay": 60, "targetNight": 55, "deadband": 3},
                  "co2": {"targetDay": 800, "targetNight": 500, "deadband": 50}}
        light = {"modeType": 1, "mOnOff": 1, "mLevel": 75,
                 "timePeriod": [_period(6, 24, brightness=75, fadeTime=1800)]}
        if dtype == "cb":
            return {
                "device": {
                    "light": light,
                    "blower": {"modeType": 0, "minSpeed": 0, "maxSpeed": 0, "closeCO2": 0,
                               "mOnOff": 1, "mLevel": 45, "timePeriod": [_period(6, 24)],
                               "cycleTime": {"weekmask": 127, "startTime": 0, "openDur": 3600,
                                             "closeDur": 1800, "times": 3}},
                    "fan": {"modeType": 0, "minSpeed": 0, "maxSpeed": 0, "shakeLevel": 2,
                            "natural": 0, "mOnOff": 1, "mLevel": 4},
                    "heater": {"modeType": 0, "mOnOff": 0, "mLevel": 0},
                    "humidifier": {"modeType": 0, "mOnOff": 0, "mLevel": 0},
                    "dehumidifier": {"modeType": 0, "mOnOff": 0, "mLevel": 0},
                },
                "target": target,
                "outlet": {},
                "plan": {"enabled": 0},
            }
        if dtype in {"ps5", "ps10"}:
            count = 5 if dtype == "ps5" else 10
            outlets = {f"O{i}": {"modeType": 0, "mOnOff": 0} for i in range(1, count + 1)}
            outlets["O1"] = {"modeType": 1, "mOnOff": 0, "timePeriod": [_period(6, 24)]}
            outlets["O2"] = {"modeType": 3, "mOnOff": 0, "tempAdd": 1}
            outlets["O3"] = {"modeType": 4, "mOnOff": 0, "humiAdd": 1}
            if count == 10:
                outlets["O4"] = {"modeType": 2, "mOnOff": 0,
                                 "cycleTime": {"weekmask": 127, "startTime": 0, "openDur": 300,
                                               "closeDur": 1500, "times": 0}}
            return {"device": {"light": {"modeType": 0, "mOnOff": 0, "mLevel": 0}},
                    "light2": {"modeType": 0, "mOnOff": 0, "mLevel": 0},
                    "outlet": outlets, "target": target, "plan": {"enabled": 0}}
        # Light Controller
        return {"device": {"light": light},
                "light2": {"modeType": 0, "mOnOff": 1, "mLevel": 40}}

    # --------------------------------------------------------------- runtime
    async def start(self) -> None:
        self.bus.subscribe("ggs/+/+/cmd", self._on_cmd)
        await self.bus.start()
        self._task = asyncio.create_task(self._loop(), name="sf-sim")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
        await self.bus.stop()

    async def _loop(self) -> None:
        await self.bus.wait_connected(30)
        last = time.time()
        tick = 0
        while True:
            now = time.time()
            self._step_climate(now - last)
            last = now
            for mac in self.devices:
                await self._publish(mac, "status", {"data": self._status(mac)})
                if tick % 6 == 0:
                    await self._publish(mac, "system", {"data": {"sys": self._sys(mac)}})
            tick += 1
            await asyncio.sleep(self.interval)

    async def _publish(self, mac: str, kind: str, message: dict[str, Any]) -> None:
        dtype = self.devices[mac]["type"]
        message.setdefault("uid", SIM_UID)
        try:
            await self.bus.publish(f"ggs/{dtype}/{mac}/{kind}", json.dumps(message))
        except ConnectionError:
            pass

    # ----------------------------------------------------------- evaluation
    def _cfg(self, mac: str) -> dict[str, Any]:
        return self.devices[mac]["config"]

    @staticmethod
    def _in_period(periods: Any, now: datetime) -> dict[str, Any] | None:
        if not isinstance(periods, list):
            return None
        sec = now.hour * 3600 + now.minute * 60 + now.second
        for period in periods:
            if not isinstance(period, dict) or not period.get("enabled"):
                continue
            if not (int(period.get("weekmask", 127)) >> now.weekday()) & 1:
                continue
            start = int(period.get("startTime", 0))
            end = int(period.get("endTime", 0)) or 86400
            inside = start <= sec < end if start < end else (sec >= start or sec < end)
            if inside:
                return period
        return None

    def _is_day(self, target: dict[str, Any], now: datetime) -> bool:
        day = target.get("dayTime") or {}
        return self._in_period([{"enabled": 1, "startTime": day.get("startTime", 21600),
                                 "endTime": day.get("endTime", 0)}], now) is not None

    def _channel_state(self, cfg: dict[str, Any], now: datetime, *, kind: str,
                       target: dict[str, Any] | None = None) -> tuple[int, float]:
        """Return (on, level) the firmware would run for this channel config."""
        mode = int(cfg.get("modeType", 0))
        level = float(cfg.get("mLevel", cfg.get("level", 0)) or 0)
        if mode == 0:
            return int(cfg.get("mOnOff", 0)), level
        if mode == 1:
            period = self._in_period(cfg.get("timePeriod"), now)
            if period is None:
                return 0, level
            return 1, float(period.get("brightness", level) or level)
        if mode == 2:
            cyc = cfg.get("cycleTime") or {}
            open_d = max(1, int(cyc.get("openDur", 300)))
            close_d = max(1, int(cyc.get("closeDur", 1500)))
            pos = (now.hour * 3600 + now.minute * 60 + now.second - int(cyc.get("startTime", 0))) % (open_d + close_d)
            return (1 if pos < open_d else 0), level
        target = target or {}
        day = self._is_day(target, now)
        slot = "targetDay" if day else "targetNight"
        if mode == 3:
            goal = (target.get("temp") or {}).get(slot, 25)
            band = (target.get("temp") or {}).get("deadband", 1)
            heating = int(cfg.get("tempAdd", 1)) == 1
            on = self.tent.temp < goal - band if heating else self.tent.temp > goal + band
            return int(on), level
        if mode == 4:
            goal = (target.get("humi") or {}).get(slot, 60)
            band = (target.get("humi") or {}).get("deadband", 3)
            adding = int(cfg.get("humiAdd", 1)) == 1
            on = self.tent.humi < goal - band if adding else self.tent.humi > goal + band
            return int(on), level
        if mode == 5:
            goal = (target.get("co2") or {}).get(slot, 800)
            on = self.tent.co2 < goal if int(cfg.get("co2Add", 1)) == 1 else self.tent.co2 > goal
            return int(on), level
        return int(cfg.get("mOnOff", 0)), level

    def _step_climate(self, dt: float) -> None:
        now = datetime.now()
        cb = self._cfg("5ff0cb000001")["device"]
        target = self._cfg("5ff0cb000001")["target"]
        light_on, light_lv = self._channel_state(cb["light"], now, kind="light")
        lc = self._cfg("5ff01c000004")
        lc_on, lc_lv = self._channel_state(lc["device"]["light"], now, kind="light")
        blower_on, blower_lv = self._channel_state(cb["blower"], now, kind="fan")
        strip = self._cfg("5ff0a5000002")["outlet"]
        heater = bool(cb["heater"].get("mOnOff")) or bool(self._channel_state(strip["O2"], now, kind="outlet", target=target)[0])
        humid = bool(cb["humidifier"].get("mOnOff")) or bool(self._channel_state(strip["O3"], now, kind="outlet", target=target)[0])
        dehum = bool(cb["dehumidifier"].get("mOnOff"))
        drip = False
        for mac in ("5ff0a5000002", "5ff0aa000003"):
            for oid, ocfg in self._cfg(mac)["outlet"].items():
                if int(ocfg.get("modeType", 0)) == 14 and self._channel_state(ocfg, now, kind="outlet")[0]:
                    drip = True
        light_total = (light_lv if light_on else 0) * 0.7 + (lc_lv if lc_on else 0) * 0.3
        self.tent.step(dt, light=light_total, blower=blower_lv if blower_on else 0, heater=heater,
                       humidifier=humid, dehumidifier=dehum, drip=drip)
        self._light_total = light_total

    def _status(self, mac: str) -> dict[str, Any]:
        dtype = self.devices[mac]["type"]
        cfg = self._cfg(mac)
        now = datetime.now()
        target = cfg.get("target") or self._cfg("5ff0cb000001")["target"]
        temp = round(self.tent.temp, 1)
        humi = round(self.tent.humi, 1)
        sensor = {"temp": temp, "humi": humi, "vpd": calc_vpd(temp, humi)}
        status: dict[str, Any] = {}
        if dtype == "cb":
            ppfd = int(getattr(self, "_light_total", 0) * 9.5 + random.uniform(-5, 5))
            sensor.update({"co2": int(self.tent.co2), "ppfd": max(0, ppfd)})
            status["sensor"] = sensor
            soil = []
            for i, moisture in enumerate(self.tent.soil, start=1):
                soil.append({"id": str(i), "tempSoil": round(self.tent.temp - 1.8, 1),
                             "humiSoil": round(moisture, 1), "ECSoil": round(1.4 + 0.02 * i, 2)})
            soil.append({"id": "avg", "tempSoil": round(self.tent.temp - 1.8, 1),
                         "humiSoil": round(sum(self.tent.soil) / 3, 1), "ECSoil": 1.44})
            status["sensors"] = soil
            dev = cfg["device"]
            on, lv = self._channel_state(dev["light"], now, kind="light")
            status["light"] = {"modeType": dev["light"].get("modeType"), "on": on, "level": lv if on else 0}
            for key in ("blower", "fan"):
                on, lv = self._channel_state(dev[key], now, kind="fan")
                status[key] = {"modeType": dev[key].get("modeType", 0), "on": on, "level": lv if on else 0}
            status["blower"]["closeCO2"] = dev["blower"].get("closeCO2", 0)
            for key in ("heater", "humidifier", "dehumidifier"):
                status[key] = {"modeType": dev[key].get("modeType", 0), "on": int(dev[key].get("mOnOff", 0)),
                               "level": dev[key].get("mLevel", 0)}
        elif dtype in {"ps5", "ps10"}:
            status["sensor"] = sensor
            outlets = {}
            for oid, ocfg in cfg["outlet"].items():
                on, _ = self._channel_state(ocfg, now, kind="outlet", target=target)
                outlets[oid] = {"modeType": ocfg.get("modeType", 0), "on": on}
            status["outlet"] = outlets
            for key, c in (("light", cfg["device"]["light"]), ("light2", cfg["light2"])):
                on, lv = self._channel_state(c, now, kind="light")
                status[key] = {"modeType": c.get("modeType", 0), "on": on, "level": lv if on else 0}
        else:
            light = cfg["device"]["light"]
            on, lv = self._channel_state(light, now, kind="light")
            status["light"] = {"modeType": light.get("modeType"), "on": on, "level": lv if on else 0}
            on2, lv2 = self._channel_state(cfg["light2"], now, kind="light")
            status["light2"] = {"modeType": cfg["light2"].get("modeType"), "on": on2, "level": lv2 if on2 else 0}
        return status

    def _sys(self, mac: str) -> dict[str, Any]:
        wobble = int(3 * math.sin(time.time() / 60))
        return {"ver": "3.4.12-sim", "wifi": {"rssi": -52 + wobble, "ssid": "Growzelt"},
                "upTime": int(time.time() - self._boot), "mem": 81234}

    # --------------------------------------------------------------- commands
    async def _on_cmd(self, topic: str, payload: bytes) -> None:
        parts = topic.split("/")
        if len(parts) != 4:
            return
        mac = parts[2].lower()
        if mac not in self.devices:
            return
        try:
            cmd = json.loads(payload)
        except ValueError:
            return
        method = cmd.get("method")
        msg_id = cmd.get("msgId")
        params = cmd.get("params") or {}
        cfg = self._cfg(mac)
        if method == "getConfigField":
            path = [str(p) for p in params.get("keyPath") or []]
            value = copy.deepcopy(get_in(cfg, path)) if path else copy.deepcopy(cfg)
            data: dict[str, Any] = {}
            if path:
                set_in(data, path, value if value is not None else {})
            else:
                data = value
            await self._publish(mac, "config", {"msgId": msg_id, "method": method, "code": 0, "data": data})
        elif method == "setConfigField":
            path = [str(p) for p in params.get("keyPath") or []]
            if path and path[-1] in params:
                set_in(cfg, path, copy.deepcopy(params[path[-1]]))
                await self._publish(mac, "config", {"msgId": msg_id, "method": method, "code": 0,
                                                    "data": {}})
                await asyncio.sleep(0.2)
                await self._publish(mac, "status", {"data": self._status(mac)})
        elif method == "getDevSta":
            await self._publish(mac, "status", {"msgId": msg_id, "data": self._status(mac)})
        elif method == "getSysSta":
            await self._publish(mac, "system", {"msgId": msg_id, "data": {"sys": self._sys(mac)}})

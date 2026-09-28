"""Simulated AC Infinity cloud for the demo mode.

Implements the same methods as the vendored ACInfinityClient and returns
payloads in the shape of the real API (see the upstream test fixtures), so the
polling code, the adapter and the UI run exactly as with a real account.
"""
from __future__ import annotations

import copy
import math
import random
import time
from datetime import datetime
from typing import Any

from .vendor.const import AtType, ControllerType

AI_TYPES = {ControllerType.UIS_89_AI_PLUS, ControllerType.UIS_OUTLET_AI, ControllerType.UIS_OUTLET_AI_PLUS}


def _port_settings(ai: bool, load_type: int, at_type: int, speed: int, **extra: Any) -> dict[str, Any]:
    base = {
        "atType": at_type, "onSpead": speed, "offSpead": 0, "onSelfSpead": speed if ai else 0,
        "activeHt": 0, "devHt": 28, "devHtf": 82, "activeLt": 0, "devLt": 18, "devLtf": 64,
        "activeHh": 0, "devHh": 70, "activeLh": 0, "devLh": 45,
        "acitveTimerOn": 0, "acitveTimerOff": 0, "activeCycleOn": 900, "activeCycleOff": 900,
        "schedStartTime": 65535, "schedEndtTime": 65535,
        "activeHtVpd": 0, "activeHtVpdNums": 14, "activeLtVpd": 0, "activeLtVpdNums": 8,
        "settingMode": 0, "vpdSettingMode": 0, "targetVpd": 11, "targetVpdSwitch": 0,
        "targetTemp": 25, "targetTempF": 77, "targetTSwitch": 0, "targetHumi": 60, "targetHumiSwitch": 0,
        "co2LowSwitch": 0, "co2LowValue": 600, "co2FanHighSwitch": 0, "co2FanHighValue": 1500,
        "moistureLowSwitch": 0, "moistureLowValue": 30,
        "waterTempHighSwitch": 0, "waterTempHighValue": 24, "waterTempHighValueF": 75,
        "waterTempLowSwitch": 0, "waterTempLowValue": 18, "waterTempLowValueF": 64,
        "phHighSwitch": 0, "phHighValue": 65, "phLowSwitch": 0, "phLowValue": 55,
        "ecTdsLowSwitchEc": 0, "ecTdsLowValueEcMs": 0,
    }
    base.update(extra)
    setting = {"loadType": load_type, "devCompany": 1, "isFlag": 0}
    if ai:
        # AI controllers keep device settings and part of the mode data nested
        setting.update({"onSelfSpead": base["onSelfSpead"]})
    return {**base, "devSetting": setting}


def _controller(dev_id: str, name: str, dev_type: int, mac: str, ports: list[tuple[str, int]]) -> dict[str, Any]:
    return {
        "devId": dev_id, "devCode": "SIM", "devName": name, "devType": dev_type,
        "devPortCount": len(ports), "devMacAddr": mac, "online": 1, "isShare": 0,
        "firmwareVersion": "3.4.12" if dev_type in AI_TYPES else "3.2.25", "hardwareVersion": "1.1",
        "zoneId": "Europe/Berlin",
        "deviceInfo": {
            "devId": dev_id, "temperature": 2450, "temperatureF": 7610, "humidity": 6000,
            "vpdnums": 120, "unit": 1, "online": 1,
            "ports": [
                {"port": i + 1, "portName": pname, "speak": 0, "curMode": 1, "remainTime": 0,
                 "online": 1 if load else 0, "loadType": load, "loadState": 0,
                 "abnormalState": 0, "overcurrentStatus": 0}
                for i, (pname, load) in enumerate(ports)
            ],
            "sensors": [] if dev_type in AI_TYPES else None,
        },
    }


class FakeACInfinityClient:
    simulated = True

    def __init__(self) -> None:
        self._user_id: str | None = None
        self._start = time.time()
        self._rng = random.Random(7)
        self._mode_since: dict[tuple[str, int], float] = {}
        self.controllers: dict[str, dict[str, Any]] = {}
        self.settings: dict[tuple[str, int], dict[str, Any]] = {}

        ai_id, pro_id, strip_id = "3101000000000000001", "3101000000000000002", "3101000000000000003"
        self.controllers[ai_id] = _controller(ai_id, "Controller AI+ Zelt 3", ControllerType.UIS_89_AI_PLUS,
                                              "3C450E78AB12", [("Abluft", 135), ("Umluft", 134),
                                                               ("Ionbeam", 129), ("Befeuchter", 130)])
        self.controllers[pro_id] = _controller(pro_id, "Controller 69 Pro Zelt 1", ControllerType.UIS_69_PRO,
                                               "2B120D62DC00", [("Cloudline", 6), ("Clip-Fan", 6),
                                                                ("Heizung", 4), ("Port 4", 0)])
        self.controllers[strip_id] = _controller(strip_id, "Outlet AI+ Zelt 3", ControllerType.UIS_OUTLET_AI_PLUS,
                                                 "3C450E78AB99", [("Wasserpumpe", 137), ("Entfeuchter", 131),
                                                                  ("CO₂-Regler", 138), ("Heizmatte", 132),
                                                                  ("Steckdose 5", 128), ("Steckdose 6", 128),
                                                                  ("Steckdose 7", 128), ("Steckdose 8", 128)])
        ai_sensors = self.controllers[ai_id]["deviceInfo"]["sensors"]
        ai_sensors.extend([
            {"sensorType": 1, "sensorUnit": 1, "sensorPrecision": 3, "accessPort": 1, "sensorData": 2450},
            {"sensorType": 2, "sensorUnit": 0, "sensorPrecision": 3, "accessPort": 1, "sensorData": 6000},
            {"sensorType": 3, "sensorUnit": 0, "sensorPrecision": 3, "accessPort": 1, "sensorData": 120},
            {"sensorType": 5, "sensorUnit": 1, "sensorPrecision": 3, "accessPort": 7, "sensorData": 2710},
            {"sensorType": 6, "sensorUnit": 0, "sensorPrecision": 3, "accessPort": 7, "sensorData": 4800},
            {"sensorType": 7, "sensorUnit": 0, "sensorPrecision": 3, "accessPort": 7, "sensorData": 185},
            {"sensorType": 11, "sensorUnit": 0, "sensorPrecision": 1, "accessPort": 2, "sensorData": 820},
            {"sensorType": 12, "sensorUnit": 0, "sensorPrecision": 1, "accessPort": 2, "sensorData": 76},
            {"sensorType": 10, "sensorUnit": 0, "sensorPrecision": 2, "accessPort": 3, "sensorData": 425},
            {"sensorType": 20, "sensorUnit": 0, "sensorPrecision": 1, "accessPort": 4, "sensorData": 0},
            {"sensorType": 13, "sensorUnit": 0, "sensorPrecision": 2, "accessPort": 5, "sensorData": 61},
            {"sensorType": 15, "sensorUnit": 0, "sensorPrecision": 3, "accessPort": 5, "sensorData": 145},
            {"sensorType": 19, "sensorUnit": 1, "sensorPrecision": 2, "accessPort": 5, "sensorData": 205},
        ])
        s = self.settings
        s[(ai_id, 1)] = _port_settings(True, 135, AtType.AUTO, 7, activeHt=1, devHt=26, devHtf=79, activeHh=1, devHh=65)
        s[(ai_id, 2)] = _port_settings(True, 134, AtType.ON, 4)
        s[(ai_id, 3)] = _port_settings(True, 129, AtType.SCHEDULE, 8, schedStartTime=360, schedEndtTime=0)
        s[(ai_id, 4)] = _port_settings(True, 130, AtType.VPD, 6, activeHtVpd=1, activeHtVpdNums=13)
        s[(pro_id, 1)] = _port_settings(False, 6, AtType.AUTO, 8, offSpead=2, activeHt=1, devHt=27, devHtf=81, activeHh=1, devHh=68)
        s[(pro_id, 2)] = _port_settings(False, 6, AtType.CYCLE, 5, activeCycleOn=600, activeCycleOff=1200)
        s[(pro_id, 3)] = _port_settings(False, 4, AtType.OFF, 10, activeLt=1, devLt=20, devLtf=68)
        s[(pro_id, 4)] = _port_settings(False, 0, AtType.OFF, 0)
        s[(strip_id, 1)] = _port_settings(True, 137, AtType.CYCLE, 10, activeCycleOn=60, activeCycleOff=3540)
        s[(strip_id, 2)] = _port_settings(True, 131, AtType.AUTO, 10, activeHh=1, devHh=62)
        s[(strip_id, 3)] = _port_settings(True, 138, AtType.CO2, 10, co2LowSwitch=1, co2LowValue=700)
        s[(strip_id, 4)] = _port_settings(True, 132, AtType.OFF, 10)
        for port in range(5, 9):
            s[(strip_id, port)] = _port_settings(True, 128, AtType.OFF, 10)
        now = time.time()
        for key in s:
            self._mode_since[key] = now

    # ------------------------------------------------------- client interface
    async def login(self) -> None:
        self._user_id = "demo-user"

    def is_logged_in(self) -> bool:
        return bool(self._user_id)

    async def close(self) -> None:
        return None

    async def get_account_controllers(self) -> list[dict[str, Any]]:
        self._simulate()
        return copy.deepcopy(list(self.controllers.values()))

    async def get_device_mode_settings(self, controller_id: str | int, device_port: int) -> dict[str, Any]:
        key = (str(controller_id), int(device_port))
        if key not in self.settings:
            raise KeyError(f"Port {device_port} unbekannt")
        return copy.deepcopy(self.settings[key])

    async def update_device_controls(self, controller_id: str | int, device_port: int, key_values: dict[str, Any]) -> None:
        self._update(str(controller_id), int(device_port), key_values)

    async def update_ai_device_control_and_settings(self, controller_id: str | int, device_port: int,
                                                    key_values: dict[str, Any]) -> None:
        self._update(str(controller_id), int(device_port), key_values)

    # ------------------------------------------------------------- simulation
    def _update(self, controller_id: str, port: int, key_values: dict[str, Any]) -> None:
        settings = self.settings[(controller_id, port)]
        if "atType" in key_values and int(key_values["atType"]) != int(settings.get("atType") or 0):
            self._mode_since[(controller_id, port)] = time.time()
        for key, value in key_values.items():
            settings[key] = value
            if key in settings.get("devSetting", {}):
                settings["devSetting"][key] = value
        self._simulate()

    def _climate(self, controller: dict[str, Any], offset: float) -> tuple[float, float]:
        t = time.time() - self._start
        temp = 24.6 + offset + 1.4 * math.sin(t / 900) + self._rng.uniform(-0.1, 0.1)
        humi = 60 - 5 * math.sin(t / 1100) + self._rng.uniform(-0.6, 0.6)
        return round(temp, 2), round(humi, 1)

    @staticmethod
    def _vpd(temp: float, humi: float) -> float:
        svp = 0.6108 * math.exp(17.27 * temp / (temp + 237.3))
        return max(0.0, svp * (1 - humi / 100))

    def _simulate(self) -> None:
        now = time.time()
        local = datetime.now()
        minute = local.hour * 60 + local.minute
        ai_temp, ai_humi = self._climate(self.controllers["3101000000000000001"], 0.0)
        for controller_id, controller in self.controllers.items():
            info = controller["deviceInfo"]
            temp, humi = self._climate(controller, 0.4 if controller["devType"] == ControllerType.UIS_69_PRO else 0.0)
            vpd = self._vpd(temp, humi)
            info["temperature"] = int(temp * 100)
            info["temperatureF"] = int((temp * 1.8 + 32) * 100)
            info["humidity"] = int(humi * 100)
            info["vpdnums"] = int(round(vpd * 100))
            sensors = info.get("sensors") or []
            co2 = 820.0
            for sensor in sensors:
                stype = sensor["sensorType"]
                if stype == 1:
                    sensor["sensorData"] = int(ai_temp * 100)
                elif stype == 2:
                    sensor["sensorData"] = int(ai_humi * 100)
                elif stype == 3:
                    sensor["sensorData"] = int(round(self._vpd(ai_temp, ai_humi) * 100))
                elif stype == 11:
                    sensor["sensorData"] = int(780 + 90 * math.sin((now - self._start) / 700))
                    co2 = sensor["sensorData"]
                elif stype == 10:
                    sensor["sensorData"] = int(425 - ((now - self._start) / 60) % 120)
            for port_json in info["ports"]:
                port = port_json["port"]
                settings = self.settings.get((controller_id, port))
                if settings is None or not port_json["loadType"]:
                    port_json.update({"speak": 0, "loadState": 0, "curMode": int(settings.get("atType", 1)) if settings else 1})
                    continue
                ai = controller["devType"] in AI_TYPES
                on_speed = int(settings.get("onSelfSpead" if ai else "onSpead") or 0)
                off_speed = 0 if ai else int(settings.get("offSpead") or 0)
                at = int(settings.get("atType") or 1)
                since = self._mode_since.get((controller_id, port), self._start)
                remaining = 0
                active = False
                if at == AtType.ON:
                    active = True
                elif at == AtType.AUTO:
                    active = (bool(settings["activeHt"]) and temp >= settings["devHt"]) or \
                             (bool(settings["activeLt"]) and temp <= settings["devLt"]) or \
                             (bool(settings["activeHh"]) and humi >= settings["devHh"]) or \
                             (bool(settings["activeLh"]) and humi <= settings["devLh"])
                elif at in (AtType.TIMER_TO_ON, AtType.TIMER_TO_OFF):
                    duration = int(settings["acitveTimerOn" if at == AtType.TIMER_TO_ON else "acitveTimerOff"] or 0)
                    remaining = max(0, int(since + duration - now))
                    active = (remaining == 0) if at == AtType.TIMER_TO_ON else (remaining > 0)
                elif at == AtType.CYCLE:
                    on_s, off_s = int(settings["activeCycleOn"] or 1), int(settings["activeCycleOff"] or 1)
                    phase = (now - since) % (on_s + off_s)
                    active = phase < on_s
                    remaining = int((on_s - phase) if active else (on_s + off_s - phase))
                elif at == AtType.SCHEDULE:
                    start, end = int(settings["schedStartTime"]), int(settings["schedEndtTime"])
                    if start == 65535:
                        active = False
                    elif end == 65535:
                        active = minute >= start
                    elif start <= end:
                        active = start <= minute < end
                    else:
                        active = minute >= start or minute < end
                elif at == AtType.VPD:
                    active = (bool(settings["activeHtVpd"]) and vpd * 10 >= settings["activeHtVpdNums"]) or \
                             (bool(settings["activeLtVpd"]) and vpd * 10 <= settings["activeLtVpdNums"])
                elif at == AtType.CO2:
                    active = bool(settings["co2LowSwitch"]) and co2 <= settings["co2LowValue"]
                elif at == AtType.CO2_FAN:
                    active = bool(settings["co2FanHighSwitch"]) and co2 >= settings["co2FanHighValue"]
                speed = on_speed if active else off_speed
                if controller["devType"] in (ControllerType.UIS_OUTLET_AI, ControllerType.UIS_OUTLET_AI_PLUS):
                    speed = 1 if active else 0
                port_json.update({"speak": speed, "loadState": 1 if speed > 0 else 0,
                                  "curMode": at, "remainTime": remaining})

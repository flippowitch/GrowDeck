"""Runs the vendored AC Infinity client, the poller and the adapter against a
local mock of the AC Infinity HTTP API that serves payloads in the real shape
(fixtures derived from the upstream integration's tests).

    cd backend && python tests/test_acinfinity_client.py
"""
from __future__ import annotations

import asyncio
import copy
import json
import sys
from pathlib import Path
from typing import Any

from aiohttp import web

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.adapters.acinfinity.adapter import ACInfinityAdapter  # noqa: E402
from app.adapters.acinfinity.cloud import ACInfinityCloud  # noqa: E402
from app.adapters.acinfinity.vendor.client import ACInfinityClient  # noqa: E402

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "acinfinity_api.json").read_text())
TOKEN = "token-123"


class MockApi:
    def __init__(self) -> None:
        self.controllers = copy.deepcopy(FIXTURE["controllers"])
        self.controls: dict[tuple[str, int], dict[str, Any]] = {}
        for controller in self.controllers:
            for port in controller["deviceInfo"]["ports"]:
                data = copy.deepcopy(FIXTURE["device_controls"])
                data["devId"] = controller["devId"]
                data["externalPort"] = port["port"]  # the API identifies the port by externalPort
                data["devSetting"]["port"] = data["devSetting"]["externalPort"] = port["port"]
                self.controls[(str(controller["devId"]), port["port"])] = data
        self.writes: list[tuple[str, dict[str, str]]] = []

    @staticmethod
    def ok(data: Any = None) -> web.Response:
        return web.json_response({"code": 200, "msg": "success", "data": data})

    async def login(self, request: web.Request) -> web.Response:
        form = await request.post()
        if form.get("appEmail") != "grower@example.com" or form.get("appPasswordl") != "x" * 25:
            return web.json_response({"code": 10001, "msg": "wrong password"})
        return self.ok({"appId": TOKEN})

    def authed(self, request: web.Request) -> bool:
        return request.headers.get("token") == TOKEN

    async def devices(self, request: web.Request) -> web.Response:
        if not self.authed(request):
            return web.json_response({"code": 403})
        return self.ok(self.controllers)

    async def mode_settings(self, request: web.Request) -> web.Response:
        form = await request.post()
        return self.ok(self.controls[(str(form["devId"]), int(form["port"]))])

    async def write(self, request: web.Request) -> web.Response:
        params = dict(request.query)
        self.writes.append((request.path, params))
        port = int(params.get("port") or params["externalPort"])  # addDevMode only sends externalPort
        target = self.controls[(str(params["devId"]), port)]
        for key, value in params.items():
            if key in target and not isinstance(target[key], (dict, list)):
                try:
                    target[key] = int(value)
                except ValueError:
                    target[key] = value
        return self.ok()


async def main() -> None:
    api = MockApi()
    app = web.Application()
    app.router.add_post("/api/user/appUserLogin", api.login)
    app.router.add_post("/api/user/devInfoListAll", api.devices)
    app.router.add_post("/api/dev/getdevModeSettingList", api.mode_settings)
    app.router.add_post("/api/dev/addDevMode", api.write)
    app.router.add_put("/api/dev/modeAndSetting", api.write)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]  # noqa: SLF001

    class Hub:
        devices: dict[str, Any] = {}

        def update_device(self, device: Any) -> None:
            self.devices[device.id] = device

        def remove_device(self, device_id: str) -> None:
            self.devices.pop(device_id, None)

    hub = Hub()
    # 30-character password: the client must truncate it to 25 like the app does
    client = ACInfinityClient(f"http://127.0.0.1:{port}", "grower@example.com", "x" * 30)
    cloud = ACInfinityCloud(poll_interval=5, client=client)
    adapter = ACInfinityAdapter(cloud)
    await adapter.start(hub)
    for _ in range(50):
        if len(hub.devices) == 2 and cloud.port_settings:
            break
        await asyncio.sleep(0.1)
    assert cloud.state == "connected", (cloud.state, cloud.last_error)
    basic = next(d for d in hub.devices.values() if d.model == "Controller 69 Pro")
    ai = next(d for d in hub.devices.values() if d.model == "Controller AI+")
    print("ok   login (password truncated), polling, 2 controllers")
    print("     69 Pro sensors:", {k: s.value for k, s in basic.sensors.items()})
    print("     AI+ sensors:", {k: (s.value, s.unit) for k, s in ai.sensors.items()})
    assert abs(basic.sensors["temp"].value - 24.17) < 0.01 and basic.sensors["vpd"].value == 0.83
    assert "co2" in ai.sensors and "hydro.ph" in ai.sensors and ai.sensors["temp"].unit == "°C"
    p1 = basic.controls["p1"]
    print("     port 1:", p1.label, p1.type, "mode", p1.mode_label, "level", p1.level, "running", p1.on,
          "modes", [m["label"] for m in p1.modes])
    print("     AI modes:", [m["label"] for m in ai.controls["p1"].modes])
    assert "CO₂" in [m["label"] for m in ai.controls["p1"].modes]

    await adapter.apply(basic, "p1", {"on": True, "level": 7})
    path, params = api.writes[-1]
    assert path == "/api/dev/addDevMode" and params["atType"] == "2" and params["onSpead"] == "7", params
    await adapter.apply(basic, "p2", {"mode": "3"})
    assert api.writes[-1][1]["atType"] == "3"
    await adapter.apply(basic, "p3", {"on": False})
    assert api.writes[-1][1]["atType"] == "1"
    print("ok   basic controller: on+level, mode, off (addDevMode)")

    await adapter.apply(ai, "p2", {"level": 4, "on": True})
    path, params = api.writes[-1]
    assert path == "/api/dev/modeAndSetting" and params["onSelfSpead"] == "4" and params["atType"] == "2", params
    assert params["modeAndSettingIdStr"] == "[16,18]", params["modeAndSettingIdStr"]
    print("ok   AI controller: on+level via modeAndSetting", params["modeAndSettingIdStr"])

    editor = (await adapter.native(basic, {"action": "get", "control_id": "p1"}))["value"]
    editor["auto"].update({"temp_high": 28, "temp_high_on": True, "humi_high": 70, "humi_high_on": True})
    editor["vpd"].update({"high": 1.3, "high_on": True})
    editor["timer"] = {"to_on": 30, "to_off": 45}
    editor["cycle"] = {"on": 10, "off": 20}
    editor["schedule"] = {"start": "06:00", "end": None}
    editor["mode"] = "3"
    result = await adapter.native(basic, {"action": "set", "control_id": "p1", "value": editor})
    applied = result["applied"]
    assert applied["devHt"] == 28 and applied["devHtf"] == 82 and applied["activeHt"] == 1, applied
    assert applied["activeHtVpdNums"] == 13 and applied["acitveTimerOn"] == 1800 and applied["activeCycleOff"] == 1200
    assert applied["schedStartTime"] == 360 and applied["schedEndtTime"] == 65535 and applied["atType"] == 3
    sent = api.writes[-1][1]
    assert sent["devHtf"] == "82" and sent["activeHtVpdNums"] == "13" and sent["schedStartTime"] == "360", sent
    again = (await adapter.native(basic, {"action": "get", "control_id": "p1"}))["value"]
    assert again["auto"]["temp_high"] == 28 and again["vpd"]["high"] == 1.3 and again["timer"]["to_on"] == 30
    assert again["schedule"] == {"start": "06:00", "end": None}
    print("ok   port editor round trip: triggers, VPD, timers, cycle, schedule")

    message = ""
    try:
        await adapter.native(basic, {"action": "set", "control_id": "p1", "value": {"auto": {"temp_high": 120}}})
    except Exception as err:  # noqa: BLE001
        message = str(err)
    assert "zwischen" in message, "out of range value accepted"
    print("ok   validation:", message)

    await adapter.stop()
    await runner.cleanup()
    print("ALL AC INFINITY CLIENT TESTS PASSED")


if __name__ == "__main__":
    asyncio.run(main())

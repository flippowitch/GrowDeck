"""End-to-end smoke test against a running GrowDeck in demo mode.

    DEMO_MODE=1 APP_PASSWORD=test python -m uvicorn app.main:app --port 8088
    python tests/smoke_api.py http://127.0.0.1:8088 test

Uses only the standard library. Exits non-zero on the first failure.
"""
from __future__ import annotations

import http.cookiejar
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8088"
PASSWORD = sys.argv[2] if len(sys.argv) > 2 else "test"
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def call(method: str, path: str, body=None, expect: int = 200):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + "/api" + path, data=data, method=method,
                                 headers={"content-type": "application/json"})
    try:
        with opener.open(req, timeout=20) as resp:
            status, raw = resp.status, resp.read()
    except urllib.error.HTTPError as err:
        status, raw = err.code, err.read()
    if status != expect:
        raise SystemExit(f"FAIL {method} {path}: HTTP {status}, expected {expect}: {raw[:300]!r}")
    return json.loads(raw) if raw else None


def ok(msg: str) -> None:
    print(f"ok   {msg}")


call("GET", "/health")
ok("health without login")
call("GET", "/state", expect=401)
call("POST", "/auth/login", {"password": "wrong"}, expect=401)
call("POST", "/auth/login", {"password": PASSWORD})
ok("login")

state = call("GET", "/state")
devices = {d["id"]: d for d in state["devices"]}
assert len(devices) >= 11, f"expected demo devices, got {len(devices)}"
ok(f"state: {len(devices)} devices, {len(state['rooms'])} rooms")

strip = next(d for d in devices.values() if d["vendor"] == "spiderfarmer" and any(c["id"] == "O5" for c in d["controls"]))
c = call("POST", f"/devices/{strip['id']}/controls/O5", {"on": True})
assert c["on"] is True, c
c = call("POST", f"/devices/{strip['id']}/controls/O5", {"on": False})
assert c["on"] is False, c
ok("spider farmer outlet on/off")

cfg = call("POST", f"/devices/{strip['id']}/native", {"action": "get", "keyPath": ["outlet", "O4"]})["value"]
cfg["modeType"] = 2
cfg["cycleTime"] = {"weekmask": 127, "startTime": 28800, "openDur": 600, "closeDur": 1200, "times": 0}
call("POST", f"/devices/{strip['id']}/native", {"action": "set", "keyPath": ["outlet", "O4"], "value": cfg})
back = call("POST", f"/devices/{strip['id']}/native", {"action": "get", "keyPath": ["outlet", "O4"]})["value"]
assert back["modeType"] == 2 and back["cycleTime"]["openDur"] == 600, back
ok("spider farmer outlet cycle mode via native set/get")

target = call("POST", f"/devices/{strip['id']}/native", {"action": "get", "keyPath": ["target"]})["value"]
assert "temp" in target, target
ok("spider farmer climate targets readable")

hub = next(d for d in devices.values() if d["vendor"] == "vivosun" and any(c["id"] == "dFan" for c in d["controls"]))
c = call("POST", f"/devices/{hub['id']}/controls/dFan", {"mode": "1", "auto": {"tMax": 28.5, "hMax": 70, "tMin": None}})
assert c["mode"] == "1" and abs(c["extra"]["auto"]["tMax"] - 28.5) < 0.01, c["extra"]
c = call("POST", f"/devices/{hub['id']}/controls/light", {"spectrum": 40})
assert c["extra"]["spectrum"] == 40, c["extra"]
c = call("POST", f"/devices/{hub['id']}/controls/cFan", {"on": True, "level": 6})
assert c["on"] and c["level"] == 6, c
ok("vivosun exhaust auto limits, light spectrum, fan level")

call("POST", "/rules", {"name": "kaputt", "trigger": {"type": "threshold"}, "target": {}, "active_action": {}}, expect=400)
humi = next(s for s in hub["sensors"] if s["key"] == "humi")
rule = call("POST", "/rules", {
    "name": "Smoke-Test-Regel", "enabled": True,
    "trigger": {"type": "threshold", "device_id": hub["id"], "sensor": humi["key"], "op": "above", "value": 1, "hysteresis": 0.5},
    "target": {"device_id": strip["id"], "control_id": "O3"},
    "active_action": {"on": True}, "inactive_action": {"on": False},
})
rid = rule["id"]
rules = call("GET", "/rules")
assert any(r["id"] == rid for r in rules["rules"]), rules
call("POST", "/rules/order", {"ids": [rid] + [r["id"] for r in rules["rules"] if r["id"] != rid]})
deadline = time.time() + 25
while time.time() < deadline:
    o3 = next(c for c in call("GET", f"/devices/{strip['id']}")["controls"] if c["id"] == "O3")
    if o3["on"]:
        break
    time.sleep(2)
assert o3["on"], "rule did not switch O3 on"
ok("cross-vendor rule switched spider farmer outlet from vivosun humidity")
call("PUT", f"/rules/{rid}", {**rule, "enabled": False})
call("DELETE", f"/rules/{rid}")
status = call("POST", "/automation/enabled", {"enabled": False})
assert status["enabled"] is False
call("POST", "/automation/enabled", {"enabled": True})
ok("rule update/delete, automation pause/resume")

alarm = call("POST", "/alarms", {"name": "Smoke-Alarm", "device_id": hub["id"], "sensor": "temp", "min": 5, "max": 60, "delay_minutes": 0})
assert any(a["id"] == alarm["id"] for a in call("GET", "/alarms")["alarms"])
call("DELETE", f"/alarms/{alarm['id']}")
ok("alarm create/delete")

room = call("POST", "/rooms", {"name": "Smoke-Raum", "stage": "flower", "day_start": "18:00", "day_end": "12:00"})
call("PUT", f"/rooms/{room['id']}", {**{k: v for k, v in room.items() if k != "id"}, "name": "Smoke-Raum 2"})
call("PATCH", f"/devices/{hub['id']}", {"name": "Smoke-Hub", "room_id": room["id"]})
assert call("GET", f"/devices/{hub['id']}")["name"] == "Smoke-Hub"
call("PATCH", f"/devices/{hub['id']}", {"name": "", "clear_room": True})
call("PATCH", f"/devices/{hub['id']}/controls/cFan", {"label": "Umluft oben"})
assert next(c for c in call("GET", f"/devices/{hub['id']}")["controls"] if c["id"] == "cFan")["label"] == "Umluft oben"
call("PATCH", f"/devices/{hub['id']}/controls/cFan", {"label": ""})
call("DELETE", f"/rooms/{room['id']}")
ok("rooms, device rename/room, control rename")

settings = call("PUT", "/settings", {"retention_days": 120})
assert settings["retention_days"] == 120
call("PUT", "/settings", {"retention_days": 90})
ok("settings")

# notifications: choice of events, Telegram setup errors never echo the token
assert set(settings["notify_groups"]) <= set(settings["notify_group_labels"]) and "telegram" in settings
call("PUT", "/settings", {"notify_groups": ["alarm", "gibtsnicht"]}, expect=400)
before = settings["notify_groups"]
assert call("PUT", "/settings", {"notify_groups": ["device", "alarm"]})["notify_groups"] == ["alarm", "device"]
call("PUT", "/settings", {"notify_groups": before})
call("POST", "/settings/telegram/chats", {"token": "kein-token"}, expect=400)
call("PUT", "/settings/telegram", {"chat_id": "keine zahl"}, expect=400)
assert "token" not in json.dumps(call("GET", "/settings")["telegram"]).lower().replace("token_hint", "")
ok("notification settings")

metrics = call("GET", "/history/metrics")
assert metrics, "no history yet"
m = metrics[0]
h = call("GET", f"/history?device_id={m['device_id']}&metric={m['metric']}&hours=6&points=50")
assert len(h["t"]) == len(h["avg"]) > 0
call("GET", f"/control-log?device_id={strip['id']}&hours=1")
ok(f"history ({len(metrics)} series) and control log")

aci = [d for d in call("GET", "/state")["devices"] if d["vendor"] == "acinfinity"]
if aci:
    pro = next(d for d in aci if d["model"] == "Controller 69 Pro")
    aiplus = next(d for d in aci if d["model"] == "Controller AI+")
    outlets = next(d for d in aci if d["model"] == "Outlet AI+")
    c = call("POST", f"/devices/{pro['id']}/controls/p3", {"on": True, "level": 6})
    assert c["mode"] == "2" and c["level"] == 6, c
    deadline = time.time() + 15
    while time.time() < deadline:
        p3 = next(x for x in call("GET", f"/devices/{pro['id']}")["controls"] if x["id"] == "p3")
        if p3["on"]:
            break
        time.sleep(1)
    assert p3["on"] and p3["extra"]["current_level"] == 6, p3
    c = call("POST", f"/devices/{pro['id']}/controls/p3", {"on": False})
    assert c["mode"] == "1", c
    ok("ac infinity 69 Pro: port on with level 6 (running), off")
    editor = call("POST", f"/devices/{aiplus['id']}/native", {"action": "get", "control_id": "p1"})
    assert editor["value"]["mode"] == "3" and editor["ai"] is True, editor
    labels = [m["label"] for m in editor["modes"]]
    assert "CO₂" in labels and "Bodenfeuchte" in labels, labels
    value = editor["value"]
    value["auto"]["temp_high"] = 25
    call("POST", f"/devices/{aiplus['id']}/native", {"action": "set", "control_id": "p1", "value": value})
    again = call("POST", f"/devices/{aiplus['id']}/native", {"action": "get", "control_id": "p1"})["value"]
    assert again["auto"]["temp_high"] == 25, again["auto"]
    call("POST", f"/devices/{aiplus['id']}/native",
         {"action": "set", "control_id": "p1", "value": {"auto": {"temp_high": 200}}}, expect=400)
    ok(f"ac infinity AI+: port editor round trip, sensor modes ({len(labels)} modes), validation")
    c = call("POST", f"/devices/{outlets['id']}/controls/p5", {"on": True})
    assert c["mode"] == "2" and "level" not in c["features"], c
    call("POST", f"/devices/{outlets['id']}/controls/p5", {"level": 5}, expect=400)
    call("POST", f"/devices/{outlets['id']}/controls/p5", {"on": False})
    sensors = {s["key"] for s in aiplus["sensors"]}
    assert {"temp", "humi", "vpd", "co2", "hydro.ph", "leak4"} <= sensors, sensors
    ok(f"ac infinity outlet strip on/off only; AI+ sensors: {', '.join(sorted(sensors))}")

rc_state = call("GET", "/state").get("room_control", {})
if "zelt-1" in rc_state:
    deadline = time.time() + 30
    while time.time() < deadline:
        rc = call("GET", "/rooms/zelt-1/control")
        status = rc["status"] or {}
        if status.get("outputs") and all(o.get("reason") for o in status["outputs"]):
            break
        time.sleep(2)
    vendors = {o["vendor"] for o in status["outputs"]}
    roles = {o["role"] for o in status["outputs"]}
    assert status["enabled"] and {"spiderfarmer", "vivosun"} <= vendors, (status["enabled"], vendors)
    assert {"light", "humidifier", "dehumidifier", "heater"} <= roles, roles
    assert len(status["readings"]["sources"]) >= 2, status["readings"]
    ok(f"room control Zelt 1: {len(status['outputs'])} outputs from {', '.join(sorted(vendors))}, "
       f"averaging {len(status['readings']['sources'])} sensors, {'day' if status['day'] else 'night'} by {status['day_by']}")
    for o in status["outputs"]:
        print(f"     {o['role']:<12} {o['label']} ({o['device_name']}): {o.get('error') or o['reason']}")
    humidifier = next(o for o in status["outputs"] if o["role"] == "humidifier")
    dehumidifier = next(o for o in status["outputs"] if o["role"] == "dehumidifier")
    assert not ((humidifier.get("want") or {}).get("on") and (dehumidifier.get("want") or {}).get("on")), "both humidity actors on"
    cfg = rc["config"]
    call("PUT", "/rooms/zelt-1/control", {**cfg, "outputs": cfg["outputs"] + [cfg["outputs"][1]]}, expect=400)
    call("PUT", "/rooms/zelt-1/control", {**cfg, "temp": {**cfg["temp"], "day": 90}}, expect=400)
    saved = call("PUT", "/rooms/zelt-1/control", {**cfg, "temp": {**cfg["temp"], "day": 24}})
    assert saved["config"]["temp"]["day"] == 24
    call("PUT", "/rooms/zelt-1/control", cfg)
    ok("room control validation: duplicate output and out-of-range target rejected, update saved")
    rule = call("POST", "/rules", {
        "name": "Konflikt-Test", "enabled": True,
        "trigger": {"type": "schedule", "start": "00:00", "end": "23:59"},
        "target": {"device_id": humidifier["device_id"], "control_id": humidifier["control_id"]},
        "active_action": {"on": True}, "inactive_action": None,
    })
    deadline = time.time() + 25
    error = None
    while time.time() < deadline:
        error = call("GET", "/rules")["status"]["rules"].get(rule["id"], {}).get("error")
        if error:
            break
        time.sleep(2)
    assert error and "Zeltsteuerung" in error, error
    call("DELETE", f"/rules/{rule['id']}")
    ok("rule on a room-controlled output is held back: " + error.split(".")[0])
    coupling = next((r for r in call("GET", "/rules")["rules"] if r["trigger"]["type"] == "device_state"), None)
    assert coupling is not None
    call("POST", "/rules", {"name": "Selbstbezug", "trigger": {"type": "device_state", "device_id": "x", "control_id": "y", "state": "on"},
                            "target": {"device_id": "x", "control_id": "y"}, "active_action": {"on": True}}, expect=400)
    ok(f"device-state coupling rule present: {coupling['name']}")

# climate history behind the overview charts: the mixed tent averages all its sensors
state = call("GET", "/state")
tent = next((r for r in state["rooms"] if r["id"] == "zelt-1"), state["rooms"][0] if state["rooms"] else None)
if tent is not None:
    members = [d for d in state["devices"] if d["info"].get("room_id") == tent["id"]]
    params = [(k, f"{d['id']}|{k}") for d in members for k in ("temp", "humi")
              if any(s["key"] == k for s in d["sensors"])]
    params += [("light", f"{d['id']}|{c['id']}") for d in members for c in d["controls"] if c["type"] == "light"]
    params += [("day_start", tent["day_start"]), ("day_end", tent["day_end"]), ("hours", "6"), ("points", "180")]
    hist = call("GET", "/climate/history?" + urllib.parse.urlencode(params))
    assert len(hist["t"]) == len(hist["temp"]) == len(hist["humi"]) == len(hist["vpd"]) > 100, len(hist["t"])
    assert hist["sources"]["temp"] >= 2 and hist["night_source"] in ("light", "schedule"), hist["sources"]
    assert any(v is not None for v in hist["vpd"]), "no VPD in the history"
    assert all(a < b for a, b in hist["nights"]), hist["nights"]
    call("GET", "/climate/history?temp=kaputt", expect=400)
    ok(f"climate history {tent['name']}: {len(hist['t'])} buckets of {hist['bucket']} s from "
       f"{hist['sources']['temp']} sensors, light-off periods from {hist['night_source']}")
    starts = [r for r in call("GET", f"/control-log?device_id={members[0]['id']}&hours=24") if r["source"] == "start"]
    assert starts, "no start states logged"
    ok(f"start states logged for {len(starts)} outputs of {members[0]['name']}")

# growplan: plan per tent, watering log, backup in the format of the Growplan app, room control
gp = call("GET", "/growplan")
assert {"plans", "library", "today"} <= set(gp), gp.keys()
plan = next((p for p in gp["plans"] if p["room_id"] == "zelt-1"), None)
if plan is None:
    plan = call("POST", "/growplan/plans", {"room_id": "zelt-1", "data": {"phase": "flower", "week": 3}})["plan"]
pid = plan["id"]
call("POST", "/growplan/plans", {"room_id": "zelt-1"}, expect=409)
call("GET", "/growplan/plans/gp-gibtsnicht", expect=404)
full = call("GET", f"/growplan/plans/{pid}")
assert full["plan"]["status"]["stage"] in ("seed", "veg1", "veg2", "flo1", "flo2", "flo3", "flush"), full["plan"]["status"]
data = full["plan"]["data"]
saved = call("PUT", f"/growplan/plans/{pid}", {"data": {**data, "liters": "7,5", "strength": 80}})["plan"]
assert saved["data"]["liters"] == 7.5 and saved["data"]["strength"] == 80, saved["data"]
day = gp["today"]
entry = {"date": day, "ts": int(time.time() * 1000), "type": "feed", "liters": 4, "strength": 80, "phIn": "6,1",
         "ecIn": 1.4, "phase": "flower", "week": 3, "plants": [], "tags": ["Entlaubt"],
         "mix": [{"n": "Bio-Bloom", "u": "ml", "v": 2, "c": "#2E7D32"}]}
r = call("PUT", f"/growplan/plans/{pid}/log/smoke-1", entry)
assert r["entry"]["phIn"] == 6.1 and r["plan"]["status"]["last_watering"]["date"] == day, r
call("PUT", f"/growplan/plans/{pid}/log/smoke-2", {**entry, "liters": 0}, expect=400)
call("PUT", f"/growplan/plans/{pid}/log/smoke-2", {**entry, "type": "note", "note": "", "tags": [], "phIn": None, "ecIn": None},
     expect=400)
exported = call("GET", f"/growplan/plans/{pid}/export")
for path, kind, start in ((f"/growplan/plans/{pid}/export?download=1", "application/json", b"{"),
                          (f"/growplan/plans/{pid}/csv", "text/csv", "\ufeffDatum;".encode())):
    with opener.open(BASE + "/api" + path, timeout=20) as resp:
        head, raw = resp.headers, resp.read()
    assert head.get_content_type() == kind and "attachment" in head.get("Content-Disposition", ""), dict(head)
    assert raw.startswith(start) and len(raw) > 100, raw[:40]
assert exported["app"] == "growplan" and exported["format"] == 2, exported.keys()
assert any(e["id"] == "smoke-1" for e in exported["log"]) and exported["settings"]["liters"] == 7.5
copy_plan = call("POST", "/growplan/plans", {"name": "Smoke-Kopie"})["plan"]
res = call("POST", f"/growplan/plans/{copy_plan['id']}/import", exported)
assert res["result"]["settings"] is True and res["result"]["added"] == len(exported["log"]), res["result"]
assert len(res["log"]) == len(exported["log"]) and res["plan"]["data"]["liters"] == 7.5
call("POST", f"/growplan/plans/{copy_plan['id']}/import", {"app": "anders", "log": []}, expect=400)
call("PUT", f"/growplan/plans/{copy_plan['id']}/room", {"room_id": "zelt-1"}, expect=409)
lib = call("PUT", "/growplan/library", {"checkOff": ["d1", "d99"]})["library"]
assert lib["checkOff"] == ["d1"], lib["checkOff"]
call("PUT", "/growplan/library", {"checkOff": []})
ctrl = call("GET", "/rooms/zelt-1/control")
assert ctrl["growplan"] and ctrl["growplan"]["plan_id"] == pid, ctrl.get("growplan")
cfg = ctrl["config"]
saved = call("PUT", "/rooms/zelt-1/control", {**cfg, "plan_targets": True})
source = saved["status"]["plan_source"]
assert source and source["plan_id"] == pid, saved["status"]
assert saved["status"]["plan"]["vpd"]["day"] == ctrl["growplan"]["vpd"]["day"], saved["status"]["plan"]
call("PUT", "/rooms/zelt-1/control", {**cfg, "plan_targets": cfg.get("plan_targets", False)})
state = call("GET", "/state")
assert any(p["id"] == pid for p in state["growplans"]), "plans missing in the state"
call("DELETE", f"/growplan/plans/{pid}/log/smoke-1")
call("DELETE", f"/growplan/plans/{copy_plan['id']}")
call("GET", f"/growplan/plans/{copy_plan['id']}", expect=404)
ok(f"growplan {plan['room_id']}: {source['stage_name']} (week {source['week']}), log, backup round trip with "
   f"{len(exported['log'])} entries, library, room control follows the plan")

events = call("GET", "/events?limit=20")
call("POST", "/events/ack", {})
system = call("GET", "/system")
for key in ("version", "uptime", "db_size", "timezone"):
    assert key in system, f"system lacks {key}: {system}"
integrations = call("GET", "/integrations")
assert integrations["spiderfarmer"]["state"] == "connected", integrations["spiderfarmer"]
assert integrations.get("acinfinity", {}).get("state") in ("connected", "not_configured"), integrations.get("acinfinity")
ok(f"events ({len(events)}), system, integrations (spider farmer {integrations['spiderfarmer']['state']}, vivosun {integrations['vivosun']['state']})")
call("POST", "/auth/logout")
call("GET", "/state", expect=401)
ok("logout")
print("ALL SMOKE TESTS PASSED")

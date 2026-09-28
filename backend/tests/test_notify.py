"""Tests notifications (filter, bundling, webhook, Telegram) against a stand-in Telegram server.

    cd backend && python tests/test_notify.py
"""
from __future__ import annotations

import asyncio
import sys
import tempfile
from pathlib import Path

from aiohttp import web

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import notify  # noqa: E402
from app.db import Database  # noqa: E402
from app.events import EventBus  # noqa: E402
from app.hub import Hub  # noqa: E402
from app.notify import NotifyError, Notifier, group_of, telegram_call, telegram_find_chats  # noqa: E402

TOKEN = "123456:TEST-token_abc"
ok = 0


def check(condition: bool, label: str) -> None:
    global ok
    if not condition:
        raise AssertionError(label)
    ok += 1


class FakeTelegram:
    """Answers like the Bot API: getMe, getUpdates, sendMessage."""

    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.hooks: list[dict] = []

    def app(self) -> web.Application:
        app = web.Application()
        app.router.add_post("/bot{token}/{method}", self.handle)
        app.router.add_post("/hook", self.hook)
        return app

    async def hook(self, request: web.Request) -> web.Response:
        self.hooks.append(await request.json())
        return web.json_response({"ok": True})

    async def handle(self, request: web.Request) -> web.Response:
        token, method = request.match_info["token"], request.match_info["method"]
        if token != TOKEN:
            return web.json_response({"ok": False, "error_code": 401, "description": "Unauthorized"}, status=401)
        body = await request.json()
        if method == "getMe":
            return web.json_response({"ok": True, "result": {"id": 123456, "is_bot": True, "first_name": "Zelt",
                                                             "username": "zelt_bot"}})
        if method == "getUpdates":
            return web.json_response({"ok": True, "result": [
                {"update_id": 1, "message": {"chat": {"id": 555, "type": "private", "first_name": "Flip",
                                                      "username": "flip"}, "text": "/start"}},
                {"update_id": 2, "my_chat_member": {"chat": {"id": -100777, "type": "supergroup",
                                                             "title": "Growzelt"}}},
                {"update_id": 3, "message": {"chat": {"id": 555, "type": "private", "first_name": "Flip"},
                                             "text": "hallo"}},
            ]})
        if method == "sendMessage":
            if str(body.get("chat_id")) == "999":
                return web.json_response({"ok": False, "error_code": 400,
                                          "description": "Bad Request: chat not found"}, status=400)
            self.sent.append(body)
            return web.json_response({"ok": True, "result": {"message_id": len(self.sent)}})
        return web.json_response({"ok": False, "description": "Not Found"}, status=404)


def test_groups() -> None:
    check(group_of({"category": "alarm", "level": "alarm"}) == "alarm", "alarm group")
    check(group_of({"category": "alarm", "level": "info"}) == "alarm", "all-clear in alarm group")
    check(group_of({"category": "device", "level": "warning"}) == "device", "offline")
    check(group_of({"category": "automation", "level": "warning"}) == "problem", "switching error")
    check(group_of({"category": "automation", "level": "info"}) == "switch", "switching")
    check(group_of({"category": "integration", "level": "info"}) is None, "integration not sent")


async def test_notifier(base: str, fake: FakeTelegram) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db = Database(Path(tmp) / "t.sqlite3")
        await db.open()
        hub = Hub(db, EventBus())
        notifier = Notifier(hub)
        notify.BATCH_WAIT = 0.2
        await notifier.start()
        try:
            await run_notifier(notifier, hub, db, base, fake)
        finally:
            await notifier.stop()
            await db.close()


async def run_notifier(notifier: Notifier, hub: Hub, db: Database, base: str, fake: FakeTelegram) -> None:
    # nothing configured: test fails with a clear message, events are filtered but go nowhere
    check(await notifier.send_test() == {}, "no channel yet")
    res = await notifier.send_test("telegram")
    check(not res["telegram"]["ok"] and "fehlen" in res["telegram"]["detail"], "telegram test without setup")
    check((await notifier.telegram_status())["configured"] is False, "not configured")

    # chats and bot name
    found = await telegram_find_chats(TOKEN)
    check(found["bot"]["username"] == "zelt_bot", "bot name")
    names = {c["id"]: c["name"] for c in found["chats"]}
    check(names == {"555": "Flip (@flip)", "-100777": "Growzelt"}, f"chats {names}")

    # errors in German, token never in the text
    for bad, expect in ((TOKEN.replace("TEST", "XXXX"), "kennt diesen Bot-Token nicht"), ("kein-token", "Format")):
        try:
            await telegram_call(bad, "getMe")
            check(False, "bad token must fail")
        except NotifyError as err:
            check(expect in str(err) and bad not in str(err), f"error for {bad}: {err}")

    await db.set_setting("telegram_token", TOKEN)
    await db.set_setting("telegram_chat_id", "999")
    res = await notifier.send_test("telegram")
    check(not res["telegram"]["ok"] and "Chat nicht" in res["telegram"]["detail"], "chat not found")
    await db.set_setting("telegram_chat_id", "555")
    status = await notifier.telegram_status()
    check(status["ready"] and status["token_hint"] == "_abc" and TOKEN not in str(status), "status hides token")
    res = await notifier.send_test("telegram")
    check(res["telegram"]["ok"] and fake.sent[-1]["chat_id"] == "555", "test message")
    fake.sent.clear()

    # events: default groups, bundling, escaping, dedup
    await hub.add_event("alarm", "alarm", "Alarm: Zelt 1 <Temp> liegt bei 31,2 °C (max 30)", None,
                        {"resolved": False})
    await hub.add_event("warning", "device", "Controller sendet keine Daten mehr.", None, {"online": False})
    await hub.add_event("info", "automation", "„Befeuchter“ schaltet Befeuchter an", None)
    await hub.add_event("info", "integration", "Vivosun-Konto verbunden", None)
    await asyncio.sleep(0.8)
    check(len(fake.sent) == 1, f"one bundled message, got {len(fake.sent)}")
    text = fake.sent[0]["text"]
    check("&lt;Temp&gt;" in text and "keine Daten mehr" in text, "escaped and bundled")
    check("schaltet" not in text and "Vivosun" not in text, "switching and integration left out by default")
    check(fake.sent[0]["parse_mode"] == "HTML", "html mode")
    await hub.add_event("warning", "device", "Controller sendet keine Daten mehr.", None, {"online": False})
    await asyncio.sleep(0.5)
    check(len(fake.sent) == 1, "same message not repeated")
    await hub.add_event("info", "alarm", "Wieder im Bereich: Zelt 1 (27,5 °C)", None, {"resolved": True})
    await asyncio.sleep(0.5)
    check(len(fake.sent) == 2 and fake.sent[-1]["text"].startswith("✅"), "all-clear with its own sign")

    # switching on, alarms off
    await db.set_setting("notify_groups", ["switch"])
    await hub.add_event("info", "automation", "„Befeuchter“ schaltet Befeuchter aus", None)
    await hub.add_event("alarm", "alarm", "Alarm: Zelt 2 liegt bei 12 °C (min 15)", None, {})
    await asyncio.sleep(0.5)
    check(len(fake.sent) == 3 and "schaltet" in fake.sent[-1]["text"] and "Zelt 2" not in fake.sent[-1]["text"],
          "groups respected")

    # webhook gets the same events, one each, as JSON
    await db.set_setting("notify_groups", ["alarm", "device", "problem"])
    await db.set_setting("notify_webhook", f"{base}/hook")
    await hub.add_event("alarm", "alarm", "Alarm: Zelt 3 liegt bei 35 °C (max 30)", None,
                        {"alarm_id": "a1", "value": 35.0, "resolved": False, "sensor": "Temperatur", "unit": "°C"})
    await asyncio.sleep(0.5)
    check(len(fake.hooks) == 1 and fake.hooks[0]["alarm_id"] == "a1" and fake.hooks[0]["value"] == 35.0
          and fake.hooks[0]["level"] == "alarm" and fake.hooks[0]["group"] == "alarm", f"webhook {fake.hooks}")
    check(len(fake.sent) == 4, "telegram as well")
    res = await notifier.send_test()
    check(res["webhook"]["ok"] and res["telegram"]["ok"], "test on both")

    # long bundles are cut below Telegram's limit
    long = notifier.telegram_text([{"message": "x" * 900, "group": "alarm"} for _ in range(10)])
    check(len(long) <= 4096 and long.endswith("(gekürzt)"), "cut")
    check(notifier.telegram_text([{"message": "x" * 900, "group": "alarm"} for _ in range(10)], "en")
          .endswith("(truncated)"), "cut in English")

    # messages in English (Optionen → Benachrichtigungen → Sprache der Meldungen)
    await db.set_setting("language", "en")
    sent, hooks = len(fake.sent), len(fake.hooks)
    await hub.add_event("warning", "device", "GGS Controller sendet keine Daten mehr.", None, {"online": False})
    await asyncio.sleep(0.5)
    check(len(fake.sent) == sent + 1 and "GGS Controller has stopped sending data." in fake.sent[-1]["text"],
          f"telegram in English: {fake.sent[-1]['text']}")
    check(len(fake.hooks) == hooks + 1 and fake.hooks[-1]["message"] == "GGS Controller has stopped sending data.",
          "webhook in English")
    await notifier.send_test("telegram")
    check("notifications are working" in fake.sent[-1]["text"], "test message in English")
    await db.set_setting("language", "de")

    # token from the environment when none is saved in the app
    await db.delete_setting("telegram_token")
    env = Notifier(hub, env_token=TOKEN, env_chat_id="555")
    status = await env.telegram_status()
    check(status["source"] == "env" and status["chat_id"] == "555", "env fallback (saved chat wins)")
    await db.delete_setting("telegram_chat_id")
    check((await env.telegram_status())["chat_id"] == "555", "env chat")


async def main() -> None:
    fake = FakeTelegram()
    runner = web.AppRunner(fake.app())
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]
    base = f"http://127.0.0.1:{port}"
    notify.TELEGRAM_API = base
    try:
        test_groups()
        await test_notifier(base, fake)
    finally:
        await runner.cleanup()
    print(f"notify: {ok} checks ok")


if __name__ == "__main__":
    asyncio.run(main())

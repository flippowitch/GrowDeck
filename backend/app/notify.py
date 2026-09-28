"""Push notifications: a web address (ntfy, Home Assistant, Node-RED) and Telegram.

The notifier listens to GrowDeck's event stream, keeps the events the user asked for
(alarms, devices going offline, switching errors, switching by rules and room control)
and sends them from a queue, so a slow or unreachable service never holds up the app.
Telegram messages that arrive within a moment are bundled into one message, and the same
message is not repeated within 15 minutes.
"""

from __future__ import annotations

import asyncio
import html
import logging
import os
import time
from typing import Any

import aiohttp

from .hub import Hub
from .i18n import server_language, tr

_LOGGER = logging.getLogger(__name__)

GROUPS = {
    "alarm": "Alarme und Entwarnungen (auch Growplan-Alarme)",
    "water": "Gießen und Wasser: Erinnerungen, erkannte Gießungen, Tank fast leer",
    "device": "Geräte ohne Daten und wieder erreichbar",
    "problem": "Fehler beim Schalten durch Regeln und Zeltsteuerung",
    "system": "Probleme mit Datensicherung und Kameras",
    "switch": "Jeder Schaltvorgang von Regeln und Zeltsteuerung",
}
DEFAULT_GROUPS = ["alarm", "water", "device", "problem", "system"]
GROUPS_1_4 = ("alarm", "device", "problem", "switch")  # the choice GrowDeck 1.4 offered

TELEGRAM_API = os.environ.get("TELEGRAM_API_BASE", "https://api.telegram.org").rstrip("/")
DEDUP_SECONDS = 900
BATCH_WAIT = 2.0
MAX_BATCH = 15
TELEGRAM_LIMIT = 4000  # Telegram allows 4096 characters per message


class NotifyError(Exception):
    """A notification could not be sent; the message is shown to the user."""


def group_of(event: dict[str, Any]) -> str | None:
    category, level = event.get("category"), event.get("level")
    if category == "alarm":
        return "alarm"
    if category == "device":
        return "device"
    if category == "automation":
        return "problem" if level in ("warning", "alarm") else "switch"
    if category == "water":
        return "water"
    if category in ("backup", "camera") and level in ("warning", "alarm"):
        return "system"
    return None


def _symbol(event: dict[str, Any], group: str) -> str:
    data = event.get("data") or {}
    if data.get("resolved") or data.get("online") is True:
        return "✅"
    if group == "switch":
        return "🔁"
    if group == "water":
        return "💧"
    if group == "device" and event.get("level") == "info":
        return "ℹ️"
    return "⚠️"


# ------------------------------------------------------------------ telegram
def _hide(text: str, token: str) -> str:
    return text.replace(token, "***") if token else text


async def telegram_call(token: str, method: str, payload: dict[str, Any] | None = None,
                        *, timeout: float = 15) -> Any:
    """Calls the Bot API and returns `result`; raises NotifyError with a German message."""
    token = (token or "").strip()
    if not token or ":" not in token:
        raise NotifyError("Der Bot-Token fehlt oder hat nicht das Format 123456789:ABC… von @BotFather.")
    url = f"{TELEGRAM_API}/bot{token}/{method}"
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout)) as session:
            async with session.post(url, json=payload or {}) as resp:
                try:
                    data = await resp.json(content_type=None)
                except Exception:  # noqa: BLE001
                    data = {}
                status = resp.status
    except asyncio.TimeoutError as err:
        raise NotifyError("Telegram antwortet nicht. Hat die NAS Internet?") from err
    except aiohttp.ClientError as err:
        raise NotifyError(f"Telegram ist nicht erreichbar: {_hide(type(err).__name__, token)}") from err
    if isinstance(data, dict) and data.get("ok"):
        return data.get("result")
    description = str((data or {}).get("description") or f"HTTP {status}")
    lower = description.lower()
    if status == 401 or "unauthorized" in lower:
        raise NotifyError("Telegram kennt diesen Bot-Token nicht. Kopiere ihn noch einmal von @BotFather.")
    if status == 404 and "not found" in lower and method != "sendMessage":
        raise NotifyError("Telegram kennt diesen Bot-Token nicht. Kopiere ihn noch einmal von @BotFather.")
    if "chat not found" in lower:
        raise NotifyError("Telegram kennt diesen Chat nicht. Schreib dem Bot zuerst eine Nachricht, "
                          "dann „Chat suchen“.")
    if "blocked" in lower or "kicked" in lower or status == 403:
        raise NotifyError("Der Bot darf in diesen Chat nicht schreiben (blockiert oder aus der Gruppe entfernt).")
    if status == 409:
        raise NotifyError("Für diesen Bot ist ein Webhook eingerichtet, deshalb kann GrowDeck keine Chats "
                          "finden. Trag die Chat-ID von Hand ein.")
    if status == 429:
        retry = ((data or {}).get("parameters") or {}).get("retry_after")
        raise NotifyError(f"Telegram bremst gerade (zu viele Nachrichten){f', wieder in {retry} s' if retry else ''}.")
    raise NotifyError(f"Telegram meldet: {_hide(description, token)}")


def _chat_name(chat: dict[str, Any]) -> str:
    if chat.get("title"):
        return str(chat["title"])
    name = " ".join(str(chat[k]) for k in ("first_name", "last_name") if chat.get(k))
    if chat.get("username"):
        name = f"{name} (@{chat['username']})" if name else f"@{chat['username']}"
    return name or str(chat.get("id"))


async def telegram_find_chats(token: str) -> dict[str, Any]:
    """The bot's name and the chats that wrote to it recently (the last 24 hours)."""
    me = await telegram_call(token, "getMe")
    updates = await telegram_call(token, "getUpdates", {"limit": 100, "timeout": 0})
    chats: dict[str, dict[str, Any]] = {}
    for update in updates or []:
        for key in ("message", "edited_message", "channel_post", "my_chat_member", "chat_member"):
            chat = (update.get(key) or {}).get("chat")
            if chat and chat.get("id") is not None:
                entry = {"id": str(chat["id"]), "name": _chat_name(chat), "type": chat.get("type", "private")}
                known = chats.get(entry["id"])
                if known is None or len(entry["name"]) > len(known["name"]):  # keep the fullest name
                    chats[entry["id"]] = entry
    return {"bot": {"username": me.get("username"), "name": me.get("first_name")}, "chats": list(chats.values())}


# ------------------------------------------------------------------ notifier
class Notifier:
    def __init__(self, hub: Hub, *, env_token: str | None = None, env_chat_id: str | None = None) -> None:
        self.hub = hub
        self.env_token = env_token or None
        self.env_chat_id = env_chat_id or None
        self.queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=500)
        self._recent: dict[tuple[str, str], float] = {}
        self._tasks: list[asyncio.Task[None]] = []
        self.last_error: dict[str, str | None] = {"webhook": None, "telegram": None}

    async def start(self) -> None:
        events = self.hub.bus.subscribe()
        self._tasks = [asyncio.create_task(self._listen(events), name="notify-listen"),
                       asyncio.create_task(self._work(), name="notify-send")]

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)

    # ---------------------------------------------------------------- settings
    async def groups(self) -> list[str]:
        value = await self.hub.db.get_setting("notify_groups", None)
        if not isinstance(value, list):
            return list(DEFAULT_GROUPS)
        # kinds added after the choice was saved start switched on (if they are by default)
        seen = await self.hub.db.get_setting("notify_groups_seen", None)
        seen = set(seen) if isinstance(seen, list) else set(GROUPS_1_4)
        return [g for g in GROUPS if g in value or (g not in seen and g in DEFAULT_GROUPS)]

    async def save_groups(self, groups: list[str]) -> None:
        await self.hub.db.set_setting("notify_groups", [g for g in GROUPS if g in groups])
        await self.hub.db.set_setting("notify_groups_seen", list(GROUPS))

    async def telegram_target(self) -> tuple[str | None, str | None, str]:
        token = await self.hub.db.get_setting("telegram_token", "")
        chat = await self.hub.db.get_setting("telegram_chat_id", "")
        if token:
            return token, (str(chat) if chat else None), "app"
        if self.env_token:
            return self.env_token, (str(chat) if chat else self.env_chat_id), "env"
        return None, None, "none"

    async def telegram_status(self) -> dict[str, Any]:
        token, chat, source = await self.telegram_target()
        return {
            "configured": bool(token),
            "ready": bool(token and chat),
            "source": source,
            "token_hint": token[-4:] if token else "",
            "bot": await self.hub.db.get_setting("telegram_bot", "") if token else "",
            "chat_id": chat or "",
            "chat_name": await self.hub.db.get_setting("telegram_chat_name", "") if chat else "",
            "last_error": self.last_error.get("telegram"),
        }

    # --------------------------------------------------------------- pipeline
    async def _listen(self, events: asyncio.Queue[dict[str, Any]]) -> None:
        while True:
            message = await events.get()
            if message.get("type") != "event":
                continue
            try:
                await self.consider(message["data"])
            except Exception:  # noqa: BLE001
                _LOGGER.exception("Notification filter failed")

    async def consider(self, event: dict[str, Any]) -> bool:
        """Queues an event if the user wants to hear about it. Returns whether it was queued."""
        group = group_of(event)
        if group is None or group not in await self.groups():
            return False
        now = time.time()
        key = (group, str(event.get("message", "")))
        if now - self._recent.get(key, 0) < DEDUP_SECONDS:
            return False
        self._recent[key] = now
        if len(self._recent) > 500:
            self._recent = {k: t for k, t in self._recent.items() if now - t < DEDUP_SECONDS}
        try:
            self.queue.put_nowait({**event, "group": group})
        except asyncio.QueueFull:
            _LOGGER.warning("Notification queue full, dropping: %s", event.get("message"))
            return False
        return True

    async def _work(self) -> None:
        while True:
            first = await self.queue.get()
            await asyncio.sleep(BATCH_WAIT)  # messages of the same moment go out together
            batch = [first]
            while len(batch) < MAX_BATCH and not self.queue.empty():
                batch.append(self.queue.get_nowait())
            await self._deliver(batch)

    async def _deliver(self, batch: list[dict[str, Any]]) -> None:
        lang = await server_language(self.hub.db)
        batch = [{**e, "message": tr(str(e.get("message", "")), lang)} for e in batch]
        for event in batch:
            ok, detail = await self.send_webhook(event)
            if ok is False:
                self.last_error["webhook"] = detail
        token, chat, _ = await self.telegram_target()
        if token and chat:
            text = self.telegram_text(batch, lang)
            try:
                await telegram_call(token, "sendMessage", {
                    "chat_id": chat, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True,
                })
                self.last_error["telegram"] = None
            except NotifyError as err:
                self.last_error["telegram"] = str(err)
                _LOGGER.warning("Telegram notification failed: %s", err)

    def telegram_text(self, batch: list[dict[str, Any]], lang: str = "de") -> str:
        lines = [f"{_symbol(e, e.get('group', ''))} {html.escape(str(e.get('message', '')))}" for e in batch]
        text = "\n\n".join(lines)
        if len(text) > TELEGRAM_LIMIT:
            text = text[:TELEGRAM_LIMIT - 20].rsplit("\n", 1)[0] + "\n\n" + tr("… (gekürzt)", lang)
        return text

    async def send_webhook(self, event: dict[str, Any]) -> tuple[bool | None, str]:
        """None = no address set; else (ok, detail)."""
        url = await self.hub.db.get_setting("notify_webhook", "")
        if not url:
            return None, "Keine Benachrichtigungs-Adresse eingetragen."
        fmt = await self.hub.db.get_setting("notify_format", "json")
        message = str(event.get("message", ""))
        level = str(event.get("level", "info"))
        device = self.hub.devices.get(event.get("device_id") or "")
        try:
            timeout = aiohttp.ClientTimeout(total=10)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                if fmt == "text":
                    headers = {"Title": "GrowDeck", "Priority": "high" if level == "alarm" else "default"}
                    async with session.post(url, data=message.encode(), headers=headers) as resp:
                        ok, detail = resp.status < 400, f"HTTP {resp.status}"
                else:
                    body = {"title": "GrowDeck", "message": message, "level": level,
                            "ts": int(event.get("ts") or time.time()), "category": event.get("category"),
                            "group": event.get("group"), "device_id": event.get("device_id"),
                            "device": device.name if device else None, **(event.get("data") or {})}
                    async with session.post(url, json=body) as resp:
                        ok, detail = resp.status < 400, f"HTTP {resp.status}"
        except Exception as err:  # noqa: BLE001
            ok, detail = False, f"{type(err).__name__}: {err}"
        if not ok:
            _LOGGER.warning("Webhook failed: %s", detail)
        return ok, detail

    # ------------------------------------------------------------------ tests
    async def send_test(self, channel: str | None = None) -> dict[str, dict[str, Any]]:
        """Sends a test message right away (bypassing filter and queue)."""
        text = tr("Testnachricht von GrowDeck: Benachrichtigungen funktionieren.", await server_language(self.hub.db))
        results: dict[str, dict[str, Any]] = {}
        if channel in (None, "webhook"):
            ok, detail = await self.send_webhook({"message": text, "level": "info", "category": "test",
                                                  "data": {"test": True}})
            if ok is not None or channel == "webhook":
                results["webhook"] = {"ok": bool(ok), "detail": detail}
        if channel in (None, "telegram"):
            token, chat, _ = await self.telegram_target()
            if not token or not chat:
                if channel == "telegram":
                    results["telegram"] = {"ok": False, "detail": "Bot-Token und Chat fehlen noch."}
            else:
                try:
                    await telegram_call(token, "sendMessage", {"chat_id": chat, "text": f"✅ {text}"})
                    results["telegram"] = {"ok": True, "detail": "gesendet"}
                    self.last_error["telegram"] = None
                except NotifyError as err:
                    results["telegram"] = {"ok": False, "detail": str(err)}
        return results

"""Polling connection to the AC Infinity cloud (UIS controllers).

The AC Infinity app talks to a plain HTTPS API. There is no push channel, so
GrowDeck polls the controller list (climate, sensors, port states) every few
seconds and the per-port mode settings less often, plus right after changes.
"""
from __future__ import annotations

import asyncio
import copy
import logging
import time
from collections.abc import Callable
from typing import Any

from .vendor.client import ACInfinityClient, ACInfinityClientInvalidAuth
from .vendor.const import HOST

_LOGGER = logging.getLogger(__name__)

SETTINGS_EVERY = 6          # refresh port settings on every n-th poll
MAX_BACKOFF = 300


def flatten_settings(settings: dict[str, Any] | None) -> dict[str, Any]:
    """AI controllers nest part of the port settings in `devSetting`."""
    if not settings:
        return {}
    flat = dict(settings.get("devSetting") or {})
    flat.update({k: v for k, v in settings.items() if k != "devSetting"})
    return flat


class ACInfinityCloud:
    def __init__(self, email: str | None = None, password: str | None = None, *,
                 poll_interval: int = 10, client: Any = None) -> None:
        self.client = client or ACInfinityClient(HOST, email or "", password or "")
        self.email = email
        self.poll_interval = max(5, int(poll_interval or 10))
        self.simulated = bool(getattr(self.client, "simulated", False))
        self.state = "stopped"
        self.last_error: str | None = None
        self.last_sync: float | None = None
        self.controllers: dict[str, dict[str, Any]] = {}
        self.port_settings: dict[tuple[str, int], dict[str, Any]] = {}
        self.on_update: Callable[[], None] | None = None
        self._task: asyncio.Task | None = None
        self._wake = asyncio.Event()
        self._lock = asyncio.Lock()
        self._cycle = 0
        self._settings_due: set[str] = set()

    # ---------------------------------------------------------------- control
    async def start(self) -> None:
        if self._task is None:
            self.state = "connecting"
            self._task = asyncio.create_task(self._run(), name="acinfinity-cloud")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001 - shutting down
                pass
            self._task = None
        try:
            await self.client.close()
        except Exception:  # noqa: BLE001
            pass
        self.state = "stopped"

    def request_refresh(self, controller_id: str | None = None) -> None:
        if controller_id is None:
            self._settings_due.update(self.controllers)
        else:
            self._settings_due.add(controller_id)
        self._wake.set()

    # ------------------------------------------------------------------- loop
    async def _run(self) -> None:
        backoff = 5
        while True:
            try:
                if not self.client.is_logged_in():
                    self.state = "connecting"
                    async with self._lock:
                        await self.client.login()
                await self._poll()
                self.state = "connected"
                self.last_error = None
                backoff = 5
                await self._sleep(self.poll_interval)
            except asyncio.CancelledError:
                raise
            except ACInfinityClientInvalidAuth:
                self.state = "auth_failed"
                self.last_error = "Anmeldung bei AC Infinity fehlgeschlagen. Bitte E-Mail und Passwort prüfen."
                self._logout()
                self._notify()
                await self._sleep(600)
            except Exception as err:  # noqa: BLE001 - network, timeout, API errors
                self.state = "error"
                self.last_error = f"AC-Infinity-Cloud nicht erreichbar ({type(err).__name__}). Neuer Versuch in {backoff} s."
                _LOGGER.warning("AC Infinity: %s", err or type(err).__name__)
                self._logout()  # token may have expired, log in again next round
                self._notify()
                await self._sleep(backoff)
                backoff = min(backoff * 2, MAX_BACKOFF)

    async def _poll(self) -> None:
        async with self._lock:
            data = await self.client.get_account_controllers()
        controllers = {str(item["devId"]): item for item in (data or []) if item.get("devId") is not None}
        self.controllers = controllers
        if self._cycle % SETTINGS_EVERY == 0:
            due = set(controllers)
        else:
            due = self._settings_due & set(controllers)
        self._cycle += 1
        self._settings_due -= due
        for controller_id in due:
            await self._refresh_ports(controller_id)
        for key in [k for k in self.port_settings if k[0] not in controllers]:
            self.port_settings.pop(key, None)
        self.last_sync = time.time()
        self._notify()

    async def _refresh_ports(self, controller_id: str) -> None:
        controller = self.controllers.get(controller_id) or {}
        ports = ((controller.get("deviceInfo") or {}).get("ports")) or []
        for port_json in ports:
            port = int(port_json.get("port") or 0)
            if port <= 0:
                continue
            try:
                async with self._lock:
                    settings = await self.client.get_device_mode_settings(controller_id, port)
                self.port_settings[(controller_id, port)] = settings or {}
            except ACInfinityClientInvalidAuth:
                raise
            except Exception as err:  # noqa: BLE001 - keep the last known settings
                _LOGGER.debug("AC Infinity: Port %s von %s nicht lesbar: %s", port, controller_id, err)

    # --------------------------------------------------------------- commands
    async def get_port(self, controller_id: str, port: int) -> dict[str, Any]:
        async with self._lock:
            settings = await self.client.get_device_mode_settings(controller_id, port)
        self.port_settings[(controller_id, port)] = settings or {}
        return copy.deepcopy(settings or {})

    async def set_port(self, controller_id: str, port: int, values: dict[str, Any], *, ai: bool) -> None:
        async with self._lock:
            if ai:
                await self.client.update_ai_device_control_and_settings(controller_id, port, values)
            else:
                await self.client.update_device_controls(controller_id, port, values)
        cached = self.port_settings.setdefault((controller_id, port), {})
        nested = cached.get("devSetting") if isinstance(cached.get("devSetting"), dict) else None
        for key, value in values.items():
            if nested is not None and key in nested and key not in cached:
                nested[key] = value
            else:
                cached[key] = value
        self.request_refresh(controller_id)
        self._notify()

    # ---------------------------------------------------------------- helpers
    def _logout(self) -> None:
        # The vendored client keeps the session token in `_user_id`.
        if hasattr(self.client, "_user_id"):
            self.client._user_id = None  # noqa: SLF001

    async def _sleep(self, seconds: float) -> None:
        self._wake.clear()
        try:
            await asyncio.wait_for(self._wake.wait(), timeout=seconds)
        except asyncio.TimeoutError:
            pass

    def _notify(self) -> None:
        if self.on_update is not None:
            try:
                self.on_update()
            except Exception:  # noqa: BLE001 - never kill the poll loop
                _LOGGER.exception("AC Infinity: Fehler beim Verarbeiten der Daten")

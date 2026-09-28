"""Central registry that connects adapters, persistence and the API."""

from __future__ import annotations

import asyncio
import copy
import logging
import time
from typing import Any

from .adapters.base import Adapter, AdapterError
from .db import Database
from .events import EventBus
from .model import Control, Device

_LOGGER = logging.getLogger(__name__)

DEFAULT_STALE_AFTER = 180  # seconds without data before a device counts as offline
COMMAND_ECHO_WINDOW = 20  # device-reported changes this soon after a command are its echo


class CommandError(Exception):
    """Raised for invalid commands; message is shown to the user."""


class Hub:
    def __init__(self, db: Database, bus: EventBus) -> None:
        self.db = db
        self.bus = bus
        self.devices: dict[str, Device] = {}
        self.adapters: dict[str, Adapter] = {}
        self.meta: dict[str, dict[str, Any]] = {}
        self._dirty: set[str] = set()
        self._last_command: dict[tuple[str, str], float] = {}
        self._tasks: list[asyncio.Task[None]] = []
        self._known_ids: set[str] = set()
        self._reconciled: set[tuple[str, str]] = set()
        self._reported_offline: set[str] = set()

    # ---------------------------------------------------------------- lifecycle
    async def start(self) -> None:
        self.meta = await self.db.all_device_meta()
        self._known_ids = set(self.meta)
        self._tasks.append(asyncio.create_task(self._flush_loop(), name="hub-flush"))
        self._tasks.append(asyncio.create_task(self._offline_sweep_loop(), name="hub-offline"))
        for adapter in self.adapters.values():
            try:
                await adapter.start(self)
            except Exception:  # noqa: BLE001 - one broken adapter must not stop the app
                _LOGGER.exception("Adapter %s failed to start", adapter.vendor)

    async def stop(self) -> None:
        for adapter in self.adapters.values():
            try:
                await adapter.stop()
            except Exception:  # noqa: BLE001
                _LOGGER.exception("Adapter %s failed to stop", adapter.vendor)
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)

    def register_adapter(self, adapter: Adapter) -> None:
        self.adapters[adapter.vendor] = adapter

    # ------------------------------------------------------------ device intake
    def update_device(self, device: Device) -> None:
        """Adapters call this with a complete, fresh snapshot of one device."""
        previous = self.devices.get(device.id)
        device.info.setdefault("default_name", device.name)
        for control in device.controls.values():
            control.extra.setdefault("default_label", control.label)
        self._apply_meta(device)
        if previous is not None:
            self._log_device_side_changes(previous, device)
        self._reconcile_first_states(device)
        self.devices[device.id] = device
        self._dirty.add(device.id)
        if device.online and device.id in self._reported_offline:
            self._reported_offline.discard(device.id)
            asyncio.get_running_loop().create_task(
                self.add_event("info", "device", f"{device.name} sendet wieder Daten.", device.id, {"online": True}))
        if device.id not in self._known_ids:
            self._known_ids.add(device.id)
            asyncio.get_running_loop().create_task(self._register_new_device(device))

    def mark_offline(self, device_id: str) -> None:
        device = self.devices.get(device_id)
        if device is not None and device.online:
            device.online = False
            self._dirty.add(device_id)

    def remove_device(self, device_id: str) -> None:
        if self.devices.pop(device_id, None) is not None:
            self.bus.publish("device_removed", {"id": device_id})

    async def _register_new_device(self, device: Device) -> None:
        now = int(time.time())
        try:
            await self.db.upsert_device_seen(device.id, device.vendor, device.model, device.kind,
                                             device.info.get("default_name", device.name), now)
            self.meta.setdefault(device.id, {"device_id": device.id, "control_names": {}})
            if not device.simulated:
                await self.add_event("info", "device",
                                     f"Neues Gerät erkannt: {device.info.get('default_name', device.name)}",
                                     device.id)
        except Exception:  # noqa: BLE001
            _LOGGER.exception("Could not store new device %s", device.id)

    def _apply_meta(self, device: Device) -> None:
        meta = self.meta.get(device.id) or {}
        if meta.get("custom_name"):
            device.name = meta["custom_name"]
        device.info["room_id"] = meta.get("room_id")
        device.info["hidden"] = bool(meta.get("hidden"))
        names = meta.get("control_names") or {}
        for control in device.controls.values():
            custom = names.get(control.id)
            if custom:
                control.label = custom

    def _log_device_side_changes(self, old: Device, new: Device) -> None:
        now = time.time()
        for cid, control in new.controls.items():
            before = old.controls.get(cid)
            if before is None:
                continue
            if before.on == control.on and before.level == control.level:
                continue
            if now - self._last_command.get((new.id, cid), 0) < COMMAND_ECHO_WINDOW:
                continue
            asyncio.get_running_loop().create_task(
                self.db.insert_control_log(int(now), new.id, cid, control.on, control.level, "device")
            )

    def _reconcile_first_states(self, device: Device) -> None:
        """Log the first known state of each output after a (re)start if it differs from the
        last logged one, so changes made while GrowDeck was not running show up in the log
        (and light-off periods in the charts stay correct)."""
        pending = []
        for cid, control in device.controls.items():
            key = (device.id, cid)
            if key in self._reconciled or control.on is None:
                continue
            self._reconciled.add(key)
            pending.append((cid, bool(control.on), control.level))
        if pending:
            asyncio.get_running_loop().create_task(self._reconcile_log(device.id, pending))

    async def _reconcile_log(self, device_id: str, pending: list[tuple[str, bool, float | None]]) -> None:
        now = int(time.time())
        for cid, on, level in pending:
            try:
                last = await self.db.control_state_before(device_id, cid, now + 1)
                if last is not None and bool(last.get("on_state")) == on and (not on or last.get("level") == level):
                    continue
                await self.db.insert_control_log(now, device_id, cid, on, level, "start")
            except Exception:  # noqa: BLE001 - the log is informational
                _LOGGER.exception("Could not log the start state of %s/%s", device_id, cid)

    # ----------------------------------------------------------------- metadata
    async def rename_device(self, device_id: str, name: str | None) -> None:
        await self.db.update_device_meta(device_id, custom_name=(name or None))
        self.meta.setdefault(device_id, {"device_id": device_id, "control_names": {}})["custom_name"] = name or None
        self._reapply(device_id)

    async def set_device_room(self, device_id: str, room_id: str | None) -> None:
        await self.db.update_device_meta(device_id, room_id=room_id)
        self.meta.setdefault(device_id, {"device_id": device_id, "control_names": {}})["room_id"] = room_id
        self._reapply(device_id)

    async def set_device_hidden(self, device_id: str, hidden: bool) -> None:
        await self.db.update_device_meta(device_id, hidden=int(hidden))
        self.meta.setdefault(device_id, {"device_id": device_id, "control_names": {}})["hidden"] = int(hidden)
        self._reapply(device_id)

    async def rename_control(self, device_id: str, control_id: str, name: str | None) -> None:
        meta = self.meta.setdefault(device_id, {"device_id": device_id, "control_names": {}})
        names = dict(meta.get("control_names") or {})
        if name:
            names[control_id] = name
        else:
            names.pop(control_id, None)
        meta["control_names"] = names
        await self.db.update_device_meta(device_id, control_names=names)
        self._reapply(device_id)

    def _reapply(self, device_id: str) -> None:
        device = self.devices.get(device_id)
        if device is None:
            return
        device.name = device.info.get("default_name", device.name)
        for control in device.controls.values():
            control.label = control.extra.get("default_label", control.label)
        self._apply_meta(device)
        self._dirty.add(device_id)

    # ----------------------------------------------------------------- commands
    def get_device(self, device_id: str) -> Device:
        device = self.devices.get(device_id)
        if device is None:
            raise CommandError("Gerät nicht gefunden.")
        return device

    def get_control(self, device_id: str, control_id: str) -> tuple[Device, Control]:
        device = self.get_device(device_id)
        control = device.controls.get(control_id)
        if control is None:
            raise CommandError("Diesen Ausgang gibt es an dem Gerät nicht.")
        return device, control

    async def command(self, device_id: str, control_id: str, patch: dict[str, Any],
                      source: str = "user") -> Control:
        device, control = self.get_control(device_id, control_id)
        if not device.online:
            raise CommandError(f"{device.name} ist offline.")
        patch = {k: v for k, v in patch.items() if v is not None}
        if not patch:
            raise CommandError("Keine Änderung angegeben.")
        self._validate_patch(control, patch)
        adapter = self.adapters.get(device.vendor)
        if adapter is None:
            raise CommandError("Für diesen Hersteller ist keine Verbindung aktiv.")
        before = copy.deepcopy(control)
        self._last_command[(device_id, control_id)] = time.time()
        try:
            await adapter.apply(device, control_id, patch)
        except AdapterError as err:
            raise CommandError(str(err)) from err
        current = self.devices.get(device_id, device).controls.get(control_id, control)
        self._dirty.add(device_id)
        if before.on != current.on or before.level != current.level or "on" in patch or "level" in patch:
            await self.db.insert_control_log(int(time.time()), device_id, control_id,
                                             current.on, current.level, source)
        return current

    @staticmethod
    def _validate_patch(control: Control, patch: dict[str, Any]) -> None:
        features = set(control.features)
        if "on" in patch and "on_off" not in features:
            raise CommandError(f"{control.label} lässt sich nicht ein- oder ausschalten.")
        if "level" in patch:
            if "level" not in features:
                raise CommandError(f"{control.label} hat keine einstellbare Stufe.")
            try:
                level = float(patch["level"])
            except (TypeError, ValueError) as err:
                raise CommandError("Die Stufe muss eine Zahl sein.") from err
            if level < control.level_min - 1e-9 and level != 0:
                raise CommandError(f"Minimum für {control.label} ist {control.level_min:g}.")
            if level > control.level_max + 1e-9:
                raise CommandError(f"Maximum für {control.label} ist {control.level_max:g}.")
        if "mode" in patch and control.modes:
            keys = {m["key"] for m in control.modes}
            if patch["mode"] not in keys:
                raise CommandError("Diesen Modus unterstützt das Gerät nicht.")
        if "option" in patch and control.options:
            keys = {o["key"] for o in control.options}
            if patch["option"] not in keys:
                raise CommandError("Diese Auswahl gibt es nicht.")

    async def native(self, device_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        device = self.get_device(device_id)
        adapter = self.adapters.get(device.vendor)
        if adapter is None:
            raise CommandError("Für diesen Hersteller ist keine Verbindung aktiv.")
        try:
            result = await adapter.native(device, payload)
        except AdapterError as err:
            raise CommandError(str(err)) from err
        self._dirty.add(device_id)
        return result

    async def refresh(self, device_id: str) -> None:
        device = self.get_device(device_id)
        adapter = self.adapters.get(device.vendor)
        if adapter is not None:
            await adapter.refresh(device)

    # ------------------------------------------------------------------ events
    async def add_event(self, level: str, category: str, message: str,
                        device_id: str | None = None, data: dict[str, Any] | None = None) -> None:
        event = await self.db.add_event(level, category, message, device_id, data)
        self.bus.publish("event", event)

    # -------------------------------------------------------------- serializing
    def device_payload(self, device: Device, *, include_raw: bool = False) -> dict[str, Any]:
        return device.to_dict(include_raw=include_raw)

    def visible_devices(self) -> list[Device]:
        return sorted(self.devices.values(), key=lambda d: (d.vendor, d.name.lower()))

    # ------------------------------------------------------------------- loops
    async def _flush_loop(self) -> None:
        while True:
            await asyncio.sleep(0.5)
            if not self._dirty:
                continue
            ids, self._dirty = self._dirty, set()
            payload = [self.device_payload(self.devices[i]) for i in ids if i in self.devices]
            if payload:
                self.bus.publish("devices", payload)

    async def _offline_sweep_loop(self) -> None:
        while True:
            await asyncio.sleep(15)
            now = time.time()
            for device in list(self.devices.values()):
                stale_after = float(device.info.get("stale_after", DEFAULT_STALE_AFTER))
                if device.online and now - device.last_seen > stale_after:
                    device.online = False
                    self._dirty.add(device.id)
                    if not device.simulated:
                        self._reported_offline.add(device.id)
                        await self.add_event("warning", "device",
                                             f"{device.name} sendet keine Daten mehr.", device.id, {"online": False})

"""Stores one sample per sensor and interval, and purges old data daily."""

from __future__ import annotations

import asyncio
import logging
import time

from .hub import Hub

_LOGGER = logging.getLogger(__name__)


class HistoryRecorder:
    def __init__(self, hub: Hub, interval: int, retention_days: int) -> None:
        self.hub = hub
        self.interval = interval
        self.retention_days = retention_days
        self._tasks: list[asyncio.Task[None]] = []
        self.samples_written = 0

    async def start(self) -> None:
        stored = await self.hub.db.get_setting("retention_days")
        if isinstance(stored, int) and stored > 0:
            self.retention_days = stored
        self._tasks = [
            asyncio.create_task(self._sample_loop(), name="history-sample"),
            asyncio.create_task(self._purge_loop(), name="history-purge"),
        ]

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)

    async def _sample_loop(self) -> None:
        await asyncio.sleep(min(15, self.interval))
        while True:
            try:
                await self.sample()
            except Exception:  # noqa: BLE001
                _LOGGER.exception("History sampling failed")
            # Align samples to interval boundaries for tidy charts.
            await asyncio.sleep(self.interval - (time.time() % self.interval))

    async def sample(self) -> int:
        now = int(time.time())
        rows: list[tuple[int, str, str, float]] = []
        for device in list(self.hub.devices.values()):
            if not device.online:
                continue
            for sensor in device.sensors.values():
                if sensor.value is None or now - sensor.updated > max(self.interval * 3, 900):
                    continue
                rows.append((now, device.id, sensor.key, float(sensor.value)))
        await self.hub.db.insert_readings(rows)
        self.samples_written += len(rows)
        return len(rows)

    async def _purge_loop(self) -> None:
        await asyncio.sleep(60)
        while True:
            try:
                cutoff = int(time.time()) - self.retention_days * 86400
                deleted = await self.hub.db.purge_older_than(cutoff)
                if deleted:
                    _LOGGER.info("Verlauf: %d alte Messwerte gelöscht", deleted)
            except Exception:  # noqa: BLE001
                _LOGGER.exception("History purge failed")
            await asyncio.sleep(6 * 3600)

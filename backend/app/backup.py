"""Backups of the database.

Every night (time adjustable) GrowDeck writes a compressed copy of its database to
`<data>/backups` and keeps the newest N automatic ones. Backups can also be made by hand,
downloaded, uploaded (e.g. to move to a new NAS) and restored.

A backup is made with SQLite's backup API on a separate connection, so it is consistent
while GrowDeck keeps running. Restoring replaces the database on the next start: the
chosen backup is unpacked and checked, a copy of the current state is kept as a backup
("vor Wiederherstellung"), and GrowDeck restarts (Docker starts the container again).
Photos are files in `<data>/photos` and are not part of the database backup.
"""

from __future__ import annotations

import asyncio
import gzip
import logging
import os
import re
import shutil
import signal
import sqlite3
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from .hub import Hub

_LOGGER = logging.getLogger(__name__)

NAME = re.compile(r"^growdeck-(\d{4}-\d{2}-\d{2}-\d{4})(?:-(manuell|vor-wiederherstellung|hochgeladen))?"
                  r"(?:-(\d+))?\.sqlite3\.gz$")
KINDS = {"": "automatisch", "manuell": "von Hand", "vor-wiederherstellung": "vor Wiederherstellung",
         "hochgeladen": "hochgeladen"}
PENDING = "restore-pending.sqlite3"
REQUIRED_TABLES = {"settings", "rooms", "readings", "events"}
MAX_UPLOAD = 4 * 1024 ** 3
HHMM = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
DEFAULTS = {"enabled": True, "time": "03:30", "keep": 7}


class BackupError(Exception):
    """Shown to the user."""


def backup_dir(data_dir: Path) -> Path:
    return data_dir / "backups"


def _copy_database(source: Path, target: Path) -> None:
    """Consistent copy of a (possibly busy) SQLite database via the backup API."""
    src = sqlite3.connect(f"file:{source}?mode=ro", uri=True, timeout=30)
    try:
        dst = sqlite3.connect(target)
        try:
            src.backup(dst, pages=4096, sleep=0.005)
            dst.execute("PRAGMA journal_mode=DELETE")
        finally:
            dst.close()
    finally:
        src.close()


def _gzip(source: Path, target: Path) -> None:
    with open(source, "rb") as fin, gzip.open(target, "wb", compresslevel=6) as fout:
        shutil.copyfileobj(fin, fout, 1024 * 1024)


def _gunzip(source: Path, target: Path) -> None:
    with gzip.open(source, "rb") as fin, open(target, "wb") as fout:
        shutil.copyfileobj(fin, fout, 1024 * 1024)


def check_database(path: Path) -> dict[str, Any]:
    """Raises BackupError unless `path` is a readable GrowDeck database; returns a short summary."""
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    except sqlite3.Error as err:
        raise BackupError("Die Datei ist keine SQLite-Datenbank.") from err
    try:
        tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not REQUIRED_TABLES <= tables:
            raise BackupError("Die Datei ist keine GrowDeck-Datenbank.")
        ok = con.execute("PRAGMA quick_check").fetchone()
        if not ok or ok[0] != "ok":
            raise BackupError("Die Datenbank in der Sicherung ist beschädigt.")
        summary = {"readings": con.execute("SELECT COUNT(*) FROM readings").fetchone()[0],
                   "rooms": con.execute("SELECT COUNT(*) FROM rooms").fetchone()[0]}
        if "growplans" in tables:
            summary["growplans"] = con.execute("SELECT COUNT(*) FROM growplans").fetchone()[0]
        return summary
    except sqlite3.DatabaseError as err:
        raise BackupError("Die Datei ist keine lesbare Datenbank.") from err
    finally:
        con.close()


def apply_pending_restore(data_dir: Path, db_path: Path) -> bool:
    """Called at start before the database opens: puts a restored database in place."""
    pending = data_dir / PENDING
    if not pending.exists():
        return False
    try:
        check_database(pending)
    except BackupError as err:
        _LOGGER.error("Wiederherstellung verworfen: %s", err)
        pending.unlink(missing_ok=True)
        return False
    for suffix in ("-wal", "-shm"):
        Path(f"{db_path}{suffix}").unlink(missing_ok=True)
    os.replace(pending, db_path)
    _LOGGER.warning("Datenbank aus einer Sicherung wiederhergestellt.")
    return True


class BackupService:
    def __init__(self, hub: Hub, data_dir: Path, db_path: Path, tz: str) -> None:
        self.hub = hub
        self.dir = backup_dir(data_dir)
        self.data_dir = data_dir
        self.db_path = db_path
        self.tz = ZoneInfo(tz)
        self.last_error: str | None = None
        self.running = False
        self._lock = asyncio.Lock()
        self._task: asyncio.Task[None] | None = None
        self.restarting = False
        self.restored_at_start = False

    async def start(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        if self.restored_at_start:
            await self.hub.add_event("warning", "backup", "GrowDeck wurde aus einer Datensicherung wiederhergestellt.")
        self._task = asyncio.create_task(self._loop(), name="backup")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)

    # --------------------------------------------------------------- settings
    async def settings(self) -> dict[str, Any]:
        stored = await self.hub.db.get_setting("backup", {}) or {}
        result = dict(DEFAULTS)
        if isinstance(stored, dict):
            result["enabled"] = stored.get("enabled", True) is not False
            if isinstance(stored.get("time"), str) and HHMM.match(stored["time"]):
                result["time"] = stored["time"]
            try:
                result["keep"] = max(1, min(60, int(stored.get("keep", DEFAULTS["keep"]))))
            except (TypeError, ValueError):
                pass
        return result

    async def save_settings(self, raw: dict[str, Any]) -> dict[str, Any]:
        current = await self.settings()
        if "enabled" in raw:
            current["enabled"] = bool(raw["enabled"])
        if "time" in raw:
            if not isinstance(raw["time"], str) or not HHMM.match(raw["time"]):
                raise BackupError("Die Uhrzeit bitte als HH:MM angeben.")
            current["time"] = raw["time"]
        if "keep" in raw:
            try:
                keep = int(raw["keep"])
            except (TypeError, ValueError) as err:
                raise BackupError("Anzahl der Sicherungen bitte als Zahl angeben.") from err
            if not 1 <= keep <= 60:
                raise BackupError("Zwischen 1 und 60 Sicherungen aufheben.")
            current["keep"] = keep
        await self.hub.db.set_setting("backup", current)
        return current

    def next_run(self, cfg: dict[str, Any], now: datetime | None = None) -> datetime:
        now = now or datetime.now(self.tz)
        hour, minute = (int(x) for x in cfg["time"].split(":"))
        run = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        return run if run > now else run + timedelta(days=1)

    # ------------------------------------------------------------------- list
    def list(self) -> list[dict[str, Any]]:
        items = []
        if not self.dir.exists():
            return items
        for path in self.dir.iterdir():
            match = NAME.match(path.name)
            if not match or not path.is_file():
                continue
            stat = path.stat()
            items.append({"name": path.name, "size": stat.st_size, "created": int(stat.st_mtime),
                          "kind": match.group(2) or "", "kind_label": KINDS.get(match.group(2) or "", ""),
                          "_order": (match.group(1), int(match.group(3) or 1), stat.st_mtime_ns)})
        items.sort(key=lambda i: i["_order"], reverse=True)
        for item in items:
            del item["_order"]
        return items

    async def status(self) -> dict[str, Any]:
        cfg = await self.settings()
        items = self.list()
        last_auto = next((i for i in items if i["kind"] == ""), None)
        return {
            **cfg, "items": items, "running": self.running, "last_error": self.last_error,
            "last": items[0]["created"] if items else None,
            "last_auto": last_auto["created"] if last_auto else None,
            "next": int(self.next_run(cfg).timestamp()) if cfg["enabled"] else None,
            "total_bytes": sum(i["size"] for i in items),
            "database_bytes": sum(Path(f"{self.db_path}{s}").stat().st_size
                                  for s in ("", "-wal") if Path(f"{self.db_path}{s}").exists()),
        }

    def path_of(self, name: str) -> Path:
        if not NAME.match(name or ""):
            raise BackupError("Unbekannte Sicherung.")
        path = self.dir / name
        if not path.is_file():
            raise BackupError("Diese Sicherung gibt es nicht mehr.")
        return path

    def _new_name(self, kind: str = "") -> Path:
        stamp = datetime.now(self.tz).strftime("%Y-%m-%d-%H%M")
        base = f"growdeck-{stamp}{f'-{kind}' if kind else ''}"
        path = self.dir / f"{base}.sqlite3.gz"
        n = 2
        while path.exists():
            path = self.dir / f"{base}-{n}.sqlite3.gz"
            n += 1
        return path

    # ----------------------------------------------------------------- create
    async def create(self, kind: str = "") -> dict[str, Any]:
        async with self._lock:
            self.running = True
            self.hub.bus.publish("backup", {"running": True})
            try:
                self.dir.mkdir(parents=True, exist_ok=True)
                target = self._new_name(kind)
                tmp = self.dir / f".{target.name}.tmp.sqlite3"
                started = time.monotonic()
                try:
                    await asyncio.to_thread(_copy_database, self.db_path, tmp)
                    await asyncio.to_thread(_gzip, tmp, target)
                finally:
                    tmp.unlink(missing_ok=True)
                self.last_error = None
                _LOGGER.info("Datensicherung %s (%.1f s)", target.name, time.monotonic() - started)
                item = next(i for i in self.list() if i["name"] == target.name)
                if kind == "":
                    await self.prune()
                return item
            except BackupError:
                raise
            except Exception as err:  # noqa: BLE001
                self.last_error = f"{type(err).__name__}: {err}"
                raise BackupError(f"Die Sicherung ist fehlgeschlagen: {err}") from err
            finally:
                self.running = False
                self.hub.bus.publish("backup", {"running": False})

    async def prune(self) -> list[str]:
        keep = (await self.settings())["keep"]
        autos = [i for i in self.list() if i["kind"] == ""]
        removed = []
        for item in autos[keep:]:
            (self.dir / item["name"]).unlink(missing_ok=True)
            removed.append(item["name"])
        # the safety copies made before restoring: keep the newest three
        for item in [i for i in self.list() if i["kind"] == "vor-wiederherstellung"][3:]:
            (self.dir / item["name"]).unlink(missing_ok=True)
            removed.append(item["name"])
        return removed

    async def delete(self, name: str) -> None:
        self.path_of(name).unlink()

    # ---------------------------------------------------------------- upload
    async def store_upload(self, chunks: Any) -> dict[str, Any]:
        """Stores an uploaded .sqlite3 or .sqlite3.gz file as a backup after checking it."""
        self.dir.mkdir(parents=True, exist_ok=True)
        raw = self.dir / f".upload-{os.getpid()}-{int(time.time() * 1000)}"
        plain = raw.with_suffix(".sqlite3")
        size = 0
        try:
            with open(raw, "wb") as out:
                async for chunk in chunks:
                    size += len(chunk)
                    if size > MAX_UPLOAD:
                        raise BackupError("Die Datei ist zu groß (höchstens 4 GB).")
                    out.write(chunk)
            if size == 0:
                raise BackupError("Die Datei ist leer.")
            with open(raw, "rb") as head:
                gz = head.read(2) == b"\x1f\x8b"
            if gz:
                try:
                    await asyncio.to_thread(_gunzip, raw, plain)
                except (OSError, EOFError) as err:
                    raise BackupError("Die Datei lässt sich nicht entpacken.") from err
            else:
                os.replace(raw, plain)
            summary = await asyncio.to_thread(check_database, plain)
            target = self._new_name("hochgeladen")
            await asyncio.to_thread(_gzip, plain, target)
            item = next(i for i in self.list() if i["name"] == target.name)
            return {**item, "summary": summary}
        finally:
            raw.unlink(missing_ok=True)
            plain.unlink(missing_ok=True)

    # --------------------------------------------------------------- restore
    async def prepare_restore(self, name: str) -> dict[str, Any]:
        path = self.path_of(name)
        pending = self.data_dir / PENDING
        tmp = self.data_dir / f".{PENDING}.tmp"
        try:
            await asyncio.to_thread(_gunzip, path, tmp)
            summary = await asyncio.to_thread(check_database, tmp)
            safety = await self.create("vor-wiederherstellung")
            os.replace(tmp, pending)
        except (OSError, EOFError) as err:
            raise BackupError("Die Sicherung lässt sich nicht entpacken.") from err
        finally:
            tmp.unlink(missing_ok=True)
        await self.hub.add_event("warning", "backup", f"Wiederherstellung aus {name} vorbereitet, GrowDeck startet neu.")
        return {"summary": summary, "safety": safety["name"]}

    def restart_soon(self, delay: float = 1.5) -> None:
        """Ends the process; Docker (restart: unless-stopped) starts GrowDeck again."""
        self.restarting = True

        def stop() -> None:
            _LOGGER.warning("Neustart für die Wiederherstellung")
            os.kill(os.getpid(), signal.SIGTERM)

        asyncio.get_running_loop().call_later(delay, stop)

    # ------------------------------------------------------------------ loop
    async def _loop(self) -> None:
        await asyncio.sleep(30)
        while True:
            cfg = await self.settings()
            now = datetime.now(self.tz)
            if cfg["enabled"]:
                last = next((i for i in self.list() if i["kind"] == ""), None)
                # catch up when the NAS was off at the usual time
                overdue = last is None or time.time() - last["created"] > 36 * 3600
                wait = 0 if overdue else (self.next_run(cfg, now) - now).total_seconds()
            else:
                wait = 3600
            if wait > 0:
                await asyncio.sleep(min(wait, 3600))
                if wait > 3600:
                    continue
                cfg = await self.settings()
                if not cfg["enabled"]:
                    continue
            try:
                await self.create()
            except BackupError as err:
                await self.hub.add_event("warning", "backup", str(err))
                await asyncio.sleep(6 * 3600)
            await asyncio.sleep(90)

"""SQLite persistence.

One file on the NAS volume holds everything: settings, device metadata, rooms,
sensor history, automation rules, alarms and the event log. SQLite in WAL mode
comfortably handles a few devices writing a sample per minute for 90 days.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import aiosqlite

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS device_meta (
    device_id TEXT PRIMARY KEY,
    vendor TEXT,
    model TEXT,
    kind TEXT,
    name TEXT,
    custom_name TEXT,
    room_id TEXT,
    hidden INTEGER NOT NULL DEFAULT 0,
    control_names TEXT NOT NULL DEFAULT '{}',
    first_seen INTEGER,
    last_seen INTEGER
);

CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0,
    climate_device_id TEXT,
    climate_group TEXT,
    day_start TEXT NOT NULL DEFAULT '06:00',
    day_end TEXT NOT NULL DEFAULT '00:00',
    stage TEXT NOT NULL DEFAULT 'veg'
);

CREATE TABLE IF NOT EXISTS room_control (
    room_id TEXT PRIMARY KEY,
    config TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS readings (
    ts INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    metric TEXT NOT NULL,
    value REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_readings_dev ON readings(device_id, metric, ts);
CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings(ts);

CREATE TABLE IF NOT EXISTS control_log (
    ts INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    control_id TEXT NOT NULL,
    on_state INTEGER,
    level REAL,
    source TEXT
);
CREATE INDEX IF NOT EXISTS idx_control_log ON control_log(device_id, control_id, ts);

CREATE TABLE IF NOT EXISTS rules (
    id TEXT PRIMARY KEY,
    sort INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alarms (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    level TEXT NOT NULL,
    category TEXT NOT NULL,
    message TEXT NOT NULL,
    device_id TEXT,
    data TEXT,
    acknowledged INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS growplans (
    id TEXT PRIMARY KEY,
    room_id TEXT,
    name TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_growplans_room ON growplans(room_id) WHERE room_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS growlog (
    plan_id TEXT NOT NULL,
    id TEXT NOT NULL,
    date TEXT NOT NULL,
    ts INTEGER NOT NULL DEFAULT 0,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (plan_id, id)
);
CREATE INDEX IF NOT EXISTS idx_growlog_date ON growlog(plan_id, date, ts);

CREATE TABLE IF NOT EXISTS photos (
    id TEXT PRIMARY KEY,
    camera_id TEXT NOT NULL,
    room_id TEXT,
    ts INTEGER NOT NULL,
    file TEXT NOT NULL,
    thumb TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'auto'
);
CREATE INDEX IF NOT EXISTS idx_photos_camera ON photos(camera_id, ts);
CREATE INDEX IF NOT EXISTS idx_photos_room ON photos(room_id, ts);

CREATE TABLE IF NOT EXISTS room_days (
    room_id TEXT NOT NULL,
    date TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (room_id, date)
);

CREATE TABLE IF NOT EXISTS grows (
    id TEXT PRIMARY KEY,
    room_id TEXT,
    name TEXT NOT NULL,
    started TEXT,
    harvested TEXT,
    data TEXT NOT NULL,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL
);
"""

SCHEMA_VERSION = 1


class Database:
    def __init__(self, path: Path) -> None:
        self._path = path
        self._conn: aiosqlite.Connection | None = None

    async def open(self) -> None:
        self._conn = await aiosqlite.connect(self._path)
        self._conn.row_factory = aiosqlite.Row
        await self._conn.executescript(SCHEMA)
        await self._conn.commit()
        await self._migrate()

    async def _migrate(self) -> None:
        async with self.conn.execute("PRAGMA user_version") as cur:
            row = await cur.fetchone()
        version = int(row[0]) if row else 0
        if version < 1:
            # 1.2.0: status flags of the Spider Farmer controller (isDaySensor, isDayEnvTarget)
            # were recorded like readings before. They are no measurements.
            await self.conn.execute("DELETE FROM readings WHERE metric GLOB 'sensor.is[A-Z]*'")
        if version < SCHEMA_VERSION:
            await self.conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
            await self.conn.commit()

    async def close(self) -> None:
        if self._conn is not None:
            await self._conn.close()
            self._conn = None

    @property
    def conn(self) -> aiosqlite.Connection:
        if self._conn is None:
            raise RuntimeError("Database is not open")
        return self._conn

    @property
    def path(self) -> Path:
        return self._path

    # ------------------------------------------------------------------ photos
    async def add_photo(self, photo: dict[str, Any]) -> None:
        await self.conn.execute(
            """INSERT OR REPLACE INTO photos(id, camera_id, room_id, ts, file, thumb, size, source)
               VALUES(:id, :camera_id, :room_id, :ts, :file, :thumb, :size, :source)""", photo)
        await self.conn.commit()

    async def list_photos(self, *, camera_id: str | None = None, room_id: str | None = None,
                          start: int | None = None, end: int | None = None, limit: int = 500,
                          before: int | None = None) -> list[dict[str, Any]]:
        sql = "SELECT * FROM photos WHERE 1=1"
        params: list[Any] = []
        for column, value in (("camera_id", camera_id), ("room_id", room_id)):
            if value is not None:
                sql += f" AND {column}=?"
                params.append(value)
        if start is not None:
            sql += " AND ts>=?"
            params.append(start)
        if end is not None:
            sql += " AND ts<=?"
            params.append(end)
        if before is not None:
            sql += " AND ts<?"
            params.append(before)
        sql += " ORDER BY ts DESC LIMIT ?"
        params.append(limit)
        async with self.conn.execute(sql, params) as cur:
            return [dict(r) for r in await cur.fetchall()]

    async def get_photo(self, photo_id: str) -> dict[str, Any] | None:
        async with self.conn.execute("SELECT * FROM photos WHERE id=?", (photo_id,)) as cur:
            row = await cur.fetchone()
        return dict(row) if row else None

    async def delete_photo(self, photo_id: str) -> None:
        await self.conn.execute("DELETE FROM photos WHERE id=?", (photo_id,))
        await self.conn.commit()

    async def photo_counts(self) -> dict[str, dict[str, Any]]:
        async with self.conn.execute(
            "SELECT camera_id, COUNT(*) AS n, MAX(ts) AS last, SUM(size) AS bytes FROM photos GROUP BY camera_id"
        ) as cur:
            return {r["camera_id"]: {"count": r["n"], "last": r["last"], "bytes": r["bytes"] or 0}
                    for r in await cur.fetchall()}

    # --------------------------------------------------------------- room days
    async def save_room_day(self, room_id: str, day: str, data: dict[str, Any]) -> None:
        await self.conn.execute(
            "INSERT OR REPLACE INTO room_days(room_id, date, data) VALUES(?, ?, ?)",
            (room_id, day, json.dumps(data)))
        await self.conn.commit()

    async def room_days(self, room_id: str, start: str, end: str) -> list[dict[str, Any]]:
        async with self.conn.execute(
            "SELECT date, data FROM room_days WHERE room_id=? AND date>=? AND date<=? ORDER BY date",
            (room_id, start, end),
        ) as cur:
            rows = await cur.fetchall()
        return [{"date": r["date"], **json.loads(r["data"])} for r in rows]

    async def room_day_dates(self, room_id: str) -> set[str]:
        async with self.conn.execute("SELECT date FROM room_days WHERE room_id=?", (room_id,)) as cur:
            return {r["date"] for r in await cur.fetchall()}

    # -------------------------------------------------------------------- grows
    async def save_grow(self, grow: dict[str, Any]) -> None:
        body = {k: v for k, v in grow.items() if k not in ("id", "room_id", "name", "started", "harvested",
                                                           "created", "updated")}
        await self.conn.execute(
            """INSERT INTO grows(id, room_id, name, started, harvested, data, created, updated)
               VALUES(?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET room_id=excluded.room_id, name=excluded.name,
               started=excluded.started, harvested=excluded.harvested, data=excluded.data,
               updated=excluded.updated""",
            (grow["id"], grow.get("room_id"), grow["name"], grow.get("started"), grow.get("harvested"),
             json.dumps(body), int(grow["created"]), int(grow["updated"])),
        )
        await self.conn.commit()

    async def list_grows(self) -> list[dict[str, Any]]:
        async with self.conn.execute("SELECT * FROM grows ORDER BY harvested DESC, created DESC") as cur:
            rows = await cur.fetchall()
        grows = []
        for row in rows:
            item = dict(row)
            item.update(json.loads(item.pop("data") or "{}"))
            grows.append(item)
        return grows

    async def delete_grow(self, grow_id: str) -> None:
        await self.conn.execute("DELETE FROM grows WHERE id=?", (grow_id,))
        await self.conn.commit()

    # ----------------------------------------------------------------- settings
    async def get_setting(self, key: str, default: Any = None) -> Any:
        async with self.conn.execute("SELECT value FROM settings WHERE key=?", (key,)) as cur:
            row = await cur.fetchone()
        if row is None:
            return default
        try:
            return json.loads(row["value"])
        except (TypeError, ValueError):
            return default

    async def set_setting(self, key: str, value: Any) -> None:
        await self.conn.execute(
            "INSERT INTO settings(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, json.dumps(value)),
        )
        await self.conn.commit()

    async def delete_setting(self, key: str) -> None:
        await self.conn.execute("DELETE FROM settings WHERE key=?", (key,))
        await self.conn.commit()

    # ------------------------------------------------------------- device meta
    async def all_device_meta(self) -> dict[str, dict[str, Any]]:
        async with self.conn.execute("SELECT * FROM device_meta") as cur:
            rows = await cur.fetchall()
        result: dict[str, dict[str, Any]] = {}
        for row in rows:
            item = dict(row)
            try:
                item["control_names"] = json.loads(item.get("control_names") or "{}")
            except ValueError:
                item["control_names"] = {}
            result[item["device_id"]] = item
        return result

    async def upsert_device_seen(self, device_id: str, vendor: str, model: str, kind: str,
                                 name: str, ts: int) -> None:
        await self.conn.execute(
            """INSERT INTO device_meta(device_id, vendor, model, kind, name, first_seen, last_seen)
               VALUES(?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(device_id) DO UPDATE SET vendor=excluded.vendor, model=excluded.model,
               kind=excluded.kind, name=excluded.name, last_seen=excluded.last_seen""",
            (device_id, vendor, model, kind, name, ts, ts),
        )
        await self.conn.commit()

    async def update_device_meta(self, device_id: str, **fields: Any) -> None:
        allowed = {"custom_name", "room_id", "hidden", "control_names"}
        sets = []
        values: list[Any] = []
        for key, value in fields.items():
            if key not in allowed:
                continue
            if key == "control_names":
                value = json.dumps(value)
            sets.append(f"{key}=?")
            values.append(value)
        if not sets:
            return
        await self.conn.execute(
            "INSERT OR IGNORE INTO device_meta(device_id) VALUES(?)", (device_id,)
        )
        values.append(device_id)
        await self.conn.execute(f"UPDATE device_meta SET {', '.join(sets)} WHERE device_id=?", values)
        await self.conn.commit()

    async def delete_device_meta(self, device_id: str) -> None:
        await self.conn.execute("DELETE FROM device_meta WHERE device_id=?", (device_id,))
        await self.conn.commit()

    # ------------------------------------------------------------------- rooms
    async def list_rooms(self) -> list[dict[str, Any]]:
        async with self.conn.execute("SELECT * FROM rooms ORDER BY sort, name") as cur:
            return [dict(r) for r in await cur.fetchall()]

    async def save_room(self, room: dict[str, Any]) -> None:
        await self.conn.execute(
            """INSERT INTO rooms(id, name, sort, climate_device_id, climate_group, day_start, day_end, stage)
               VALUES(:id, :name, :sort, :climate_device_id, :climate_group, :day_start, :day_end, :stage)
               ON CONFLICT(id) DO UPDATE SET name=excluded.name, sort=excluded.sort,
               climate_device_id=excluded.climate_device_id, climate_group=excluded.climate_group,
               day_start=excluded.day_start, day_end=excluded.day_end, stage=excluded.stage""",
            room,
        )
        await self.conn.commit()

    async def delete_room(self, room_id: str) -> None:
        await self.conn.execute("DELETE FROM rooms WHERE id=?", (room_id,))
        await self.conn.execute("UPDATE device_meta SET room_id=NULL WHERE room_id=?", (room_id,))
        await self.conn.execute("DELETE FROM room_control WHERE room_id=?", (room_id,))
        # the grow plan and its log stay, the plan is just no longer tied to a tent
        await self.conn.execute("UPDATE growplans SET room_id=NULL WHERE room_id=?", (room_id,))
        await self.conn.commit()

    async def list_room_controls(self) -> dict[str, dict[str, Any]]:
        async with self.conn.execute("SELECT room_id, config FROM room_control") as cur:
            rows = await cur.fetchall()
        return {row["room_id"]: json.loads(row["config"]) for row in rows}

    async def save_room_control(self, room_id: str, config: dict[str, Any]) -> None:
        await self.conn.execute(
            "INSERT INTO room_control(room_id, config) VALUES(?, ?) "
            "ON CONFLICT(room_id) DO UPDATE SET config=excluded.config",
            (room_id, json.dumps(config)),
        )
        await self.conn.commit()

    async def delete_room_control(self, room_id: str) -> None:
        await self.conn.execute("DELETE FROM room_control WHERE room_id=?", (room_id,))
        await self.conn.commit()

    # ---------------------------------------------------------------- readings
    async def insert_readings(self, rows: list[tuple[int, str, str, float]]) -> None:
        if not rows:
            return
        await self.conn.executemany(
            "INSERT INTO readings(ts, device_id, metric, value) VALUES(?, ?, ?, ?)", rows
        )
        await self.conn.commit()

    async def query_readings(self, device_id: str, metric: str, start: int, end: int,
                             bucket: int) -> list[tuple[int, float, float, float]]:
        sql = (
            "SELECT (ts / :bucket) * :bucket AS t, AVG(value), MIN(value), MAX(value) "
            "FROM readings WHERE device_id=:dev AND metric=:metric AND ts BETWEEN :start AND :end "
            "GROUP BY t ORDER BY t"
        )
        params = {"bucket": max(1, bucket), "dev": device_id, "metric": metric,
                  "start": start, "end": end}
        async with self.conn.execute(sql, params) as cur:
            rows = await cur.fetchall()
        return [(int(r[0]), float(r[1]), float(r[2]), float(r[3])) for r in rows]

    async def list_metrics(self) -> list[dict[str, Any]]:
        since = int(time.time()) - 7 * 86400
        async with self.conn.execute(
            "SELECT device_id, metric, COUNT(*) AS n, MAX(ts) AS last FROM readings "
            "WHERE ts > ? GROUP BY device_id, metric",
            (since,),
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]

    async def insert_control_log(self, ts: int, device_id: str, control_id: str,
                                 on_state: bool | None, level: float | None, source: str) -> None:
        await self.conn.execute(
            "INSERT INTO control_log(ts, device_id, control_id, on_state, level, source) "
            "VALUES(?, ?, ?, ?, ?, ?)",
            (ts, device_id, control_id, None if on_state is None else int(on_state), level, source),
        )
        await self.conn.commit()

    async def query_control_log(self, device_id: str | None, start: int, end: int,
                                limit: int = 500) -> list[dict[str, Any]]:
        sql = "SELECT * FROM control_log WHERE ts BETWEEN ? AND ?"
        params: list[Any] = [start, end]
        if device_id:
            sql += " AND device_id=?"
            params.append(device_id)
        sql += " ORDER BY ts DESC LIMIT ?"
        params.append(limit)
        async with self.conn.execute(sql, params) as cur:
            return [dict(r) for r in await cur.fetchall()]

    async def control_state_before(self, device_id: str, control_id: str, ts: int) -> dict[str, Any] | None:
        """Last logged state of one output before a point in time."""
        async with self.conn.execute(
            "SELECT ts, on_state, level, source FROM control_log WHERE device_id=? AND control_id=? AND ts<? "
            "ORDER BY ts DESC LIMIT 1",
            (device_id, control_id, ts),
        ) as cur:
            row = await cur.fetchone()
        return dict(row) if row else None

    async def control_changes(self, device_id: str, control_id: str, start: int,
                              end: int) -> list[dict[str, Any]]:
        """Logged states of one output within a period, oldest first."""
        async with self.conn.execute(
            "SELECT ts, on_state, level, source FROM control_log WHERE device_id=? AND control_id=? "
            "AND ts BETWEEN ? AND ? ORDER BY ts ASC LIMIT 20000",
            (device_id, control_id, start, end),
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]

    async def purge_older_than(self, cutoff: int) -> int:
        cur = await self.conn.execute("DELETE FROM readings WHERE ts < ?", (cutoff,))
        deleted = cur.rowcount or 0
        await self.conn.execute("DELETE FROM control_log WHERE ts < ?", (cutoff,))
        await self.conn.execute("DELETE FROM events WHERE ts < ?", (cutoff,))
        await self.conn.commit()
        return deleted

    # ------------------------------------------------------------ rules/alarms
    async def list_json(self, table: str) -> list[dict[str, Any]]:
        order = " ORDER BY sort" if table == "rules" else ""
        async with self.conn.execute(f"SELECT id, data FROM {table}{order}") as cur:
            rows = await cur.fetchall()
        items = []
        for row in rows:
            try:
                item = json.loads(row["data"])
            except ValueError:
                continue
            item["id"] = row["id"]
            items.append(item)
        return items

    async def save_json(self, table: str, item_id: str, data: dict[str, Any], sort: int = 0) -> None:
        payload = json.dumps({k: v for k, v in data.items() if k != "id"})
        if table == "rules":
            await self.conn.execute(
                "INSERT INTO rules(id, sort, data) VALUES(?, ?, ?) "
                "ON CONFLICT(id) DO UPDATE SET data=excluded.data, sort=excluded.sort",
                (item_id, sort, payload),
            )
        else:
            await self.conn.execute(
                f"INSERT INTO {table}(id, data) VALUES(?, ?) "
                "ON CONFLICT(id) DO UPDATE SET data=excluded.data",
                (item_id, payload),
            )
        await self.conn.commit()

    async def delete_json(self, table: str, item_id: str) -> None:
        await self.conn.execute(f"DELETE FROM {table} WHERE id=?", (item_id,))
        await self.conn.commit()

    # --------------------------------------------------------------- growplan
    async def list_growplans(self) -> list[dict[str, Any]]:
        async with self.conn.execute(
            "SELECT id, room_id, name, data, created, updated FROM growplans ORDER BY created"
        ) as cur:
            rows = await cur.fetchall()
        plans = []
        for row in rows:
            item = dict(row)
            try:
                item["data"] = json.loads(item["data"])
            except ValueError:
                item["data"] = {}
            plans.append(item)
        return plans

    async def save_growplan(self, plan: dict[str, Any]) -> None:
        await self.conn.execute(
            """INSERT INTO growplans(id, room_id, name, data, created, updated)
               VALUES(?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET room_id=excluded.room_id, name=excluded.name,
               data=excluded.data, updated=excluded.updated""",
            (plan["id"], plan.get("room_id"), plan.get("name") or "", json.dumps(plan["data"]),
             int(plan["created"]), int(plan["updated"])),
        )
        await self.conn.commit()

    async def delete_growplan(self, plan_id: str) -> None:
        await self.conn.execute("DELETE FROM growlog WHERE plan_id=?", (plan_id,))
        await self.conn.execute("DELETE FROM growplans WHERE id=?", (plan_id,))
        await self.conn.commit()

    async def list_growlog(self, plan_id: str) -> list[dict[str, Any]]:
        """Watering log of one plan, newest first (by date, then time of entry)."""
        async with self.conn.execute(
            "SELECT data FROM growlog WHERE plan_id=? ORDER BY date DESC, ts DESC", (plan_id,)
        ) as cur:
            rows = await cur.fetchall()
        entries = []
        for row in rows:
            try:
                entries.append(json.loads(row["data"]))
            except ValueError:
                continue
        return entries

    async def save_growlog(self, plan_id: str, entries: list[dict[str, Any]]) -> None:
        await self.conn.executemany(
            """INSERT INTO growlog(plan_id, id, date, ts, type, data) VALUES(?, ?, ?, ?, ?, ?)
               ON CONFLICT(plan_id, id) DO UPDATE SET date=excluded.date, ts=excluded.ts,
               type=excluded.type, data=excluded.data""",
            [(plan_id, e["id"], e["date"], int(e.get("ts") or 0), e["type"], json.dumps(e)) for e in entries],
        )
        await self.conn.commit()

    async def growlog_ids(self, plan_id: str) -> set[str]:
        async with self.conn.execute("SELECT id FROM growlog WHERE plan_id=?", (plan_id,)) as cur:
            return {row["id"] for row in await cur.fetchall()}

    async def delete_growlog(self, plan_id: str, entry_id: str | None = None) -> int:
        """Delete one entry, or the whole log of a plan without an entry id."""
        if entry_id is None:
            cur = await self.conn.execute("DELETE FROM growlog WHERE plan_id=?", (plan_id,))
        else:
            cur = await self.conn.execute("DELETE FROM growlog WHERE plan_id=? AND id=?", (plan_id, entry_id))
        await self.conn.commit()
        return cur.rowcount or 0

    async def growlog_meta(self, plan_id: str) -> tuple[int, dict[str, Any] | None]:
        """Number of entries and the latest watering (any entry that is not only a note)."""
        async with self.conn.execute("SELECT COUNT(*) FROM growlog WHERE plan_id=?", (plan_id,)) as cur:
            row = await cur.fetchone()
        count = int(row[0]) if row else 0
        async with self.conn.execute(
            "SELECT data FROM growlog WHERE plan_id=? AND type != 'note' ORDER BY date DESC, ts DESC LIMIT 1",
            (plan_id,),
        ) as cur:
            row = await cur.fetchone()
        last = None
        if row is not None:
            try:
                last = json.loads(row["data"])
            except ValueError:
                last = None
        return count, last

    # ------------------------------------------------------------------ events
    async def add_event(self, level: str, category: str, message: str,
                        device_id: str | None = None, data: dict[str, Any] | None = None) -> dict[str, Any]:
        ts = int(time.time())
        cur = await self.conn.execute(
            "INSERT INTO events(ts, level, category, message, device_id, data) VALUES(?, ?, ?, ?, ?, ?)",
            (ts, level, category, message, device_id, json.dumps(data or {})),
        )
        await self.conn.commit()
        return {"id": cur.lastrowid, "ts": ts, "level": level, "category": category,
                "message": message, "device_id": device_id, "data": data or {}, "acknowledged": 0}

    async def list_events(self, limit: int = 200, category: str | None = None) -> list[dict[str, Any]]:
        sql = "SELECT * FROM events"
        params: list[Any] = []
        if category:
            sql += " WHERE category=?"
            params.append(category)
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(limit)
        async with self.conn.execute(sql, params) as cur:
            rows = await cur.fetchall()
        items = []
        for row in rows:
            item = dict(row)
            try:
                item["data"] = json.loads(item.get("data") or "{}")
            except ValueError:
                item["data"] = {}
            items.append(item)
        return items

    async def acknowledge_events(self, ids: list[int] | None = None) -> None:
        if ids:
            marks = ",".join("?" for _ in ids)
            await self.conn.execute(f"UPDATE events SET acknowledged=1 WHERE id IN ({marks})", ids)
        else:
            await self.conn.execute("UPDATE events SET acknowledged=1 WHERE acknowledged=0")
        await self.conn.commit()

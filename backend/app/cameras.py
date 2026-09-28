"""Cameras: daily photos of the tent, a gallery, time-lapse videos and photos for log entries.

A camera is a Vivosun GrowCam (RTSP in the home network with the login from the Vivosun
account) or any camera with an RTSP stream or a still-image address (http/https).
GrowDeck takes photos at set times, only while the light is on if wanted, stores them in
`<data>/photos/<camera>/<date>/` with a small preview, and builds time-lapse videos from
one photo per day. ffmpeg does the work; the image ships it via imageio-ffmpeg.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import secrets
import shutil
import time
import unicodedata
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit, urlunsplit
from zoneinfo import ZoneInfo

from .hub import Hub
from .tent import is_day, list_tents

_LOGGER = logging.getLogger(__name__)

HHMM = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
CAMERA_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
PHOTO_ID = re.compile(r"^([a-z0-9][a-z0-9-]{0,39})/(\d{4}-\d{2}-\d{2})/(\d{6}(?:-\d{1,2})?)$")
IPV4_OR_HOST = re.compile(r"^[A-Za-z0-9.-]{1,120}$")
SNAPSHOT_TIMEOUT = 40
CATCH_UP = 2 * 3600          # a missed photo time is made up for within two hours
ERROR_EVENT_GAP = 6 * 3600
MAX_CAMERAS = 12
PROTOCOLS = {"rtsp": "rtsp,rtp,udp,tcp,tls,crypto", "rtsps": "rtsp,rtp,udp,tcp,tls,crypto",
             "http": "http,https,tcp,tls,crypto,httpproxy", "https": "http,https,tcp,tls,crypto,httpproxy"}


class CameraError(Exception):
    """Shown to the user."""


def ffmpeg_path() -> str | None:
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg  # type: ignore[import-not-found]

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001 - not installed or no binary for this platform
        return None


def slug(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text[:30] or "kamera"


def mask_url(url: str) -> str:
    """Hides the password of an address for display."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return ""
    if parts.password is None:
        return url
    netloc = f"{parts.username or ''}:***@{parts.hostname or ''}{f':{parts.port}' if parts.port else ''}"
    return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))


def _clean_times(raw: Any) -> list[str]:
    times = sorted({t for t in (raw if isinstance(raw, list) else []) if isinstance(t, str) and HHMM.match(t)})
    return times[:6] or ["12:00"]


class CameraService:
    def __init__(self, hub: Hub, data_dir: Path, tz: str, *, demo: bool = False) -> None:
        self.hub = hub
        self.dir = data_dir / "photos"
        self.tz = ZoneInfo(tz)
        self.demo = demo
        self.cameras: list[dict[str, Any]] = []
        self.state: dict[str, dict[str, Any]] = {}
        self.errors: dict[str, dict[str, Any]] = {}
        self.jobs: dict[str, dict[str, Any]] = {}
        self.room_control: Any = None  # set by the app context
        self._busy: dict[str, asyncio.Lock] = {}
        self._task: asyncio.Task[None] | None = None
        self.ffmpeg = ffmpeg_path()

    async def start(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        stored = await self.hub.db.get_setting("cameras", []) or []
        self.cameras = [c for c in stored if isinstance(c, dict) and CAMERA_ID.match(str(c.get("id", "")))]
        self.state = await self.hub.db.get_setting("camera_state", {}) or {}
        if not self.ffmpeg:
            _LOGGER.warning("ffmpeg fehlt: Kamerafotos sind nicht möglich")
        self._task = asyncio.create_task(self._loop(), name="cameras")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)

    # ------------------------------------------------------------ config
    def get(self, camera_id: str) -> dict[str, Any]:
        camera = next((c for c in self.cameras if c["id"] == camera_id), None)
        if camera is None:
            raise CameraError("Diese Kamera gibt es nicht.")
        return camera

    def public(self, camera: dict[str, Any], counts: dict[str, dict[str, Any]]) -> dict[str, Any]:
        info = counts.get(camera["id"], {})
        result = {k: v for k, v in camera.items() if k != "url"}
        result.update({
            "url_masked": mask_url(camera.get("url") or ""),
            "photos": info.get("count", 0), "last_photo_ts": info.get("last"), "bytes": info.get("bytes", 0),
            "last_error": (self.errors.get(camera["id"]) or {}).get("text"),
            "job": self.job_status(camera["id"]),
        })
        if camera.get("source") == "growcam":
            device = self.hub.devices.get(camera.get("device_id") or "")
            result["device_name"] = device.name if device else None
        return result

    async def listing(self) -> dict[str, Any]:
        counts = await self.hub.db.photo_counts()
        configured = {c.get("device_id") for c in self.cameras if c.get("source") == "growcam"}
        growcams = [
            {"device_id": d.id, "name": d.name, "room_id": d.info.get("room_id"),
             "has_login": bool((d.info.get("camera") or {}).get("username"))}
            for d in self.hub.devices.values()
            if d.kind == "camera" and d.vendor == "vivosun" and d.id not in configured
        ]
        return {"cameras": [self.public(c, counts) for c in self.cameras], "growcams": growcams,
                "ffmpeg": bool(self.ffmpeg), "demo": self.demo}

    def _clean(self, raw: dict[str, Any], current: dict[str, Any] | None) -> dict[str, Any]:
        base = dict(current or {})
        name = str(raw.get("name", base.get("name", "")) or "").strip()[:60]
        if not name:
            raise CameraError("Bitte einen Namen für die Kamera eingeben.")
        source = raw.get("source", base.get("source", "url"))
        if source not in ("growcam", "url", "demo") or (source == "demo" and not self.demo):
            raise CameraError("Unbekannte Kameraart.")
        camera = {
            "id": base.get("id"), "name": name, "source": source,
            "room_id": (raw.get("room_id", base.get("room_id")) or None),
            "times": _clean_times(raw.get("times", base.get("times"))),
            "only_light": raw.get("only_light", base.get("only_light", True)) is not False,
            "enabled": raw.get("enabled", base.get("enabled", True)) is not False,
            "keep_days": max(0, min(3650, int(raw.get("keep_days", base.get("keep_days", 0)) or 0))),
        }
        if source == "growcam":
            device_id = str(raw.get("device_id", base.get("device_id", "")) or "")
            device = self.hub.devices.get(device_id)
            if device is None or device.kind != "camera":
                raise CameraError("Diese GrowCam ist im Vivosun-Konto nicht zu finden.")
            ip = str(raw.get("ip", base.get("ip", "")) or "").strip()
            if not ip or not IPV4_OR_HOST.match(ip):
                raise CameraError("Bitte die IP-Adresse der GrowCam im Heimnetz eintragen (steht im Router).")
            camera.update({"device_id": device_id, "ip": ip})
        elif source == "url":
            url = raw.get("url")
            if url in (None, "") or (current and url == mask_url(current.get("url") or "")):
                url = base.get("url")
            url = str(url or "").strip()
            scheme = urlsplit(url).scheme.lower() if url else ""
            if scheme not in PROTOCOLS or not urlsplit(url).hostname:
                raise CameraError("Die Adresse muss mit rtsp://, http:// oder https:// beginnen.")
            if len(url) > 500:
                raise CameraError("Die Adresse ist zu lang.")
            camera["url"] = url
        return camera

    async def _save_all(self) -> None:
        await self.hub.db.set_setting("cameras", self.cameras)
        self.hub.bus.publish("cameras", {"changed": True})

    async def create(self, raw: dict[str, Any]) -> dict[str, Any]:
        if len(self.cameras) >= MAX_CAMERAS:
            raise CameraError(f"Höchstens {MAX_CAMERAS} Kameras.")
        camera = self._clean(raw, None)
        base = slug(camera["name"])
        camera_id, n = base, 2
        taken = {c["id"] for c in self.cameras}
        while camera_id in taken:
            camera_id = f"{base}-{n}"
            n += 1
        camera["id"] = camera_id
        self.cameras.append(camera)
        await self._save_all()
        return camera

    async def update(self, camera_id: str, raw: dict[str, Any]) -> dict[str, Any]:
        current = self.get(camera_id)
        camera = self._clean(raw, current)
        camera["id"] = camera_id
        self.cameras = [camera if c["id"] == camera_id else c for c in self.cameras]
        self.errors.pop(camera_id, None)
        await self._save_all()
        return camera

    async def delete(self, camera_id: str, photos: bool) -> None:
        self.get(camera_id)
        self.cameras = [c for c in self.cameras if c["id"] != camera_id]
        self.state.pop(camera_id, None)
        await self._save_all()
        if photos:
            for photo in await self.hub.db.list_photos(camera_id=camera_id, limit=1_000_000):
                await self.hub.db.delete_photo(photo["id"])
            shutil.rmtree(self.dir / camera_id, ignore_errors=True)

    # ------------------------------------------------------------ snapshots
    def _input(self, camera: dict[str, Any]) -> list[str]:
        source = camera.get("source")
        if source == "demo":
            seed = secrets.randbelow(2 ** 31)
            graph = (f"life=s=320x180:mold=10:r=1:ratio=0.12:seed={seed}:death_color=#1d3b24:"
                     f"life_color=#7bc96f:mold_color=#2f7d4f,scale=1280:720:flags=neighbor")
            return ["-f", "lavfi", "-i", graph]
        if source == "growcam":
            device = self.hub.devices.get(camera.get("device_id") or "")
            login = (device.info.get("camera") if device else None) or {}
            user = quote(login.get("username") or "admin", safe="")
            password = quote(login.get("password") or "", safe="")
            url = f"rtsp://{user}:{password}@{camera['ip']}:554/"
        else:
            url = camera.get("url") or ""
        scheme = urlsplit(url).scheme.lower()
        if scheme not in PROTOCOLS:
            raise CameraError("Die Kamera hat keine gültige Adresse.")
        opts = ["-protocol_whitelist", PROTOCOLS[scheme], "-timeout", "15000000"]
        if scheme.startswith("rtsp"):
            opts += ["-rtsp_transport", "tcp"]
        return opts + ["-i", url]

    async def snapshot(self, camera_id: str, *, source: str = "manual", now: float | None = None) -> dict[str, Any]:
        camera = self.get(camera_id)
        if not self.ffmpeg:
            raise CameraError("ffmpeg fehlt im Container, deshalb sind keine Fotos möglich.")
        lock = self._busy.setdefault(camera_id, asyncio.Lock())
        async with lock:
            now = time.time() if now is None else now
            local = datetime.fromtimestamp(now, self.tz)
            day = local.strftime("%Y-%m-%d")
            folder = self.dir / camera_id / day
            folder.mkdir(parents=True, exist_ok=True)
            stem, n = local.strftime("%H%M%S"), 2
            while (folder / f"{stem}.jpg").exists():
                stem = f"{local.strftime('%H%M%S')}-{n}"
                n += 1
            full, thumb = folder / f"{stem}.jpg", folder / f"{stem}.t.jpg"
            args = [self.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *self._input(camera),
                    "-map", "0:v:0", "-frames:v", "1", "-vf", "scale=w='min(1920,iw)':h=-2", "-q:v", "3", str(full),
                    "-map", "0:v:0", "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "5", str(thumb)]
            try:
                await self._run(args, SNAPSHOT_TIMEOUT)
                if not full.exists() or full.stat().st_size == 0:
                    raise CameraError("Die Kamera hat kein Bild geliefert.")
            except CameraError as err:
                full.unlink(missing_ok=True)
                thumb.unlink(missing_ok=True)
                await self._failed(camera, str(err))
                raise
            self.errors.pop(camera_id, None)
            photo = {"id": f"{camera_id}/{day}/{stem}", "camera_id": camera_id, "room_id": camera.get("room_id"),
                     "ts": int(now), "file": str(full.relative_to(self.dir)), "thumb": str(thumb.relative_to(self.dir)),
                     "size": full.stat().st_size + (thumb.stat().st_size if thumb.exists() else 0), "source": source}
            await self.hub.db.add_photo(photo)
            self.hub.bus.publish("photo", {"camera_id": camera_id, "id": photo["id"], "ts": photo["ts"],
                                           "room_id": photo["room_id"]})
            return photo

    async def _run(self, args: list[str], timeout: float) -> None:
        proc = await asyncio.create_subprocess_exec(*args, stdin=asyncio.subprocess.DEVNULL,
                                                    stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        try:
            _out, err = await asyncio.wait_for(proc.communicate(), timeout)
        except asyncio.TimeoutError as exc:
            proc.kill()
            await proc.wait()
            raise CameraError("Die Kamera antwortet nicht (Zeitüberschreitung).") from exc
        if proc.returncode != 0:
            text = (err or b"").decode(errors="replace").strip().splitlines()
            raise CameraError(self._explain(text[-1] if text else f"ffmpeg Fehler {proc.returncode}"))

    @staticmethod
    def _explain(line: str) -> str:
        lower = line.lower()
        if "401" in lower or "unauthorized" in lower:
            return "Die Kamera lehnt die Anmeldung ab (Benutzer oder Passwort falsch)."
        if "connection refused" in lower:
            return "Die Kamera nimmt keine Verbindung an (IP-Adresse oder Port falsch?)."
        if "no route to host" in lower or "network is unreachable" in lower or "timed out" in lower:
            return "Die Kamera ist im Netz nicht erreichbar."
        if "404" in lower or "not found" in lower:
            return "Unter dieser Adresse liefert die Kamera kein Bild."
        line = re.sub(r"[a-z]+://[^\s]*", "<Adresse>", line)
        return f"Kein Foto möglich: {line[:200]}"

    async def _failed(self, camera: dict[str, Any], text: str) -> None:
        now = time.time()
        info = self.errors.setdefault(camera["id"], {"text": text, "event": 0.0})
        info["text"] = text
        if now - info["event"] > ERROR_EVENT_GAP:
            info["event"] = now
            await self.hub.add_event("warning", "camera", f"Kamera {camera['name']}: {text}")

    # --------------------------------------------------------------- photos
    def photo_path(self, photo: dict[str, Any], thumb: bool = False) -> Path:
        path = (self.dir / (photo["thumb"] if thumb else photo["file"])).resolve()
        if self.dir.resolve() not in path.parents or not path.is_file():
            raise CameraError("Das Foto gibt es nicht mehr.")
        return path

    async def delete_photo(self, photo_id: str) -> None:
        photo = await self.hub.db.get_photo(photo_id)
        if photo is None:
            raise CameraError("Das Foto gibt es nicht mehr.")
        for key in ("file", "thumb"):
            (self.dir / photo[key]).unlink(missing_ok=True)
        await self.hub.db.delete_photo(photo_id)

    async def _referenced(self) -> set[str]:
        """Photos attached to Growplan log entries or to archived grows are never cleaned up."""
        used: set[str] = set()
        async with self.hub.db.conn.execute("SELECT data FROM growlog WHERE data LIKE '%\"photo\"%'") as cur:
            for row in await cur.fetchall():
                photo = json.loads(row["data"]).get("photo")
                if photo:
                    used.add(photo)
        for grow in await self.hub.db.list_grows():
            used.update(grow.get("photos_pinned") or [])
            used.update(e.get("photo") for e in grow.get("log") or [] if e.get("photo"))
        return used

    async def cleanup(self, now: float | None = None) -> int:
        now = time.time() if now is None else now
        removed = 0
        used: set[str] | None = None
        for camera in self.cameras:
            days = camera.get("keep_days") or 0
            if not days:
                continue
            used = used if used is not None else await self._referenced()
            old = await self.hub.db.list_photos(camera_id=camera["id"], end=int(now - days * 86400), limit=100_000)
            for photo in old:
                if photo["id"] in used:
                    continue
                await self.delete_photo(photo["id"])
                removed += 1
        return removed

    # ------------------------------------------------------------ time-lapse
    def job_status(self, camera_id: str) -> dict[str, Any] | None:
        job = self.jobs.get(camera_id)
        if job is None:
            folder = self.dir / camera_id / "timelapse"
            videos = sorted(folder.glob("*.mp4"), key=lambda p: p.stat().st_mtime, reverse=True) if folder.exists() else []
            if not videos:
                return None
            return {"running": False, "file": videos[0].name, "size": videos[0].stat().st_size,
                    "created": int(videos[0].stat().st_mtime), "error": None}
        return {k: v for k, v in job.items() if k != "task"}

    def video_path(self, camera_id: str, name: str) -> Path:
        self.get(camera_id)
        if not re.match(r"^[\w.-]+\.mp4$", name or ""):
            raise CameraError("Unbekanntes Video.")
        path = self.dir / camera_id / "timelapse" / name
        if not path.is_file():
            raise CameraError("Das Video gibt es nicht mehr.")
        return path

    async def start_timelapse(self, camera_id: str, start: str, end: str, fps: int, per_day: bool) -> dict[str, Any]:
        camera = self.get(camera_id)
        if not self.ffmpeg:
            raise CameraError("ffmpeg fehlt im Container.")
        if self.jobs.get(camera_id, {}).get("running"):
            raise CameraError("Für diese Kamera läuft schon ein Zeitraffer.")
        try:
            first = datetime.fromisoformat(start).replace(tzinfo=self.tz)
            last = datetime.fromisoformat(end).replace(tzinfo=self.tz) + timedelta(days=1)
        except ValueError as err:
            raise CameraError("Bitte Anfang und Ende als Datum angeben.") from err
        if last <= first:
            raise CameraError("Das Ende liegt vor dem Anfang.")
        fps = max(2, min(30, int(fps)))
        photos = sorted(await self.hub.db.list_photos(camera_id=camera_id, start=int(first.timestamp()),
                                                      end=int(last.timestamp()) - 1, limit=20000),
                        key=lambda p: p["ts"])
        if per_day:
            target = camera.get("times", ["12:00"])[0]
            picked: dict[str, dict[str, Any]] = {}
            for photo in photos:
                local = datetime.fromtimestamp(photo["ts"], self.tz)
                goal = local.replace(hour=int(target[:2]), minute=int(target[3:]), second=0)
                day = local.date().isoformat()
                best = picked.get(day)
                if best is None or abs((local - goal).total_seconds()) < best["_off"]:
                    picked[day] = {**photo, "_off": abs((local - goal).total_seconds())}
            photos = [picked[d] for d in sorted(picked)]
        if len(photos) < 2:
            raise CameraError("Für einen Zeitraffer braucht es mindestens zwei Fotos in diesem Zeitraum.")
        name = f"zeitraffer-{start}-bis-{end}-{fps}fps.mp4"
        job = {"running": True, "frames": len(photos), "file": None, "error": None, "started": int(time.time()),
               "name": name}
        self.jobs[camera_id] = job
        job["task"] = asyncio.create_task(self._render(camera_id, photos, fps, name, job))
        return {k: v for k, v in job.items() if k != "task"}

    async def _render(self, camera_id: str, photos: list[dict[str, Any]], fps: int, name: str,
                      job: dict[str, Any]) -> None:
        folder = self.dir / camera_id / "timelapse"
        folder.mkdir(parents=True, exist_ok=True)
        listing = folder / f".{name}.txt"
        tmp = folder / f".{name}"
        try:
            lines = []
            for photo in photos:
                path = (self.dir / photo["file"]).resolve()
                if path.is_file():
                    lines += [f"file '{path.as_posix()}'", f"duration {1 / fps:.4f}"]
            if len(lines) < 4:
                raise CameraError("Die Fotodateien fehlen.")
            lines.append(lines[-2])  # the concat demuxer needs the last picture twice
            listing.write_text("\n".join(lines) + "\n")
            graph = ("scale=1280:720:force_original_aspect_ratio=decrease,"
                     "pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p")
            args = [self.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0",
                    "-i", str(listing), "-vf", graph, "-r", str(fps), "-c:v", "libx264", "-preset", "veryfast",
                    "-crf", "23", "-movflags", "+faststart", "-f", "mp4", str(tmp)]
            await self._run(args, 30 * 60)
            os.replace(tmp, folder / name)
            job.update(running=False, file=name, size=(folder / name).stat().st_size, created=int(time.time()))
            for old in sorted(folder.glob("*.mp4"), key=lambda p: p.stat().st_mtime, reverse=True)[5:]:
                old.unlink(missing_ok=True)
        except Exception as err:  # noqa: BLE001
            job.update(running=False, error=str(err) if isinstance(err, CameraError) else f"Fehler: {err}")
        finally:
            listing.unlink(missing_ok=True)
            tmp.unlink(missing_ok=True)
            self.hub.bus.publish("cameras", {"changed": True})

    # ------------------------------------------------------------ schedule
    async def _loop(self) -> None:
        await asyncio.sleep(15)
        last_cleanup = ""
        while True:
            try:
                await self.tick()
                today = datetime.now(self.tz).date().isoformat()
                if today != last_cleanup and datetime.now(self.tz).hour >= 4:
                    last_cleanup = today
                    await self.cleanup()
            except Exception:  # noqa: BLE001
                _LOGGER.exception("Kameras: Zeitplan fehlgeschlagen")
            await asyncio.sleep(20)

    async def tick(self, now: float | None = None) -> list[str]:
        """Takes the photos that are due. Returns the ids of the photos taken."""
        now = time.time() if now is None else now
        local = datetime.fromtimestamp(now, self.tz)
        taken: list[str] = []
        tents: dict[str, dict[str, Any]] | None = None
        changed = False
        for camera in list(self.cameras):
            if not camera.get("enabled", True) or (camera.get("source") != "demo" and not self.ffmpeg):
                continue
            done = self.state.setdefault(camera["id"], {})
            for slot in camera.get("times") or []:
                hour, minute = int(slot[:2]), int(slot[3:])
                due = local.replace(hour=hour, minute=minute, second=0, microsecond=0)
                key = f"{due.date().isoformat()} {slot}"
                if local < due or (local - due).total_seconds() > CATCH_UP or done.get(slot) == key:
                    continue
                done[slot] = key
                changed = True
                if camera.get("only_light", True):
                    if tents is None:
                        tents = {t["id"]: t for t in await list_tents(self.hub.db, self.hub)}
                    room = tents.get(camera.get("room_id") or "")
                    if room is not None:
                        cfg = self.room_control.config(room["id"]) if self.room_control is not None else {}
                        day, _ = is_day(self.hub, room, cfg, local)
                        if not day:
                            continue
                try:
                    photo = await self.snapshot(camera["id"], source="auto", now=now)
                    taken.append(photo["id"])
                except CameraError:
                    pass
        if changed:
            await self.hub.db.set_setting("camera_state", self.state)
        return taken

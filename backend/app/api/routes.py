"""REST API. All endpoints except login require a valid session cookie."""

from __future__ import annotations

import asyncio
import json
import os
import platform
import re
import time
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ..auth import COOKIE_NAME, SESSION_DAYS
from ..climate import climate_history as build_climate_history
from ..context import VERSION, AppContext
from ..growplan import GrowPlanError, file_slug, log_csv
from ..backup import BackupError
from ..cameras import CameraError
from ..hub import CommandError
from ..i18n import server_language
from ..notify import GROUPS as NOTIFY_GROUPS
from ..notify import NotifyError, telegram_call, telegram_find_chats
from ..roomcontrol import ROLES, TYPE_ROLES

router = APIRouter(prefix="/api")


def ctx_of(request: Request) -> AppContext:
    return request.app.state.ctx


def authed(request: Request) -> AppContext:
    ctx = ctx_of(request)
    ctx.auth.require(request)
    return ctx


def _bad(err: Exception) -> HTTPException:
    return HTTPException(status.HTTP_400_BAD_REQUEST, str(err))


TIME_RE = re.compile(r"^([01]?\d|2[0-3]):[0-5]\d$")


def _check_time(value: str | None, label: str) -> None:
    if value is not None and not TIME_RE.match(value):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{label} bitte als HH:MM angeben.")


# ------------------------------------------------------------------------ auth
class LoginBody(BaseModel):
    password: str = Field(min_length=1, max_length=512)


@router.post("/auth/login")
async def login(body: LoginBody, request: Request, response: Response) -> dict[str, Any]:
    ctx = ctx_of(request)
    client = request.client.host if request.client else "unknown"
    if ctx.auth.locked(client):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS,
                            "Zu viele Fehlversuche. Bitte in 5 Minuten erneut versuchen.")
    if not ctx.auth.check_password(client, body.password):
        await asyncio.sleep(1.0)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Passwort ist falsch.")
    response.set_cookie(COOKIE_NAME, ctx.auth.issue(), max_age=SESSION_DAYS * 86400,
                        httponly=True, samesite="lax", path="/")
    return {"ok": True}


@router.post("/auth/logout")
async def logout(response: Response) -> dict[str, Any]:
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}


@router.get("/auth/me")
async def me(request: Request) -> dict[str, Any]:
    ctx = ctx_of(request)
    return {
        "authenticated": ctx.auth.valid(request.cookies.get(COOKIE_NAME)),
        "password_generated": ctx.settings.password_generated,
        "version": VERSION,
    }


# ----------------------------------------------------------------------- state
@router.get("/state")
async def state(ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    return {
        "devices": [ctx.hub.device_payload(d) for d in ctx.hub.visible_devices()],
        "rooms": await ctx.db.list_rooms(),
        "integrations": await ctx.integrations(),
        "settings": await _settings_payload(ctx),
        "automation": ctx.automation.status(),
        "room_control": ctx.room_control.status_all(),
        "growplans": ctx.growplan.summaries(),
        "watering": ctx.watering.payload(),
        "alarms": ctx.alarms.status(),
        "unread_events": sum(1 for e in await ctx.db.list_events(200) if not e["acknowledged"]
                             and e["level"] in {"warning", "alarm"}),
        "server_time": time.time(),
        "version": VERSION,
    }


# --------------------------------------------------------------------- devices
@router.get("/devices")
async def list_devices(ctx: AppContext = Depends(authed)) -> list[dict[str, Any]]:
    return [ctx.hub.device_payload(d) for d in ctx.hub.visible_devices()]


@router.get("/devices/{device_id}")
async def get_device(device_id: str, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    device = ctx.hub.devices.get(device_id)
    if device is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Gerät nicht gefunden.")
    return ctx.hub.device_payload(device, include_raw=True)


class DevicePatch(BaseModel):
    name: str | None = None
    room_id: str | None = None
    hidden: bool | None = None
    clear_room: bool = False


@router.patch("/devices/{device_id}")
async def patch_device(device_id: str, body: DevicePatch, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    if body.name is not None:
        await ctx.hub.rename_device(device_id, body.name.strip()[:80] or None)
    if body.room_id is not None or body.clear_room:
        await ctx.hub.set_device_room(device_id, None if body.clear_room else body.room_id)
    if body.hidden is not None:
        await ctx.hub.set_device_hidden(device_id, body.hidden)
    device = ctx.hub.devices.get(device_id)
    return ctx.hub.device_payload(device) if device else {"id": device_id}


@router.delete("/devices/{device_id}")
async def forget_device(device_id: str, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    device = ctx.hub.devices.get(device_id)
    if device is not None and device.online:
        raise HTTPException(status.HTTP_409_CONFLICT, "Nur Geräte, die offline sind, können entfernt werden.")
    ctx.hub.remove_device(device_id)
    await ctx.db.delete_device_meta(device_id)
    return {"ok": True}


class ControlCommand(BaseModel):
    on: bool | None = None
    level: float | None = None
    mode: str | None = None
    option: str | None = None
    natural_wind: bool | None = None
    oscillate: bool | None = None
    night_mode: bool | None = None
    spectrum: float | None = None
    target_temp: float | None = None
    target_humi: float | None = None
    fan_level: str | None = None
    close_co2: bool | None = None
    auto: dict[str, float | None] | None = None


@router.post("/devices/{device_id}/controls/{control_id}")
async def command(device_id: str, control_id: str, body: ControlCommand,
                  ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    patch = body.model_dump(exclude_none=True)
    control = None
    try:
        control = await ctx.hub.command(device_id, control_id, patch, source="user")
    except CommandError as err:
        raise _bad(err) from err
    return control.to_dict()


class ControlRename(BaseModel):
    label: str | None = None


@router.patch("/devices/{device_id}/controls/{control_id}")
async def rename_control(device_id: str, control_id: str, body: ControlRename,
                         ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    await ctx.hub.rename_control(device_id, control_id, (body.label or "").strip()[:60] or None)
    return {"ok": True}


@router.post("/devices/{device_id}/native")
async def native(device_id: str, body: dict[str, Any], ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    try:
        return await ctx.hub.native(device_id, body)
    except CommandError as err:
        raise _bad(err) from err


@router.post("/devices/{device_id}/refresh")
async def refresh(device_id: str, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    try:
        await ctx.hub.refresh(device_id)
    except CommandError as err:
        raise _bad(err) from err
    return {"ok": True}


# ----------------------------------------------------------------------- rooms
class RoomBody(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    sort: int = 0
    climate_device_id: str | None = None
    climate_group: str | None = None
    day_start: str = "06:00"
    day_end: str = "00:00"
    stage: str = "veg"


@router.get("/rooms")
async def rooms(ctx: AppContext = Depends(authed)) -> list[dict[str, Any]]:
    return await ctx.db.list_rooms()


@router.post("/rooms")
async def create_room(body: RoomBody, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    _check_time(body.day_start, "Tagbeginn")
    _check_time(body.day_end, "Tagende")
    room = {"id": f"room-{uuid.uuid4().hex[:8]}", **body.model_dump()}
    await ctx.db.save_room(room)
    ctx.bus.publish("rooms", await ctx.db.list_rooms())
    return room


@router.put("/rooms/{room_id}")
async def update_room(room_id: str, body: RoomBody, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    _check_time(body.day_start, "Tagbeginn")
    _check_time(body.day_end, "Tagende")
    room = {"id": room_id, **body.model_dump()}
    await ctx.db.save_room(room)
    ctx.bus.publish("rooms", await ctx.db.list_rooms())
    return room


async def _room_or_404(ctx: AppContext, room_id: str) -> dict[str, Any]:
    room = next((r for r in await ctx.db.list_rooms() if r["id"] == room_id), None)
    if room is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Raum nicht gefunden.")
    return room


@router.get("/rooms/{room_id}/control")
async def get_room_control(room_id: str, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    await _room_or_404(ctx, room_id)
    return {"config": ctx.room_control.config(room_id), "status": ctx.room_control.status_all().get(room_id),
            "roles": ROLES, "type_roles": TYPE_ROLES,
            # this week's targets from the tent's grow plan (None without plan)
            "growplan": ctx.growplan.targets_for_room(room_id)}


@router.put("/rooms/{room_id}/control")
async def put_room_control(room_id: str, body: dict[str, Any], ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    room = await _room_or_404(ctx, room_id)
    try:
        config = await ctx.room_control.save(room_id, body)
    except ValueError as err:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(err)) from err
    await ctx.room_control.evaluate()
    state = "ist aktiv" if config["enabled"] else "ist gespeichert, aber ausgeschaltet"
    await ctx.hub.add_event("info", "automation", f"Zeltsteuerung {room['name']} {state}.")
    return {"config": config, "status": ctx.room_control.status_all().get(room_id)}


class RoomDevicesBody(BaseModel):
    device_ids: list[str] = Field(default_factory=list, max_length=500)


@router.post("/rooms/{room_id}/devices")
async def set_room_devices(room_id: str, body: RoomDevicesBody, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    await _room_or_404(ctx, room_id)
    wanted = set(body.device_ids)
    for device_id, device in list(ctx.hub.devices.items()):
        current = device.info.get("room_id")
        if device_id in wanted and current != room_id:
            await ctx.hub.set_device_room(device_id, room_id)
        elif device_id not in wanted and current == room_id:
            await ctx.hub.set_device_room(device_id, None)
    return {"ok": True, "devices": sorted(wanted)}


@router.delete("/rooms/{room_id}")
async def delete_room(room_id: str, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    await ctx.room_control.delete(room_id)
    await ctx.db.delete_room(room_id)
    await ctx.growplan.room_deleted(room_id)
    ctx.hub.meta = await ctx.db.all_device_meta()
    for device_id in list(ctx.hub.devices):
        ctx.hub._reapply(device_id)  # noqa: SLF001
    ctx.bus.publish("rooms", await ctx.db.list_rooms())
    return {"ok": True}


# -------------------------------------------------------------------- growplan
def _plan_or_404(ctx: AppContext, plan_id: str) -> dict[str, Any]:
    try:
        return ctx.growplan.get(plan_id)
    except KeyError as err:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Growplan nicht gefunden.") from err


@router.get("/growplan")
async def growplan_overview(ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    return {"plans": ctx.growplan.summaries(), "library": ctx.growplan.library,
            "today": ctx.growplan.today().isoformat()}


class GrowPlanCreate(BaseModel):
    room_id: str | None = None
    name: str | None = Field(default=None, max_length=60)
    data: dict[str, Any] | None = None


@router.post("/growplan/plans")
async def create_growplan(body: GrowPlanCreate, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    name = body.name or "Mein Grow"
    if body.room_id:
        name = body.name or (await _room_or_404(ctx, body.room_id))["name"]
    try:
        record = await ctx.growplan.create(body.room_id, name, body.data)
    except GrowPlanError as err:
        raise HTTPException(status.HTTP_409_CONFLICT, str(err)) from err
    return {"plan": ctx.growplan.summary(record), "log": []}


@router.get("/growplan/plans/{plan_id}")
async def get_growplan(plan_id: str, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    record = _plan_or_404(ctx, plan_id)
    return {"plan": ctx.growplan.summary(record), "log": await ctx.growplan.log(plan_id)}


class GrowPlanUpdate(BaseModel):
    data: dict[str, Any] | None = None
    name: str | None = Field(default=None, max_length=60)


@router.put("/growplan/plans/{plan_id}")
async def put_growplan(plan_id: str, body: GrowPlanUpdate, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    _plan_or_404(ctx, plan_id)
    record = await ctx.growplan.update(plan_id, body.data, body.name)
    return {"plan": ctx.growplan.summary(record)}


class GrowPlanRoom(BaseModel):
    room_id: str | None = None


@router.put("/growplan/plans/{plan_id}/room")
async def assign_growplan(plan_id: str, body: GrowPlanRoom, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    _plan_or_404(ctx, plan_id)
    if body.room_id:
        await _room_or_404(ctx, body.room_id)
    try:
        record = await ctx.growplan.assign(plan_id, body.room_id)
    except GrowPlanError as err:
        raise HTTPException(status.HTTP_409_CONFLICT, str(err)) from err
    return {"plan": ctx.growplan.summary(record)}


@router.delete("/growplan/plans/{plan_id}")
async def delete_growplan(plan_id: str, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    _plan_or_404(ctx, plan_id)
    await ctx.growplan.delete(plan_id)
    await ctx.watering.plan_removed(plan_id)
    return {"ok": True}


# watering reminders and recognised waterings of a plan
@router.put("/growplan/plans/{plan_id}/watering")
async def put_watering(plan_id: str, body: dict[str, Any], ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    _plan_or_404(ctx, plan_id)
    return {"settings": await ctx.watering.save_settings(plan_id, body), **ctx.watering.payload()}


@router.delete("/growplan/plans/{plan_id}/suggestions/{suggestion_id}")
async def dismiss_suggestion(plan_id: str, suggestion_id: str, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    _plan_or_404(ctx, plan_id)
    await ctx.watering.dismiss(plan_id, suggestion_id)
    return ctx.watering.payload()


# finish a grow: into the archive, optionally start the plan over
@router.post("/growplan/plans/{plan_id}/archive")
async def archive_growplan(plan_id: str, body: dict[str, Any], ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    _plan_or_404(ctx, plan_id)
    try:
        grow = await ctx.archive.archive_plan(plan_id, body)
    except GrowPlanError as err:
        raise _bad(err) from err
    return {"grow": _grow_brief(grow), "plan": ctx.growplan.summary(ctx.growplan.get(plan_id))}


def _grow_brief(grow: dict[str, Any]) -> dict[str, Any]:
    """A grow without its plan and log (for lists)."""
    return {k: v for k, v in grow.items() if k not in ("plan", "log")}


@router.get("/grows")
async def list_grows(ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    return {"grows": [_grow_brief(g) for g in await ctx.archive.list()]}


@router.get("/grows/{grow_id}")
async def get_grow(grow_id: str, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    try:
        return {"grow": await ctx.archive.get(grow_id)}
    except GrowPlanError as err:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(err)) from err


@router.put("/grows/{grow_id}")
async def put_grow(grow_id: str, body: dict[str, Any], ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    try:
        return {"grow": _grow_brief(await ctx.archive.update(grow_id, body))}
    except GrowPlanError as err:
        raise _bad(err) from err


@router.delete("/grows/{grow_id}")
async def delete_grow(grow_id: str, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    try:
        await ctx.archive.delete(grow_id)
    except GrowPlanError as err:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(err)) from err
    return {"ok": True}


@router.get("/grows/{grow_id}/export", response_model=None)
async def export_grow(grow_id: str, format: str = "json", lang: str = "de",
                      ctx: AppContext = Depends(authed)) -> Response:
    try:
        grow = await ctx.archive.get(grow_id)
    except GrowPlanError as err:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(err)) from err
    stamp = grow.get("harvested") or ctx.growplan.today().isoformat()
    if format == "csv":
        lang = "en" if lang == "en" else "de"
        _name, csv = await ctx.archive.csv(grow_id, lang)
        name = f"{'watering-log' if lang == 'en' else 'giessprotokoll'}-{file_slug(grow['name'])}-{stamp}.csv"
        return Response(csv.encode("utf-8"), media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="{name}"'})
    name = f"grow-{file_slug(grow['name'])}-{stamp}.json"
    return Response(json.dumps(grow, ensure_ascii=False, indent=1), media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.put("/growplan/plans/{plan_id}/log/{entry_id}")
async def put_growlog_entry(plan_id: str, entry_id: str, body: dict[str, Any],
                            ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    _plan_or_404(ctx, plan_id)
    body["id"] = entry_id
    try:
        entry = await ctx.growplan.save_entry(plan_id, body)
    except GrowPlanError as err:
        raise _bad(err) from err
    return {"entry": entry, "plan": ctx.growplan.summary(ctx.growplan.get(plan_id))}


@router.delete("/growplan/plans/{plan_id}/log/{entry_id}")
async def delete_growlog_entry(plan_id: str, entry_id: str, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    _plan_or_404(ctx, plan_id)
    deleted = await ctx.growplan.delete_entry(plan_id, entry_id)
    return {"ok": deleted, "plan": ctx.growplan.summary(ctx.growplan.get(plan_id))}


@router.delete("/growplan/plans/{plan_id}/log")
async def clear_growlog(plan_id: str, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    _plan_or_404(ctx, plan_id)
    deleted = await ctx.growplan.clear_log(plan_id)
    return {"deleted": deleted, "plan": ctx.growplan.summary(ctx.growplan.get(plan_id))}


@router.put("/growplan/library")
async def put_growplan_library(body: dict[str, Any], ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    try:
        return {"library": await ctx.growplan.save_library(body)}
    except GrowPlanError as err:
        raise _bad(err) from err


@router.post("/growplan/plans/{plan_id}/import")
async def import_growplan(plan_id: str, body: dict[str, Any], ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    """Merge a backup of the Growplan app (format 2) into this plan."""
    _plan_or_404(ctx, plan_id)
    try:
        result = await ctx.growplan.import_backup(plan_id, body)
    except GrowPlanError as err:
        raise _bad(err) from err
    record = ctx.growplan.get(plan_id)
    return {"result": result, "plan": ctx.growplan.summary(record), "log": await ctx.growplan.log(plan_id),
            "library": ctx.growplan.library}


async def _plan_file_name(ctx: AppContext, record: dict[str, Any], prefix: str, extension: str) -> str:
    room = next((r for r in await ctx.db.list_rooms() if r["id"] == record.get("room_id")), None)
    name = room["name"] if room else record.get("name") or "growplan"
    return f"{prefix}-{file_slug(name)}-{ctx.growplan.today().isoformat()}.{extension}"


@router.get("/growplan/plans/{plan_id}/export", response_model=None)
async def export_growplan(plan_id: str, download: bool = False,
                          ctx: AppContext = Depends(authed)) -> dict[str, Any] | Response:
    """The plan as a backup the Growplan app can load (format 2); as a file with ?download=1."""
    record = _plan_or_404(ctx, plan_id)
    backup = await ctx.growplan.export_backup(plan_id)
    if not download:
        return backup
    name = await _plan_file_name(ctx, record, "growplan-backup", "json")
    return Response(json.dumps(backup, ensure_ascii=False), media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.get("/growplan/plans/{plan_id}/csv")
async def export_growplan_csv(plan_id: str, lang: str = "de", ctx: AppContext = Depends(authed)) -> Response:
    """The watering log as CSV file (German: semicolons and decimal commas, English: commas and points)."""
    record = _plan_or_404(ctx, plan_id)
    lang = "en" if lang == "en" else "de"
    csv = log_csv(record["data"], await ctx.growplan.log(plan_id), lang)
    name = await _plan_file_name(ctx, record, "watering-log" if lang == "en" else "giessprotokoll", "csv")
    return Response(csv.encode("utf-8"), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


# --------------------------------------------------------------------- history
@router.get("/history")
async def history(device_id: str, metric: str, hours: float = 24, points: int = 360,
                  end: int | None = None, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    end_ts = int(end or time.time())
    hours = max(0.25, min(hours, 24 * 400))
    start_ts = end_ts - int(hours * 3600)
    points = max(20, min(points, 2000))
    bucket = max(ctx.settings.history_interval, int((end_ts - start_ts) / points))
    rows = await ctx.db.query_readings(device_id, metric, start_ts, end_ts, bucket)
    return {
        "device_id": device_id, "metric": metric, "start": start_ts, "end": end_ts, "bucket": bucket,
        "t": [r[0] for r in rows], "avg": [round(r[1], 3) for r in rows],
        "min": [round(r[2], 3) for r in rows], "max": [round(r[3], 3) for r in rows],
    }


@router.get("/history/metrics")
async def history_metrics(ctx: AppContext = Depends(authed)) -> list[dict[str, Any]]:
    return await ctx.db.list_metrics()


@router.get("/climate/history")
async def climate_history(
    hours: float = 24,
    points: int = 240,
    temp: list[str] = Query(default=[]),
    humi: list[str] = Query(default=[]),
    vpd: list[str] = Query(default=[]),
    light: list[str] = Query(default=[]),
    day_start: str = "06:00",
    day_end: str = "00:00",
    ctx: AppContext = Depends(authed),
) -> dict[str, Any]:
    """Temperature, humidity and VPD of one tent plus light-off periods (overview charts).

    Sources are given as "device_id|sensor_key" (several are averaged), lights as
    "device_id|control_id"; day_start/day_end are the tent's light times as fallback.
    """
    try:
        return await build_climate_history(
            ctx.db, tz=ctx.settings.timezone, sample_interval=ctx.settings.history_interval,
            hours=hours, points=points, temp=temp, humi=humi, vpd=vpd, light=light,
            day_start=day_start, day_end=day_end,
        )
    except ValueError as err:
        raise _bad(err) from err


@router.get("/control-log")
async def control_log(device_id: str | None = None, hours: float = 24,
                      ctx: AppContext = Depends(authed)) -> list[dict[str, Any]]:
    end = int(time.time())
    return await ctx.db.query_control_log(device_id, end - int(hours * 3600), end)


# ----------------------------------------------------------------- automation
@router.get("/rules")
async def rules(ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    return {"rules": ctx.automation.rules, "status": ctx.automation.status()}


@router.post("/rules")
async def create_rule(body: dict[str, Any], ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    body.pop("id", None)
    try:
        return await ctx.automation.save_rule(body)
    except CommandError as err:
        raise _bad(err) from err


@router.put("/rules/{rule_id}")
async def update_rule(rule_id: str, body: dict[str, Any], ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    body["id"] = rule_id
    try:
        return await ctx.automation.save_rule(body)
    except CommandError as err:
        raise _bad(err) from err


@router.delete("/rules/{rule_id}")
async def delete_rule(rule_id: str, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    await ctx.automation.delete_rule(rule_id)
    return {"ok": True}


class OrderBody(BaseModel):
    ids: list[str]


@router.post("/rules/order")
async def order_rules(body: OrderBody, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    await ctx.automation.reorder(body.ids)
    return {"ok": True}


class EnabledBody(BaseModel):
    enabled: bool


@router.post("/automation/enabled")
async def automation_enabled(body: EnabledBody, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    await ctx.automation.set_enabled(body.enabled)
    await ctx.hub.add_event("info", "automation",
                            "Automationen eingeschaltet." if body.enabled else "Automationen pausiert.")
    return ctx.automation.status()


# --------------------------------------------------------------------- alarms
@router.get("/alarms")
async def alarms(ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    return {"alarms": ctx.alarms.alarms, "status": ctx.alarms.status()}


@router.post("/alarms")
async def create_alarm(body: dict[str, Any], ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    body.pop("id", None)
    try:
        return await ctx.alarms.save(body)
    except CommandError as err:
        raise _bad(err) from err


@router.put("/alarms/{alarm_id}")
async def update_alarm(alarm_id: str, body: dict[str, Any], ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    body["id"] = alarm_id
    try:
        return await ctx.alarms.save(body)
    except CommandError as err:
        raise _bad(err) from err


@router.delete("/alarms/{alarm_id}")
async def delete_alarm(alarm_id: str, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    await ctx.alarms.delete(alarm_id)
    return {"ok": True}


# --------------------------------------------------------------------- events
@router.get("/events")
async def events(limit: int = 200, category: str | None = None,
                 ctx: AppContext = Depends(authed)) -> list[dict[str, Any]]:
    return await ctx.db.list_events(max(1, min(limit, 1000)), category)


class AckBody(BaseModel):
    ids: list[int] | None = None


@router.post("/events/ack")
async def ack_events(body: AckBody, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    await ctx.db.acknowledge_events(body.ids)
    ctx.bus.publish("events_ack", {"ids": body.ids})
    return {"ok": True}


# ------------------------------------------------------------------- settings
async def _settings_payload(ctx: AppContext) -> dict[str, Any]:
    return {
        "day_start": await ctx.db.get_setting("day_start", "06:00"),
        "day_end": await ctx.db.get_setting("day_end", "00:00"),
        "retention_days": ctx.history.retention_days,
        "history_interval": ctx.settings.history_interval,
        "notify_webhook": await ctx.db.get_setting("notify_webhook", ""),
        "notify_format": await ctx.db.get_setting("notify_format", "json"),
        "notify_groups": await ctx.notifier.groups(),
        "notify_group_labels": NOTIFY_GROUPS,
        "telegram": await ctx.notifier.telegram_status(),
        "vivosun_poll_seconds": await ctx.db.get_setting("vivosun_poll_seconds", 60),
        "acinfinity_poll_seconds": await ctx.db.get_setting("acinfinity_poll_seconds", 10),
        "timezone": ctx.settings.timezone,
        "language": await server_language(ctx.db),
        "demo": ctx.settings.simulate_spiderfarmer or ctx.settings.simulate_vivosun or ctx.settings.simulate_acinfinity,
    }


class SettingsBody(BaseModel):
    day_start: str | None = None
    day_end: str | None = None
    retention_days: int | None = Field(default=None, ge=1, le=3650)
    notify_webhook: str | None = None
    notify_format: str | None = None
    notify_groups: list[str] | None = Field(default=None, max_length=10)
    vivosun_poll_seconds: int | None = Field(default=None, ge=30, le=900)
    acinfinity_poll_seconds: int | None = Field(default=None, ge=5, le=600)
    language: str | None = Field(default=None, pattern="^(de|en)$")


@router.get("/settings")
async def get_settings(ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    return await _settings_payload(ctx)


@router.put("/settings")
async def put_settings(body: SettingsBody, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    _check_time(body.day_start, "Tagbeginn")
    _check_time(body.day_end, "Tagende")
    if body.notify_webhook and not body.notify_webhook.startswith(("http://", "https://")):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Die Adresse muss mit http:// oder https:// beginnen.")
    if body.notify_format is not None and body.notify_format not in {"json", "text"}:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Format muss json oder text sein.")
    if body.notify_groups is not None:
        unknown = [g for g in body.notify_groups if g not in NOTIFY_GROUPS]
        if unknown:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unbekannte Meldungsart: {', '.join(unknown)}")
        body.notify_groups = [g for g in NOTIFY_GROUPS if g in body.notify_groups]
    for key, value in body.model_dump(exclude_none=True).items():
        if key == "notify_groups":
            await ctx.notifier.save_groups(value)
            continue
        await ctx.db.set_setting(key, value)
    if body.retention_days:
        ctx.history.retention_days = body.retention_days
    return await _settings_payload(ctx)


class TestNotificationBody(BaseModel):
    channel: str | None = Field(default=None, pattern="^(webhook|telegram)$")


@router.post("/settings/test-notification")
async def test_notification(body: TestNotificationBody | None = None,
                            ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    results = await ctx.notifier.send_test(body.channel if body else None)
    if not results:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Es ist noch kein Weg eingerichtet: trag eine Adresse ein oder verbinde Telegram.")
    failed = [f"{'Telegram' if k == 'telegram' else 'Adresse'}: {r['detail']}" for k, r in results.items() if not r["ok"]]
    if failed and len(failed) == len(results):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Senden fehlgeschlagen. " + " ".join(failed))
    return {"ok": True, "results": results}


# ----------------------------------------------------------------- telegram
class TelegramChatsBody(BaseModel):
    token: str | None = Field(default=None, max_length=200)


@router.post("/settings/telegram/chats")
async def telegram_chats(body: TelegramChatsBody, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    token = (body.token or "").strip()
    if not token:
        token, _, _ = await ctx.notifier.telegram_target()
    try:
        return await telegram_find_chats(token or "")
    except NotifyError as err:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(err)) from err


class TelegramBody(BaseModel):
    token: str | None = Field(default=None, max_length=200)
    chat_id: str | None = Field(default=None, max_length=40)
    chat_name: str | None = Field(default=None, max_length=200)


@router.put("/settings/telegram")
async def put_telegram(body: TelegramBody, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    token = (body.token or "").strip()
    if token:
        try:
            me = await telegram_call(token, "getMe")
        except NotifyError as err:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(err)) from err
        await ctx.db.set_setting("telegram_token", token)
        await ctx.db.set_setting("telegram_bot", me.get("username") or "")
    if body.chat_id is not None:
        chat_id = body.chat_id.strip()
        if chat_id and not re.fullmatch(r"-?\d{1,20}|@[A-Za-z0-9_]{5,64}", chat_id):
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                "Die Chat-ID ist eine Zahl (Gruppen beginnen mit -) oder @kanalname.")
        await ctx.db.set_setting("telegram_chat_id", chat_id)
        await ctx.db.set_setting("telegram_chat_name", (body.chat_name or "").strip())
    await ctx.hub.add_event("info", "integration", "Telegram-Benachrichtigungen eingerichtet.")
    return await _settings_payload(ctx)


@router.delete("/settings/telegram")
async def delete_telegram(ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    for key in ("telegram_token", "telegram_bot", "telegram_chat_id", "telegram_chat_name"):
        await ctx.db.delete_setting(key)
    await ctx.hub.add_event("info", "integration", "Telegram-Benachrichtigungen entfernt.")
    return await _settings_payload(ctx)


# --------------------------------------------------------------------- backups
@router.get("/backups")
async def list_backups(ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    return await ctx.backup.status()


@router.put("/backups/settings")
async def put_backup_settings(body: dict[str, Any], ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    try:
        await ctx.backup.save_settings(body)
    except BackupError as err:
        raise _bad(err) from err
    return await ctx.backup.status()


@router.post("/backups")
async def create_backup(ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    try:
        item = await ctx.backup.create("manuell")
    except BackupError as err:
        raise _bad(err) from err
    return {"item": item, **await ctx.backup.status()}


@router.post("/backups/upload")
async def upload_backup(request: Request, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    try:
        item = await ctx.backup.store_upload(request.stream())
    except BackupError as err:
        raise _bad(err) from err
    return {"item": item, **await ctx.backup.status()}


@router.get("/backups/{name}", response_model=None)
async def download_backup(name: str, ctx: AppContext = Depends(authed)) -> FileResponse:
    try:
        path = ctx.backup.path_of(name)
    except BackupError as err:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(err)) from err
    return FileResponse(path, media_type="application/gzip", filename=name)


@router.delete("/backups/{name}")
async def delete_backup(name: str, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    try:
        await ctx.backup.delete(name)
    except BackupError as err:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(err)) from err
    return await ctx.backup.status()


@router.post("/backups/{name}/restore")
async def restore_backup(name: str, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    try:
        result = await ctx.backup.prepare_restore(name)
    except BackupError as err:
        raise _bad(err) from err
    ctx.backup.restart_soon()
    return {"ok": True, "restarting": True, **result}


# --------------------------------------------------------------------- cameras
def _camera_error(err: CameraError) -> HTTPException:
    return HTTPException(status.HTTP_400_BAD_REQUEST, str(err))


@router.get("/cameras")
async def list_cameras(ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    return await ctx.cameras.listing()


@router.post("/cameras")
async def create_camera(body: dict[str, Any], ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    try:
        camera = await ctx.cameras.create(body)
    except CameraError as err:
        raise _camera_error(err) from err
    return {"camera": camera["id"], **await ctx.cameras.listing()}


@router.put("/cameras/{camera_id}")
async def update_camera(camera_id: str, body: dict[str, Any], ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    try:
        await ctx.cameras.update(camera_id, body)
    except CameraError as err:
        raise _camera_error(err) from err
    return await ctx.cameras.listing()


@router.delete("/cameras/{camera_id}")
async def delete_camera(camera_id: str, photos: bool = False, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    try:
        await ctx.cameras.delete(camera_id, photos)
    except CameraError as err:
        raise _camera_error(err) from err
    return await ctx.cameras.listing()


@router.post("/cameras/{camera_id}/snapshot")
async def camera_snapshot(camera_id: str, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    try:
        return {"photo": await ctx.cameras.snapshot(camera_id)}
    except CameraError as err:
        raise _camera_error(err) from err


class TimelapseBody(BaseModel):
    start: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    end: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    fps: int = Field(default=8, ge=2, le=30)
    per_day: bool = True


@router.post("/cameras/{camera_id}/timelapse")
async def start_timelapse(camera_id: str, body: TimelapseBody, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    try:
        return await ctx.cameras.start_timelapse(camera_id, body.start, body.end, body.fps, body.per_day)
    except CameraError as err:
        raise _camera_error(err) from err


@router.get("/cameras/{camera_id}/timelapse")
async def timelapse_status(camera_id: str, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    try:
        ctx.cameras.get(camera_id)
    except CameraError as err:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(err)) from err
    return {"job": ctx.cameras.job_status(camera_id)}


@router.get("/cameras/{camera_id}/videos/{name}", response_model=None)
async def timelapse_video(camera_id: str, name: str, download: bool = False,
                          ctx: AppContext = Depends(authed)) -> FileResponse:
    try:
        path = ctx.cameras.video_path(camera_id, name)
    except CameraError as err:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(err)) from err
    return FileResponse(path, media_type="video/mp4", filename=name,
                        content_disposition_type="attachment" if download else "inline")


@router.get("/photos")
async def list_photos(camera_id: str | None = None, room_id: str | None = None, start: int | None = None,
                      end: int | None = None, before: int | None = None, limit: int = 60,
                      ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    photos = await ctx.db.list_photos(camera_id=camera_id, room_id=room_id, start=start, end=end, before=before,
                                      limit=max(1, min(limit, 500)))
    return {"photos": [{k: p[k] for k in ("id", "camera_id", "room_id", "ts", "size", "source")} for p in photos]}


@router.get("/photos/file/{photo_id:path}", response_model=None)
async def photo_file(photo_id: str, thumb: bool = False, ctx: AppContext = Depends(authed)) -> FileResponse:
    photo = await ctx.db.get_photo(photo_id)
    try:
        if photo is None:
            raise CameraError("Das Foto gibt es nicht mehr.")
        path = ctx.cameras.photo_path(photo, thumb)
    except CameraError as err:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(err)) from err
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})


@router.delete("/photos/{photo_id:path}")
async def delete_photo(photo_id: str, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    try:
        await ctx.cameras.delete_photo(photo_id)
    except CameraError as err:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(err)) from err
    return {"ok": True}


# --------------------------------------------------------------- integrations
@router.get("/integrations")
async def integrations(ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    return await ctx.integrations()


class VivosunBody(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    password: str = Field(min_length=1, max_length=200)


@router.put("/integrations/vivosun")
async def set_vivosun(body: VivosunBody, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    if ctx.settings.simulate_vivosun:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "Im Demo-Modus ist Vivosun simuliert. SIMULATE_VIVOSUN=false setzen, um dein Konto zu verbinden.")
    await ctx.db.set_setting("vivosun_email", body.email.strip())
    await ctx.db.set_setting("vivosun_password", body.password)
    await ctx.reconfigure_vivosun()
    await ctx.hub.add_event("info", "integration", "Vivosun-Konto verbunden, Geräte werden geladen.")
    return await ctx.integrations()


@router.delete("/integrations/vivosun")
async def remove_vivosun(ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    await ctx.db.delete_setting("vivosun_email")
    await ctx.db.delete_setting("vivosun_password")
    await ctx.reconfigure_vivosun()
    return await ctx.integrations()


@router.post("/integrations/vivosun/reconnect")
async def reconnect_vivosun(ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    await ctx.reconfigure_vivosun()
    return await ctx.integrations()


@router.put("/integrations/acinfinity")
async def set_acinfinity(body: VivosunBody, ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    if ctx.settings.simulate_acinfinity:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "Im Demo-Modus ist AC Infinity simuliert. SIMULATE_ACINFINITY=false setzen, um dein Konto zu verbinden.")
    await ctx.db.set_setting("acinfinity_email", body.email.strip())
    await ctx.db.set_setting("acinfinity_password", body.password)
    await ctx.reconfigure_acinfinity()
    await ctx.hub.add_event("info", "integration", "AC-Infinity-Konto verbunden, Controller werden geladen.")
    return await ctx.integrations()


@router.delete("/integrations/acinfinity")
async def remove_acinfinity(ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    await ctx.db.delete_setting("acinfinity_email")
    await ctx.db.delete_setting("acinfinity_password")
    await ctx.reconfigure_acinfinity()
    return await ctx.integrations()


@router.post("/integrations/acinfinity/reconnect")
async def reconnect_acinfinity(ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    await ctx.reconfigure_acinfinity()
    return await ctx.integrations()


# --------------------------------------------------------------------- system
@router.get("/system")
async def system(ctx: AppContext = Depends(authed)) -> dict[str, Any]:
    try:
        db_size = os.path.getsize(ctx.settings.db_path)
    except OSError:
        db_size = None
    return {
        "version": VERSION,
        "uptime": time.time() - ctx.started_at,
        "python": platform.python_version(),
        "db_size": db_size,
        "samples_written": ctx.history.samples_written,
        "websocket_clients": ctx.bus.subscriber_count,
        "mqtt": f"{ctx.settings.mqtt_host}:{ctx.settings.mqtt_port}",
        "timezone": ctx.settings.timezone,
        "language": await server_language(ctx.db),
        "demo": {"spiderfarmer": ctx.settings.simulate_spiderfarmer, "vivosun": ctx.settings.simulate_vivosun,
                 "acinfinity": ctx.settings.simulate_acinfinity},
    }

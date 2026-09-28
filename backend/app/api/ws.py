"""Live updates for the UI over a single websocket."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

_LOGGER = logging.getLogger(__name__)

router = APIRouter()


@router.websocket("/api/ws")
async def live(websocket: WebSocket) -> None:
    ctx = websocket.app.state.ctx
    if not ctx.auth.websocket_ok(websocket):
        await websocket.close(code=4401)
        return
    await websocket.accept()
    queue = ctx.bus.subscribe()
    try:
        await websocket.send_json({
            "type": "snapshot",
            "data": {
                "devices": [ctx.hub.device_payload(d) for d in ctx.hub.visible_devices()],
                "rooms": await ctx.db.list_rooms(),
                "growplans": ctx.growplan.summaries(),
                "watering": ctx.watering.payload(),
                "server_time": time.time(),
            },
        })

        async def pump() -> None:
            while True:
                message = await queue.get()
                await websocket.send_json(message)

        async def heartbeat() -> None:
            while True:
                await asyncio.sleep(25)
                await websocket.send_json({"type": "ping", "data": {
                    "server_time": time.time(),
                    "automation": ctx.automation.status(),
                    "room_control": ctx.room_control.status_all(),
                    "alarms": ctx.alarms.status(),
                    "integrations": await ctx.integrations(),
                }})

        async def reader() -> None:
            while True:
                await websocket.receive_text()

        tasks = [asyncio.create_task(pump()), asyncio.create_task(heartbeat()), asyncio.create_task(reader())]
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        for task in done:
            with contextlib.suppress(WebSocketDisconnect, RuntimeError, asyncio.CancelledError):
                task.result()
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001
        _LOGGER.debug("Websocket closed with error", exc_info=True)
    finally:
        ctx.bus.unsubscribe(queue)

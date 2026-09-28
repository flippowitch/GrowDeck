"""GrowDeck application entry point."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .api import routes, ws
from .config import load_settings
from .context import VERSION, AppContext

settings = load_settings()
logging.basicConfig(
    level=getattr(logging, settings.log_level, logging.INFO),
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
)
logging.getLogger("aiosqlite").setLevel(logging.WARNING)
_LOGGER = logging.getLogger("growdeck")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    ctx = await AppContext.create(settings)
    app.state.ctx = ctx
    await ctx.start()
    _LOGGER.info("GrowDeck %s gestartet (Daten: %s)", VERSION, settings.data_dir)
    if settings.password_generated:
        _LOGGER.warning(
            "Kein APP_PASSWORD gesetzt. Erzeugtes Passwort: %s  (gespeichert in %s)",
            settings.app_password, settings.data_dir / "generated-password.txt",
        )
    if settings.simulate_spiderfarmer or settings.simulate_vivosun:
        _LOGGER.warning("Demo-Modus aktiv: simulierte Geräte werden angezeigt.")
    try:
        yield
    finally:
        await ctx.stop()


app = FastAPI(title="GrowDeck", version=VERSION, lifespan=lifespan, docs_url="/api/docs",
              openapi_url="/api/openapi.json", redoc_url=None)
app.include_router(routes.router)
app.include_router(ws.router)


@app.get("/api/health", include_in_schema=False)
async def health() -> JSONResponse:
    return JSONResponse({"ok": True, "version": VERSION})


if settings.static_dir.is_dir() and (settings.static_dir / "index.html").is_file():
    assets = settings.static_dir / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str) -> FileResponse:
        candidate = (settings.static_dir / path).resolve()
        if path and candidate.is_file() and settings.static_dir in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(settings.static_dir / "index.html", headers={"Cache-Control": "no-cache"})
else:
    _LOGGER.warning("Kein Frontend-Build unter %s gefunden - nur die API ist verfügbar.", settings.static_dir)

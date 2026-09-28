"""Runtime configuration, read once from environment variables."""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass
from pathlib import Path


def _bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None or value == "":
        return default
    return value.strip().lower() in {"1", "true", "yes", "on", "ja"}


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


@dataclass(slots=True)
class Settings:
    data_dir: Path
    static_dir: Path
    app_password: str
    password_generated: bool
    session_secret: str
    mqtt_host: str
    mqtt_port: int
    mqtt_username: str | None
    mqtt_password: str | None
    spiderfarmer_enabled: bool
    simulate_spiderfarmer: bool
    simulate_vivosun: bool
    vivosun_email: str | None
    vivosun_password: str | None
    simulate_acinfinity: bool
    acinfinity_email: str | None
    acinfinity_password: str | None
    history_interval: int
    retention_days: int
    timezone: str
    log_level: str
    telegram_token: str | None = None
    telegram_chat_id: str | None = None

    @property
    def db_path(self) -> Path:
        return self.data_dir / "growdeck.sqlite3"


def _load_or_create_secret(path: Path, nbytes: int = 32) -> str:
    try:
        existing = path.read_text(encoding="utf-8").strip()
        if existing:
            return existing
    except FileNotFoundError:
        pass
    value = secrets.token_urlsafe(nbytes)
    path.write_text(value, encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return value


def load_settings() -> Settings:
    data_dir = Path(os.environ.get("GD_DATA_DIR", "/data")).resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    static_dir = Path(
        os.environ.get("GD_STATIC_DIR", Path(__file__).resolve().parent.parent / "static")
    ).resolve()

    password = os.environ.get("APP_PASSWORD", "").strip()
    generated = False
    if not password:
        password = _load_or_create_secret(data_dir / "generated-password.txt", 9)
        generated = True

    demo = _bool("DEMO_MODE", False)
    return Settings(
        data_dir=data_dir,
        static_dir=static_dir,
        app_password=password,
        password_generated=generated,
        session_secret=_load_or_create_secret(data_dir / "session-secret.txt"),
        mqtt_host=os.environ.get("MQTT_HOST", "mosquitto"),
        mqtt_port=_int("MQTT_PORT", 1883),
        mqtt_username=os.environ.get("MQTT_USERNAME") or None,
        mqtt_password=os.environ.get("MQTT_PASSWORD") or None,
        spiderfarmer_enabled=_bool("SPIDERFARMER_ENABLED", True),
        simulate_spiderfarmer=_bool("SIMULATE_SPIDERFARMER", demo),
        simulate_vivosun=_bool("SIMULATE_VIVOSUN", demo),
        vivosun_email=os.environ.get("VIVOSUN_EMAIL") or None,
        vivosun_password=os.environ.get("VIVOSUN_PASSWORD") or None,
        simulate_acinfinity=_bool("SIMULATE_ACINFINITY", demo),
        acinfinity_email=os.environ.get("ACINFINITY_EMAIL") or None,
        acinfinity_password=os.environ.get("ACINFINITY_PASSWORD") or None,
        history_interval=max(10, _int("HISTORY_INTERVAL_SECONDS", 60)),
        retention_days=max(1, _int("RETENTION_DAYS", 90)),
        timezone=os.environ.get("TZ", "Europe/Berlin"),
        log_level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        telegram_token=os.environ.get("TELEGRAM_BOT_TOKEN", "").strip() or None,
        telegram_chat_id=os.environ.get("TELEGRAM_CHAT_ID", "").strip() or None,
    )

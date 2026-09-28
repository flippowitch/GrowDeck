"""Vivosun cloud session built on the vendored (MIT) client modules.

Mirrors the bootstrap/reconnect behaviour of the Home Assistant integration
(REST login -> device list -> AWS identity -> Cognito credentials -> AWS IoT
MQTT over websocket), but without any Home Assistant dependency.

The session reports everything through three callbacks:
    on_devices(list[CloudDevice])
    on_shadow(device_id, reported_fragment, full: bool)
    on_telemetry(device_id, raw_values: dict)
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

import aiohttp

from .vendor.api import VivosunApiClient
from .vendor.aws_auth import AwsAuthClient, AwsCredentials
from .vendor.const import (
    TOPIC_CHANNEL_APP,
    TOPIC_SHADOW_GET,
    TOPIC_SHADOW_GET_ACCEPTED,
    TOPIC_SHADOW_UPDATE,
    TOPIC_SHADOW_UPDATE_ACCEPTED,
    TOPIC_SHADOW_UPDATE_DELTA,
    TOPIC_SHADOW_UPDATE_DOCUMENTS,
)
from .vendor.exceptions import VivosunAuthError
from .vendor.models import AuthTokens, AwsIdentity, DeviceInfo, client_model_token
from .vendor.mqtt_client import MQTTClient

_LOGGER = logging.getLogger(__name__)

POINT_LOG_WINDOW = 300
AUTH_RETRY_SECONDS = 15 * 60


@dataclass(slots=True)
class CloudDevice:
    device_id: str
    client_id: str
    topic_prefix: str
    name: str
    online: bool
    scene_id: int
    device_type: str
    model_token: str
    camera_username: str | None = None
    camera_password: str | None = None
    supports_point_log: bool = True

    @classmethod
    def from_info(cls, info: DeviceInfo) -> CloudDevice:
        device_type = info.device_type
        token = client_model_token(info.client_id) if info.client_id else ""
        lowered = f"{info.name} {info.client_id}".lower()
        if device_type == "unknown" and (token.startswith("VSACA") or "aerolush" in lowered):
            device_type = "air_conditioner"
        return cls(
            device_id=info.device_id,
            client_id=info.client_id,
            topic_prefix=info.topic_prefix,
            name=info.name,
            online=info.online,
            scene_id=info.scene_id,
            device_type=device_type,
            model_token=token,
            camera_username=info.camera_username,
            camera_password=info.camera_password,
            supports_point_log=info.supports_point_log,
        )

    def as_info(self) -> DeviceInfo:
        return DeviceInfo(
            device_id=self.device_id, client_id=self.client_id, topic_prefix=self.topic_prefix,
            name=self.name, online=self.online, scene_id=self.scene_id, device_type=self.device_type,
            camera_username=self.camera_username, camera_password=self.camera_password,
            supports_point_log=self.supports_point_log,
        )


def extract_reported(document: dict[str, Any]) -> tuple[dict[str, Any] | None, bool]:
    """Return (reported-like fragment, is_full_document)."""
    state = document.get("state")
    if isinstance(state, dict):
        reported = state.get("reported")
        if isinstance(reported, dict):
            return reported, False
        desired = state.get("desired")
        if isinstance(desired, dict):
            # update/accepted echoes our own desired change: use it optimistically.
            return desired, False
    current = document.get("current")
    if isinstance(current, dict):
        current_state = current.get("state")
        if isinstance(current_state, dict) and isinstance(current_state.get("reported"), dict):
            return current_state["reported"], True
    return None, False


class VivosunCloud:
    """Long-running session with automatic reconnect."""

    simulated = False

    def __init__(self, email: str, password: str, *, poll_interval: int = 60) -> None:
        self._email = email
        self._password = password
        self._poll_interval = max(30, poll_interval)
        self.devices: dict[str, CloudDevice] = {}
        self.state = "stopped"
        self.last_error: str | None = None
        self.last_sync: float | None = None
        self.on_devices: Callable[[list[CloudDevice]], None] = lambda devices: None
        self.on_shadow: Callable[[str, dict[str, Any], bool], None] = lambda d, s, f: None
        self.on_telemetry: Callable[[str, dict[str, Any]], None] = lambda d, t: None
        self._task: asyncio.Task[None] | None = None
        self._stop = asyncio.Event()
        self._mqtt: MQTTClient | None = None
        self._client_to_device: dict[str, str] = {}
        self._prefix_to_device: dict[str, str] = {}
        self._wake = asyncio.Event()
        self.mqtt_state = "down"          # connected | connecting | reconnecting | down | none
        self.mqtt_error: str | None = None
        self._ever_connected = False
        self._shadow_get_blocked: set[str] = set()
        self._no_shadow_get = False
        self._quick_drops = 0

    # ------------------------------------------------------------ lifecycle
    async def start(self) -> None:
        self._stop.clear()
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name="vivosun-cloud")

    async def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._task is not None:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None
        await self._disconnect_mqtt()
        self.state = "stopped"

    def request_poll(self) -> None:
        self._wake.set()

    # ------------------------------------------------------------ main loop
    async def _run(self) -> None:
        backoff = 5.0
        while not self._stop.is_set():
            try:
                self.state = "connecting"
                async with aiohttp.ClientSession() as session:
                    await self._session(session)
                backoff = 5.0
            except asyncio.CancelledError:
                raise
            except VivosunAuthError as err:
                self.state = "auth_failed"
                self.last_error = "Anmeldung bei Vivosun fehlgeschlagen - E-Mail/Passwort prüfen."
                _LOGGER.warning("Vivosun login failed: %s", err)
                await self._sleep(AUTH_RETRY_SECONDS)
                continue
            except Exception as err:  # noqa: BLE001
                self.state = "error"
                self.last_error = f"{type(err).__name__}: {err}"
                _LOGGER.warning("Vivosun session failed (%s), retry in %.0fs", self.last_error, backoff)
            finally:
                await self._disconnect_mqtt()
            await self._sleep(backoff)
            backoff = min(backoff * 2, 300.0)

    async def _sleep(self, seconds: float) -> None:
        self._wake.clear()
        try:
            await asyncio.wait_for(self._wake.wait(), timeout=seconds)
        except TimeoutError:
            pass

    async def _session(self, session: aiohttp.ClientSession) -> None:
        api = VivosunApiClient(session)
        aws = AwsAuthClient(session)
        tokens = await api.login(self._email, self._password)
        infos = await api.get_devices(tokens)
        self.devices = {i.device_id: CloudDevice.from_info(i) for i in infos}
        self._client_to_device = {d.client_id: d.device_id for d in self.devices.values() if d.client_id}
        self._prefix_to_device = {d.topic_prefix: d.device_id for d in self.devices.values() if d.topic_prefix}
        self.on_devices(list(self.devices.values()))
        _LOGGER.info("Vivosun: %d Geräte gefunden", len(self.devices))
        for device in self.devices.values():
            _LOGGER.info("Vivosun-Gerät %s: Typ %s, Steuerung über AWS IoT %s, Messwerte über REST %s",
                         device.name, device.device_type, "ja" if device.client_id else "nein",
                         "ja" if device.supports_point_log else "nein")
        self.state = "connected"
        self.last_error = None
        supervisor = asyncio.create_task(self._mqtt_supervisor(api, aws, tokens), name="vivosun-mqtt")
        try:
            last_shadow_refresh = time.time()
            while not self._stop.is_set():
                if supervisor.done():
                    supervisor.result()  # re-raises login problems
                await self._poll_telemetry(api, tokens)
                self.last_sync = time.time()
                if self.mqtt_state == "connected" and time.time() - last_shadow_refresh > 300:
                    last_shadow_refresh = time.time()
                    for device in list(self.devices.values()):
                        await self.request_shadow(device.device_id)
                await self._sleep(self._poll_interval)
        finally:
            supervisor.cancel()
            await asyncio.gather(supervisor, return_exceptions=True)

    async def _mqtt_supervisor(self, api: VivosunApiClient, aws: AwsAuthClient, tokens: AuthTokens) -> None:
        """Keep the AWS IoT session alive; REST telemetry continues while it reconnects."""
        if not any(d.client_id and d.device_type != "camera" for d in self.devices.values()):
            self.mqtt_state = "none"
            _LOGGER.info("Vivosun: kein Gerät mit Steuerung über AWS IoT im Konto")
            return
        loop = asyncio.get_running_loop()
        backoff = 5.0
        credentials: AwsCredentials | None = None
        while not self._stop.is_set():
            client = self._mqtt
            if client is not None and client.is_connected:
                if credentials is not None and aws.credentials_need_refresh(credentials):
                    _LOGGER.info("Vivosun: AWS-Zugang läuft ab, verbinde neu")
                    await self._disconnect_mqtt()
                    continue
                if client.connected_at is not None and loop.time() - client.connected_at > 600:
                    self._quick_drops = 0
                    backoff = 5.0
                await asyncio.sleep(3)
                continue
            if client is not None:
                uptime = self._note_drop(client, loop.time())
                self._mqtt = None
                await client.disconnect()
                self.mqtt_state = "reconnecting"
                self._update_error(backoff if uptime < 60 else 0)
                if uptime < 60:
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 300.0)
                else:
                    backoff = 5.0
            self.mqtt_state = "reconnecting" if self._ever_connected else "connecting"
            try:
                identity = await api.get_aws_identity(tokens)
                credentials = await aws.get_credentials_for_identity(identity)
                await self._connect_mqtt(aws, identity, credentials)
                self.mqtt_state = "connected"
                self.mqtt_error = None
                self._ever_connected = True
                self._update_error()
                _LOGGER.info("Vivosun: Verbindung zu AWS IoT steht")
            except (asyncio.CancelledError, VivosunAuthError):
                raise
            except Exception as err:  # noqa: BLE001
                client = self._mqtt
                self._mqtt = None
                if client is not None:
                    await client.disconnect()
                self.mqtt_state = "down"
                self.mqtt_error = (client.last_error if client is not None and client.last_error
                                   else f"{type(err).__name__}: {err}")
                _LOGGER.warning("Vivosun: Verbindung zu AWS IoT fehlgeschlagen (%s), neuer Versuch in %.0f s",
                                self.mqtt_error, backoff)
                self._update_error(backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 300.0)

    def _note_drop(self, client: MQTTClient, now: float) -> float:
        uptime = now - (client.connected_at or now)
        reason = client.last_error or "unbekannter Grund"
        last = client.last_published
        _LOGGER.warning("Vivosun: Verbindung zu AWS IoT nach %.0f s getrennt: %s%s", uptime, reason,
                        f" (zuletzt gesendet: {last[0]})" if last else "")
        self.mqtt_error = reason
        if uptime < 30:
            self._quick_drops += 1
            if self._quick_drops >= 2 and not self._no_shadow_get:
                self._no_shadow_get = True
                _LOGGER.warning("Vivosun: Die Verbindung bricht direkt nach dem Aufbau ab. GrowDeck fragt den "
                                "Gerätezustand deshalb nicht mehr aktiv ab und nutzt nur noch Änderungsmeldungen.")
        return uptime

    def _update_error(self, retry_in: float = 0) -> None:
        if self.mqtt_state == "connected":
            self.state = "connected"
            blocked = [self.devices[d].name for d in self._shadow_get_blocked if d in self.devices]
            self.last_error = (f"Hinweis: Den Zustand von {', '.join(blocked)} fragt GrowDeck nicht aktiv ab, weil "
                               "AWS IoT dabei die Verbindung getrennt hat. Änderungen kommen trotzdem an."
                               if blocked else None)
            return
        self.state = "degraded"
        when = f" Neuer Versuch in {retry_in:.0f} s." if retry_in else ""
        self.last_error = (f"Schalten ist gerade nicht möglich: Die Verbindung zu AWS IoT ist getrennt "
                           f"({self.mqtt_error or 'unbekannter Grund'}).{when} Messwerte kommen weiter.")

    async def _poll_telemetry(self, api: VivosunApiClient, tokens: AuthTokens) -> None:
        end = int(time.time())
        for device in list(self.devices.values()):
            if device.device_type == "camera" or not device.supports_point_log:
                continue
            try:
                row = await api.get_point_log_raw(tokens, device.as_info(),
                                                  start_time=end - POINT_LOG_WINDOW, end_time=end)
            except VivosunAuthError:
                raise
            except Exception:  # noqa: BLE001
                _LOGGER.debug("Point log failed for %s", device.name, exc_info=True)
                continue
            if row:
                self.on_telemetry(device.device_id, row)

    # ------------------------------------------------------------------ mqtt
    async def _connect_mqtt(self, aws: AwsAuthClient, identity: AwsIdentity,
                            credentials: AwsCredentials) -> None:
        await self._disconnect_mqtt()
        mqtt_devices = [d for d in self.devices.values() if d.client_id and d.device_type != "camera"]
        if not mqtt_devices:
            return
        primary = sorted(mqtt_devices, key=lambda d: d.device_id)[0]
        url = aws.sigv4_sign_mqtt_url(endpoint=identity.aws_host, region=identity.aws_region,
                                      credentials=credentials)
        client = MQTTClient(
            websocket_url=url,
            thing=primary.client_id,
            topic_prefix=primary.topic_prefix,
            client_id=f"growdeck-{primary.device_id[:12]}-{uuid4().hex[:8]}",
            label="growdeck",
        )
        self._mqtt = client
        await client.connect()
        client.add_message_callback(self._on_publish)
        for device in mqtt_devices:
            if device.client_id == primary.client_id:
                continue
            try:
                await client.subscribe([
                    (TOPIC_SHADOW_GET_ACCEPTED.format(thing=device.client_id), 1),
                    (TOPIC_SHADOW_UPDATE_ACCEPTED.format(thing=device.client_id), 1),
                    (TOPIC_SHADOW_UPDATE_DOCUMENTS.format(thing=device.client_id), 1),
                    (TOPIC_SHADOW_UPDATE_DELTA.format(thing=device.client_id), 1),
                    (TOPIC_CHANNEL_APP.format(topic_prefix=device.topic_prefix), 1),
                ])
            except Exception as err:  # noqa: BLE001
                if not client.is_connected:
                    raise
                _LOGGER.warning("Vivosun: Live-Meldungen für %s nicht verfügbar (%s)", device.name, err)
        for device in mqtt_devices:
            if not self._shadow_get_allowed(device.device_id):
                continue
            await self.request_shadow(device.device_id)
            await asyncio.sleep(1.0)
            if not client.is_connected:
                self._shadow_get_blocked.add(device.device_id)
                _LOGGER.warning("Vivosun: AWS IoT hat nach der Zustandsabfrage für %s getrennt; diese Abfrage "
                                "wird ab jetzt übersprungen", device.name)
                raise ConnectionError(f"AWS IoT hat nach der Zustandsabfrage für {device.name} getrennt")

    def _shadow_get_allowed(self, device_id: str) -> bool:
        return not self._no_shadow_get and device_id not in self._shadow_get_blocked

    async def _disconnect_mqtt(self) -> None:
        client, self._mqtt = self._mqtt, None
        if client is not None:
            try:
                await client.disconnect()
            except Exception:  # noqa: BLE001
                _LOGGER.debug("MQTT disconnect failed", exc_info=True)

    async def _on_publish(self, topic: str, payload: bytes, qos: int) -> None:
        # One unexpected message must never end the AWS IoT session.
        try:
            await self._handle_publish(topic, payload, qos)
        except Exception:  # noqa: BLE001
            _LOGGER.exception("Vivosun: Nachricht auf %s nicht verarbeitet: %.300r", topic, payload)

    async def _handle_publish(self, topic: str, payload: bytes, qos: int) -> None:
        _ = qos
        device_id = self._route(topic)
        if device_id is None:
            return
        try:
            document = json.loads(payload) if payload else {}
        except ValueError:
            return
        if not isinstance(document, dict):
            return
        if "/shadow/" in topic:
            if topic.endswith("/update/delta"):
                return  # desired/reported drift, not a real state
            fragment, full = extract_reported(document)
            if fragment is not None:
                self.on_shadow(device_id, fragment, full or topic.endswith("/get/accepted"))
        elif topic.endswith("/channel/app"):
            values = {k: v for k, v in document.items() if isinstance(v, int | float) and not isinstance(v, bool)}
            if values:
                self.on_telemetry(device_id, values)

    def _route(self, topic: str) -> str | None:
        if topic.startswith("$aws/things/"):
            parts = topic.split("/")
            return self._client_to_device.get(parts[2]) if len(parts) > 2 else None
        for prefix, device_id in self._prefix_to_device.items():
            if topic.startswith(prefix + "/"):
                return device_id
        return None

    async def request_shadow(self, device_id: str) -> None:
        device = self.devices.get(device_id)
        client = self._mqtt
        if device is None or client is None or not client.is_connected or not device.client_id:
            return
        if device.device_type == "camera" or not self._shadow_get_allowed(device_id):
            return
        await client.publish(TOPIC_SHADOW_GET.format(thing=device.client_id), b"{}")

    async def publish_desired(self, device_id: str, desired: dict[str, Any]) -> None:
        device = self.devices.get(device_id)
        client = self._mqtt
        if device is None:
            raise ConnectionError("Gerät ist im Vivosun-Konto nicht mehr vorhanden.")
        if client is None or not client.is_connected:
            raise ConnectionError("Die Steuerung über die Vivosun-Cloud ist gerade getrennt. GrowDeck verbindet "
                                  "neu, bitte gleich noch einmal versuchen.")
        payload = json.dumps({"state": {"desired": desired}}, separators=(",", ":")).encode()
        await client.publish(TOPIC_SHADOW_UPDATE.format(thing=device.client_id), payload, qos=1)

"""Resilient connection to the local Mosquitto broker (aiomqtt)."""

from __future__ import annotations

import asyncio
import inspect
import logging
import uuid
from collections.abc import Awaitable, Callable

import aiomqtt

_LOGGER = logging.getLogger(__name__)

Handler = Callable[[str, bytes], Awaitable[None] | None]


class MqttBus:
    def __init__(self, host: str, port: int, *, username: str | None = None,
                 password: str | None = None, client_prefix: str = "growdeck") -> None:
        self.host = host
        self.port = port
        self._username = username
        self._password = password
        self._client_id = f"{client_prefix}-{uuid.uuid4().hex[:8]}"
        self._handlers: list[tuple[str, Handler]] = []
        self._client: aiomqtt.Client | None = None
        self._task: asyncio.Task[None] | None = None
        self._connected = asyncio.Event()
        self.last_error: str | None = None
        self.messages_in = 0
        self.messages_out = 0

    @property
    def connected(self) -> bool:
        return self._connected.is_set()

    def subscribe(self, pattern: str, handler: Handler) -> None:
        self._handlers.append((pattern, handler))
        client = self._client
        if client is not None and self.connected:
            asyncio.get_running_loop().create_task(client.subscribe(pattern, qos=0))

    async def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name=f"mqtt-{self._client_id}")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None

    async def wait_connected(self, timeout: float = 10.0) -> bool:
        try:
            await asyncio.wait_for(self._connected.wait(), timeout)
            return True
        except TimeoutError:
            return False

    async def publish(self, topic: str, payload: bytes | str, qos: int = 0, retain: bool = False) -> None:
        client = self._client
        if client is None or not self.connected:
            raise ConnectionError("MQTT-Broker ist nicht verbunden.")
        await client.publish(topic, payload, qos=qos, retain=retain)
        self.messages_out += 1

    async def _run(self) -> None:
        delay = 1.0
        while True:
            try:
                client = aiomqtt.Client(
                    hostname=self.host,
                    port=self.port,
                    username=self._username,
                    password=self._password,
                    identifier=self._client_id,
                    keepalive=30,
                )
                # Bursts of config requests are normal; aiomqtt warns above 10.
                client.pending_calls_threshold = 1000
                async with client:
                    self._client = client
                    for pattern in {p for p, _ in self._handlers}:
                        await client.subscribe(pattern, qos=0)
                    self._connected.set()
                    self.last_error = None
                    delay = 1.0
                    _LOGGER.info("MQTT verbunden mit %s:%s", self.host, self.port)
                    async for message in client.messages:
                        self.messages_in += 1
                        await self._dispatch(message)
            except asyncio.CancelledError:
                raise
            except aiomqtt.MqttError as err:
                self.last_error = str(err)
                _LOGGER.warning("MQTT %s:%s nicht erreichbar (%s), neuer Versuch in %.0fs",
                                self.host, self.port, err, delay)
            except Exception as err:  # noqa: BLE001
                self.last_error = str(err)
                _LOGGER.exception("MQTT-Schleife abgebrochen")
            finally:
                self._connected.clear()
                self._client = None
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30.0)

    async def _dispatch(self, message: aiomqtt.Message) -> None:
        topic = message.topic.value
        payload = message.payload if isinstance(message.payload, bytes) else str(message.payload).encode()
        for pattern, handler in self._handlers:
            if not message.topic.matches(pattern):
                continue
            try:
                result = handler(topic, payload)
                if inspect.isawaitable(result):
                    await result
            except Exception:  # noqa: BLE001 - a bad payload must not kill the loop
                _LOGGER.exception("Fehler beim Verarbeiten von %s", topic)

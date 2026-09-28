"""Common adapter interface."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..hub import Hub
    from ..model import Device


class AdapterError(Exception):
    """Raised when a command cannot be delivered or is invalid for a device."""


class Adapter:
    """Base class. One adapter per vendor protocol."""

    vendor: str = "generic"
    title: str = "Generic"

    def __init__(self) -> None:
        self.hub: Hub | None = None

    async def start(self, hub: Hub) -> None:
        self.hub = hub

    async def stop(self) -> None:
        return None

    async def apply(self, device: Device, control_id: str, patch: dict[str, Any]) -> None:
        """Apply a vendor-neutral control patch (on, level, mode, ...)."""
        raise AdapterError("Dieses Gerät kann nicht gesteuert werden.")

    async def native(self, device: Device, payload: dict[str, Any]) -> dict[str, Any]:
        """Vendor-specific advanced operation (raw config read/write)."""
        raise AdapterError("Für dieses Gerät gibt es keine erweiterten Einstellungen.")

    async def refresh(self, device: Device) -> None:
        """Ask the device/cloud for a fresh state snapshot (best effort)."""
        return None

    def status(self) -> dict[str, Any]:
        return {"vendor": self.vendor, "title": self.title, "state": "unknown"}

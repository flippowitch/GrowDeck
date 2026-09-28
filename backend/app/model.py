"""Vendor-neutral device model shared by all adapters, the API and the UI.

Every adapter translates its vendor protocol into these objects. The UI and the
automation engine only ever see this model, which is what makes it possible to
let a Spider Farmer sensor drive a Vivosun humidifier.
"""

from __future__ import annotations

import time
from dataclasses import asdict, dataclass, field
from typing import Any

# Sensor kinds decide unit, formatting and which charts/alarms make sense.
SENSOR_KINDS = {
    "temp": ("Temperatur", "°C"),
    "humi": ("Luftfeuchte", "%"),
    "vpd": ("VPD", "kPa"),
    "co2": ("CO₂", "ppm"),
    "ppfd": ("PPFD", "µmol/m²/s"),
    "soil_temp": ("Bodentemperatur", "°C"),
    "soil_moisture": ("Bodenfeuchte", "%"),
    "soil_ec": ("Boden-EC", "mS/cm"),
    "water": ("Wasserstand", "%"),
    "rssi": ("WLAN-Signal", "dBm"),
    "light": ("Licht", "%"),
    "ph": ("pH-Wert", ""),
    "ec": ("EC", "mS/cm"),
    "tds": ("TDS", "ppm"),
    "leak": ("Wassermelder", ""),
    "other": ("Messwert", ""),
}

# Control types. The UI picks its widgets from `features`, not from the type,
# the type only drives icons and default labels.
CONTROL_TYPES = {
    "light": "Licht",
    "exhaust_fan": "Abluft",
    "circulation_fan": "Umluft",
    "outlet": "Steckdose",
    "heater": "Heizung",
    "humidifier": "Befeuchter",
    "dehumidifier": "Entfeuchter",
    "air_conditioner": "Klimagerät",
    "switch": "Schalter",
    "select": "Auswahl",
}


@dataclass(slots=True)
class Sensor:
    key: str
    kind: str
    label: str
    unit: str
    value: float | None
    updated: float = field(default_factory=time.time)
    group: str = ""  # e.g. "Innen", "Außen", "Sonde 1" - used for UI grouping

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class Control:
    id: str
    type: str
    label: str
    on: bool | None = None
    level: float | None = None
    level_min: float = 0
    level_max: float = 100
    level_step: float = 1
    level_unit: str = "%"
    # Discrete level values the device really supports (e.g. fan steps).
    level_values: list[float] | None = None
    mode: str | None = None
    mode_label: str | None = None
    modes: list[dict[str, str]] = field(default_factory=list)
    features: list[str] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)
    options: list[dict[str, str]] = field(default_factory=list)
    value: str | None = None
    native: dict[str, Any] = field(default_factory=dict)
    note: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class Device:
    id: str
    vendor: str  # "spiderfarmer" | "vivosun"
    native_id: str
    model: str
    kind: str
    name: str
    online: bool = True
    last_seen: float = field(default_factory=time.time)
    sensors: dict[str, Sensor] = field(default_factory=dict)
    controls: dict[str, Control] = field(default_factory=dict)
    info: dict[str, Any] = field(default_factory=dict)
    raw: dict[str, Any] = field(default_factory=dict)
    config: dict[str, Any] = field(default_factory=dict)
    simulated: bool = False

    def to_dict(self, *, include_raw: bool = False) -> dict[str, Any]:
        data = {
            "id": self.id,
            "vendor": self.vendor,
            "native_id": self.native_id,
            "model": self.model,
            "kind": self.kind,
            "name": self.name,
            "online": self.online,
            "last_seen": self.last_seen,
            "sensors": [s.to_dict() for s in self.sensors.values()],
            "controls": [c.to_dict() for c in self.controls.values()],
            "info": self.info,
            "simulated": self.simulated,
        }
        if include_raw:
            data["raw"] = self.raw
            data["config"] = self.config
        return data


def make_sensor(key: str, kind: str, value: float | None, *, label: str | None = None,
                unit: str | None = None, group: str = "") -> Sensor:
    default_label, default_unit = SENSOR_KINDS.get(kind, SENSOR_KINDS["other"])
    return Sensor(
        key=key,
        kind=kind,
        label=label or default_label,
        unit=default_unit if unit is None else unit,
        value=None if value is None else round(float(value), 3),
        group=group,
    )


def calc_vpd(temp_c: float | None, rh: float | None, leaf_offset: float = 0.0) -> float | None:
    """Air VPD in kPa (Tetens). leaf_offset lowers the leaf temperature."""
    if temp_c is None or rh is None:
        return None
    import math

    leaf = temp_c - leaf_offset
    svp_leaf = 0.6108 * math.exp(17.27 * leaf / (leaf + 237.3))
    svp_air = 0.6108 * math.exp(17.27 * temp_c / (temp_c + 237.3))
    return round(max(0.0, svp_leaf - svp_air * rh / 100.0), 3)

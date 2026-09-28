"""Growplan inside GrowDeck: one grow plan per tent, the watering log and a shared library.

The data follows Growplan 2.1 (the Android app), so backups move in both directions:
a plan's settings have the shape of Growplan's settings object, log entries and
feeding schedules are stored the way Growplan writes them. The feeding engine lives in
the frontend, as in the app. The backend knows the climate targets per phase, so the
room control can follow the plan from week to week.
"""
from __future__ import annotations

import asyncio
import copy
import logging
import math
import re
import secrets
import time
from collections.abc import Callable
from datetime import date, datetime, timedelta
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo

from .i18n import tr

if TYPE_CHECKING:
    from .db import Database
    from .events import EventBus

_LOGGER = logging.getLogger(__name__)

# Climate and light targets per phase, identical to Growplan 2.1.
ENV: dict[str, dict[str, Any]] = {
    "seed": {"n": "Sämling / Steckling", "ppfd": [150, 300], "h": 18, "tag": [22, 26], "nacht": [20, 24],
             "rh": [65, 75], "vpd": [0.4, 0.8], "hoehe": [55, 70]},
    "veg1": {"n": "Wachstum, frühe Wochen", "ppfd": [300, 500], "h": 18, "tag": [22, 27], "nacht": [20, 24],
             "rh": [60, 70], "vpd": [0.8, 1.0], "hoehe": [50, 60]},
    "veg2": {"n": "Wachstum, späte Wochen", "ppfd": [450, 650], "h": 18, "tag": [22, 27], "nacht": [20, 24],
             "rh": [55, 65], "vpd": [0.9, 1.2], "hoehe": [45, 55]},
    "flo1": {"n": "Blüte, Streckung", "ppfd": [600, 800], "h": 12, "tag": [22, 26], "nacht": [19, 22],
             "rh": [50, 60], "vpd": [1.0, 1.2], "hoehe": [40, 50]},
    "flo2": {"n": "Blüte, Knospenaufbau", "ppfd": [700, 900], "h": 12, "tag": [22, 26], "nacht": [18, 21],
             "rh": [45, 55], "vpd": [1.2, 1.4], "hoehe": [35, 45]},
    "flo3": {"n": "Blüte, Reife", "ppfd": [700, 900], "h": 12, "tag": [20, 25], "nacht": [17, 20],
             "rh": [40, 45], "vpd": [1.3, 1.6], "hoehe": [35, 45]},
    "flush": {"n": "Spülwoche", "ppfd": [600, 800], "h": 12, "tag": [19, 24], "nacht": [16, 19],
              "rh": [35, 45], "vpd": [1.4, 1.6], "hoehe": [40, 50]},
}
ENV_KEYS = ("seed", "veg1", "veg2", "flo1", "flo2", "flo3", "flush")
# field -> (lowest, highest, decimals); "h" is a single value, all others are ranges
ENV_FIELDS: dict[str, tuple[float, float, int]] = {
    "tag": (5, 40, 1), "nacht": (5, 40, 1), "rh": (10, 95, 0), "vpd": (0.1, 3, 2),
    "ppfd": (0, 2500, 0), "h": (0, 24, 0), "hoehe": (5, 200, 0),
}
BUILTIN_IDS = ("an-sensi-top", "an-sensi-master", "an-coco-top", "an-coco-master", "an-conn-top",
               "an-conn-master", "bb-light", "bb-all", "ahh-df")
DEFAULT_SCHED = "an-sensi-top"
LAMP_DEFAULT: dict[str, Any] = {"name": "Spider Farmer G3000", "ppf": 852, "watt": 300, "util": 85, "luxF": 65,
                                "price": 0.30}
LAMP_LIMITS = {"ppf": (50, 5000), "watt": (10, 3000), "util": (30, 100), "luxF": (10, 150), "price": (0, 3)}
CHECK_IDS = tuple(f"d{i}" for i in range(1, 14))
CHECK_GROUPS = ("vor", "beim", "nach")
PHASES = ("seed", "veg", "flower")
MEDIA = ("erde", "kokos", "hydro")
ENTRY_TYPES = ("feed", "water", "flush", "note")
PLAN_KEYS = ("phase", "week", "vegWeeks", "floWeeks", "sched", "strength", "liters", "tent", "vegStart",
             "floStart", "dim", "tAir", "rh", "leafOff", "medium", "plants", "hidden", "envOv", "lamp", "luxIn")
LIBRARY_KEYS = ("custom", "ovr", "check", "checkCustom", "checkOff")
MAX_PLANS = 40
MAX_LOG = 5000
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# photo of a GrowDeck camera attached to a log entry: "<camera>/<YYYY-MM-DD>/<HHMMSS>[-n]"
PHOTO_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}/\d{4}-\d{2}-\d{2}/\d{6}(?:-\d{1,2})?$")
COLOR = re.compile(r"^#[0-9A-Fa-f]{6}$")


class GrowPlanError(ValueError):
    """Invalid input; the message is shown to the user."""


# --------------------------------------------------------------------- helpers
def uid() -> str:
    return f"{int(time.time() * 1000):x}{secrets.token_hex(3)}"


def _num(value: Any, low: float | None = None, high: float | None = None) -> float | None:
    """Number from JSON or German input ("1,5"); None if missing, invalid or out of range."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str):
        text = re.sub(r"\s", "", value).replace(",", ".")
        if not text:
            return None
        try:
            number = float(text)
        except ValueError:
            return None
    else:
        return None
    if math.isnan(number) or math.isinf(number):
        return None
    if (low is not None and number < low) or (high is not None and number > high):
        return None
    return number


def _int(value: Any, low: int, high: int, default: int) -> int:
    number = _num(value)
    if number is None:
        return default
    return max(low, min(high, int(number)))


def _round(value: float, decimals: int) -> float | int:
    factor = 10 ** decimals
    result = math.floor(value * factor + 0.5) / factor
    return int(result) if decimals == 0 or result == int(result) else result


def _text(value: Any, limit: int) -> str:
    return value[:limit] if isinstance(value, str) else ""


def _date(value: Any) -> date | None:
    if not isinstance(value, str) or not ISO_DATE.match(value):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def _iso(value: Any) -> str:
    return value if _date(value) else ""


# ------------------------------------------------------------------ plan data
def new_plant(name: Any, plant_id: str | None = None) -> dict[str, Any]:
    return {"id": plant_id or f"p{uid()}", "name": str(name or "").strip()[:24] or "Pflanze", "strain": "",
            "type": "photo", "pot": None, "start": "", "note": ""}


def default_plan() -> dict[str, Any]:
    return {
        "phase": "veg", "week": 1, "vegWeeks": 4, "floWeeks": 8, "sched": DEFAULT_SCHED, "strength": 100,
        "liters": 5, "tent": 0.81, "vegStart": "", "floStart": "", "dim": 100, "tAir": 24, "rh": 55,
        "leafOff": 2, "medium": "erde", "plants": [new_plant(f"Pflanze {i}", f"p{i}") for i in (1, 2, 3)],
        "hidden": {}, "envOv": {}, "lamp": dict(LAMP_DEFAULT), "luxIn": "",
    }


def sanitize_plants(raw: Any) -> list[dict[str, Any]]:
    plants: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, item in enumerate(raw if isinstance(raw, list) else []):
        if isinstance(item, str):
            plant = new_plant(item, f"p{index + 1}")
        elif isinstance(item, dict):
            plant = new_plant(item.get("name"), str(item["id"])[:40] if item.get("id") else None)
            if isinstance(item.get("strain"), str):
                plant["strain"] = item["strain"][:40]
            if item.get("type") == "auto":
                plant["type"] = "auto"
            pot = item.get("pot")
            if isinstance(pot, (int, float)) and not isinstance(pot, bool) and 0 < pot <= 1000:
                plant["pot"] = pot
            plant["start"] = _iso(item.get("start"))
            if isinstance(item.get("note"), str):
                plant["note"] = item["note"][:300]
            if item.get("gone"):
                plant["gone"] = True
        else:
            continue
        if plant["id"] in seen:
            continue
        seen.add(plant["id"])
        plants.append(plant)
        if len(plants) >= 100:
            break
    if not plants:
        plants = [new_plant(f"Pflanze {i}", f"p{i}") for i in (1, 2, 3)]
    return plants


def sanitize_env_overrides(raw: Any) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    if not isinstance(raw, dict):
        return result
    for key in ENV_KEYS:
        override = raw.get(key)
        if not isinstance(override, dict):
            continue
        clean: dict[str, Any] = {}
        for field, (low, high, decimals) in ENV_FIELDS.items():
            if field not in override:
                continue
            value = override[field]
            if field == "h":
                number = _num(value, low, high)
                if number is not None:
                    clean["h"] = int(_round(number, 0))
            elif isinstance(value, list) and len(value) == 2:
                a, b = _num(value[0], low, high), _num(value[1], low, high)
                if a is not None and b is not None:
                    if a > b:
                        a, b = b, a
                    clean[field] = [_round(a, decimals), _round(b, decimals)]
        clean = {field: value for field, value in clean.items() if value != ENV[key][field]}
        if clean:
            result[key] = clean
    return result


def sanitize_lamp(raw: Any) -> dict[str, Any]:
    lamp = dict(LAMP_DEFAULT)
    if isinstance(raw, dict):
        name = raw.get("name")
        if isinstance(name, str) and name.strip():
            lamp["name"] = name.strip()[:40]
        for key, (low, high) in LAMP_LIMITS.items():
            number = raw.get(key)
            if isinstance(number, (int, float)) and not isinstance(number, bool) and low <= number <= high:
                lamp[key] = number
    return lamp


def sanitize_plan(raw: Any) -> dict[str, Any]:
    """Plan settings in Growplan's shape; unknown keys are dropped, bad values get defaults."""
    src = raw if isinstance(raw, dict) else {}
    plan = default_plan()
    plan["phase"] = src.get("phase") if src.get("phase") in PHASES else "veg"
    plan["vegWeeks"] = _int(src.get("vegWeeks"), 1, 12, 4)
    plan["floWeeks"] = _int(src.get("floWeeks"), 4, 16, 8)
    week = _int(src.get("week"), 1, 16, 1)
    if plan["phase"] == "veg":
        week = min(week, plan["vegWeeks"])
    elif plan["phase"] == "flower":
        week = min(week, plan["floWeeks"])
    else:
        week = min(week, 2)
    plan["week"] = week
    sched = src.get("sched")
    plan["sched"] = sched[:60] if isinstance(sched, str) and sched.strip() else DEFAULT_SCHED
    plan["strength"] = _int(src.get("strength"), 25, 100, 100)
    liters = _num(src.get("liters"))
    plan["liters"] = liters if liters is not None and 0 < liters <= 500 else 5
    tent = _num(src.get("tent"), 0.1, 20)
    plan["tent"] = _round(tent, 2) if tent is not None else 0.81
    plan["vegStart"] = _iso(src.get("vegStart"))
    plan["floStart"] = _iso(src.get("floStart"))
    plan["dim"] = _int(src.get("dim"), 10, 100, 100)
    t_air = _num(src.get("tAir"))
    plan["tAir"] = t_air if t_air is not None and -10 < t_air < 50 else 24
    rh = _num(src.get("rh"), 5, 100)
    plan["rh"] = rh if rh is not None else 55
    leaf = _num(src.get("leafOff"), 0, 8)
    plan["leafOff"] = leaf if leaf is not None else 2
    plan["medium"] = src.get("medium") if src.get("medium") in MEDIA else "erde"
    plan["plants"] = sanitize_plants(src.get("plants"))
    hidden: dict[str, list[str]] = {}
    if isinstance(src.get("hidden"), dict):
        for sched_id, names in list(src["hidden"].items())[:60]:
            if isinstance(names, list):
                clean = [n[:40] for n in names if isinstance(n, str)][:60]
                if clean:
                    hidden[str(sched_id)[:60]] = clean
    plan["hidden"] = hidden
    plan["envOv"] = sanitize_env_overrides(src.get("envOv"))
    plan["lamp"] = sanitize_lamp(src.get("lamp"))
    plan["luxIn"] = _text(src.get("luxIn"), 12)
    return plan


# ------------------------------------------------------------------ schedules
def _dose_list(raw: Any, length: int) -> list[float | int]:
    values: list[float | int] = []
    for item in (raw if isinstance(raw, list) else [])[:length]:
        number = _num(item)
        if number is None:
            number = 0
        elif number < 0:
            number = -1  # value still unknown ("?")
        values.append(_round(min(number, 1000), 3))
    while len(values) < length:
        values.append(0)
    return values


def _row(raw: Any, veg: int, bloom: int, text: bool) -> dict[str, list[Any]] | None:
    if not isinstance(raw, dict):
        return None
    def part(values: Any, length: int) -> list[Any]:
        items = (values if isinstance(values, list) else [])[:length]
        if text:
            clean: list[Any] = [(v.strip()[:200] if isinstance(v, str) else "") for v in items]
            return clean + [""] * (length - len(clean))
        numbers: list[Any] = []
        for v in items:
            number = _num(v, 0, 10)
            numbers.append(_round(number, 2) if number is not None else 0)
        return numbers + [0] * (length - len(numbers))
    row = {"v": part(raw.get("v"), veg), "b": part(raw.get("b"), bloom)}
    return row if any(x for x in row["v"] + row["b"]) else None


def sanitize_schedule(raw: Any, *, custom: bool, sched_id: str | None = None) -> dict[str, Any] | None:
    """A feeding schedule as Growplan stores it (custom schedule or adjusted built-in one)."""
    if not isinstance(raw, dict) or not isinstance(raw.get("products"), list):
        return None
    sid = sched_id or raw.get("id")
    if not isinstance(sid, str) or not sid.strip():
        return None
    veg = _int(raw.get("vegN"), 1, 12, 4)
    bloom = _int(raw.get("bloomN"), 1, 16, 8)
    flush = _int(raw.get("flushN"), 0, 3, 0)
    if flush >= bloom:
        flush = bloom - 1
    feed_weeks = bloom - flush  # at least 1
    sched: dict[str, Any] = {
        "id": sid[:60],
        "brand": _text(raw.get("brand"), 60) or ("Eigenes Schema" if custom else ""),
        "name": _text(raw.get("name"), 60).strip() or "Mein Schema",
        "medium": _text(raw.get("medium"), 120),
        "vegN": veg, "bloomN": bloom, "flushN": flush,
        "hold": max(1, min(_int(raw.get("hold"), 1, 16, feed_weeks), feed_weeks)),
        "seed": "water" if raw.get("seed") == "water" else "veg1",
        "products": [],
        "src": _text(raw.get("src"), 400),
    }
    if raw.get("tips") in ("an", "bb", "ahh") and not custom:
        sched["tips"] = raw["tips"]
    if raw.get("organic"):
        sched["organic"] = True
    ph_range = raw.get("phRange")
    if isinstance(ph_range, list) and len(ph_range) == 2:
        low, high = _num(ph_range[0], 3, 9), _num(ph_range[1], 3, 9)
        if low is not None and high is not None and low <= high:
            sched["phRange"] = [low, high]
    names: set[str] = set()
    for product in raw["products"][:40]:
        if not isinstance(product, dict):
            continue
        name = _text(product.get("n"), 40).strip()
        if not name or name in names:
            continue
        names.add(name)
        item: dict[str, Any] = {
            "n": name,
            "k": product.get("k") if product.get("k") in ("base", "add", "flush") else "add",
            "v": _dose_list(product.get("v"), veg),
            "b": _dose_list(product.get("b"), bloom),
            "t": _text(product.get("t"), 120),
            "u": "g" if product.get("u") == "g" else "ml",
        }
        if isinstance(product.get("c"), str) and COLOR.match(product["c"]):
            item["c"] = product["c"]
        sched["products"].append(item)
    if not sched["products"]:
        return None
    ec = _row(raw.get("ec"), veg, bloom, text=False)
    notes = _row(raw.get("notes"), veg, bloom, text=True)
    if ec:
        sched["ec"] = ec
    if notes:
        sched["notes"] = notes
    comment = _text(raw.get("comment"), 1000).strip()
    if comment:
        sched["comment"] = comment
    if custom:
        sched["custom"] = True
    else:
        sched["adjusted"] = True
    return sched


def sanitize_library(raw: Any) -> dict[str, Any]:
    src = raw if isinstance(raw, dict) else {}
    custom: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in src.get("custom") if isinstance(src.get("custom"), list) else []:
        sched = sanitize_schedule(item, custom=True)
        if sched and sched["id"] not in seen and sched["id"] not in BUILTIN_IDS:
            seen.add(sched["id"])
            custom.append(sched)
        if len(custom) >= 50:
            break
    ovr: dict[str, dict[str, Any]] = {}
    if isinstance(src.get("ovr"), dict):
        for sched_id, item in src["ovr"].items():
            if sched_id in BUILTIN_IDS:
                sched = sanitize_schedule(item, custom=False, sched_id=sched_id)
                if sched:
                    ovr[sched_id] = sched
    check = src.get("check") if isinstance(src.get("check"), dict) else {}
    done = check.get("done") if isinstance(check.get("done"), list) else []
    check_custom: list[dict[str, str]] = []
    for item in src.get("checkCustom") if isinstance(src.get("checkCustom"), list) else []:
        if isinstance(item, dict) and isinstance(item.get("t"), str) and item["t"].strip():
            check_custom.append({
                "id": str(item.get("id") or f"c{uid()}")[:40],
                "g": item.get("g") if item.get("g") in CHECK_GROUPS else "nach",
                "t": item["t"].strip()[:100],
            })
    check_off: list[str] = []
    for item in src.get("checkOff") if isinstance(src.get("checkOff"), list) else []:
        if item in CHECK_IDS and item not in check_off:
            check_off.append(item)
    return {
        "custom": custom,
        "ovr": ovr,
        "check": {"date": _iso(check.get("date")),
                  "done": list(dict.fromkeys(x[:40] for x in done if isinstance(x, str)))[:100]},
        "checkCustom": check_custom[:50],
        "checkOff": check_off,
    }


# ----------------------------------------------------------------- log entries
def sanitize_entry(raw: Any, *, strict: bool) -> dict[str, Any]:
    """One entry of the watering log.

    strict: validate like Growplan's entry form (API saves). Imports are lenient and drop
    values that make no sense instead of rejecting the entry.
    """
    if not isinstance(raw, dict):
        raise GrowPlanError("Ungültiger Eintrag.")
    entry_id = raw.get("id")
    if not isinstance(entry_id, str) or not entry_id.strip() or len(entry_id) > 60:
        raise GrowPlanError("Eintrag ohne gültige Kennung.")
    day = _iso(raw.get("date"))
    if not day:
        raise GrowPlanError("Bitte ein Datum wählen")
    entry_type = raw.get("type") if raw.get("type") in ENTRY_TYPES else "water"
    ts = _num(raw.get("ts"), 0)
    plants = []
    for item in raw.get("plants") if isinstance(raw.get("plants"), list) else []:
        if isinstance(item, bool):
            continue
        plant_id = f"p{int(item) + 1}" if isinstance(item, (int, float)) else str(item)[:40]
        if plant_id not in plants:
            plants.append(plant_id)
    sched = raw.get("sched")
    entry: dict[str, Any] = {
        "id": entry_id[:60],
        "ts": int(ts) if ts is not None else int(time.time() * 1000),
        "date": day,
        "plants": plants[:50],
        "type": entry_type,
        "liters": None,
        "strength": _int(raw.get("strength"), 0, 200, 100),
        "sched": ({"id": _text(sched.get("id"), 60), "name": _text(sched.get("name"), 120)}
                  if isinstance(sched, dict) else None),
        "phase": raw.get("phase") if raw.get("phase") in PHASES else "veg",
        "week": _int(raw.get("week"), 1, 16, 1),
        "ecIn": None, "phIn": None, "ecOut": None, "phOut": None,
        "note": _text(raw.get("note"), 500),
        "tags": list(dict.fromkeys(t.strip()[:40] for t in (raw.get("tags") if isinstance(raw.get("tags"), list) else [])
                                   if isinstance(t, str) and t.strip()))[:20],
        "extra": [],
        "mix": [],
    }
    photo = raw.get("photo")
    if isinstance(photo, str) and PHOTO_ID.match(photo):
        entry["photo"] = photo
    bad_measure = False
    for key, high in (("ecIn", 10), ("ecOut", 10), ("phIn", 14), ("phOut", 14)):
        if raw.get(key) is None or raw.get(key) == "":
            continue
        number = _num(raw.get(key))
        if number is None or not 0 <= number <= high:
            bad_measure = True
            continue
        entry[key] = number
    if strict and bad_measure:
        raise GrowPlanError("EC (0–10) bzw. pH (0–14) bitte prüfen")
    if entry_type == "note":
        if strict and not entry["note"].strip() and not entry["tags"] and all(
                entry[k] is None for k in ("ecIn", "phIn", "ecOut", "phOut")):
            raise GrowPlanError("Bitte eine Notiz, Maßnahme oder Messung eintragen")
        return entry
    liters = _num(raw.get("liters"))
    if liters is not None and 0 < liters <= 500:
        entry["liters"] = liters
    elif strict:
        raise GrowPlanError("Bitte eine gültige Wassermenge angeben")
    for item in (raw.get("extra") if isinstance(raw.get("extra"), list) else [])[:20]:
        if not isinstance(item, dict):
            continue
        name = _text(item.get("n"), 40).strip()
        if not name:
            continue
        amount = None
        if item.get("a") is not None and item.get("a") != "":
            amount = _num(item.get("a"))
            if amount is None or not 0 <= amount <= 5000:
                if strict:
                    raise GrowPlanError("Bitte die Mengen bei den Zusätzen prüfen")
                amount = None
        entry["extra"].append({"n": name, "a": amount, "u": "g" if item.get("u") == "g" else "ml"})
    for item in (raw.get("mix") if isinstance(raw.get("mix"), list) else [])[:60]:
        if not isinstance(item, dict) or not _text(item.get("n"), 40).strip():
            continue
        value = _num(item.get("v"))
        color = item.get("c") if isinstance(item.get("c"), str) and COLOR.match(item["c"]) else None
        entry["mix"].append({"n": _text(item.get("n"), 40).strip(), "u": "g" if item.get("u") == "g" else "ml",
                             "v": value if value is not None and value >= 0 else None, "c": color})
    return entry


# ------------------------------------------------------------- phase and week
def auto_position(plan: dict[str, Any], today: date) -> tuple[str, int] | None:
    """Phase and week from the start dates, like Growplan does when the app opens."""
    flower = _date(plan.get("floStart"))
    veg = _date(plan.get("vegStart"))
    if flower and today >= flower:
        return "flower", max(1, min(plan["floWeeks"], (today - flower).days // 7 + 1))
    if veg and today >= veg:
        return "veg", max(1, min(plan["vegWeeks"], (today - veg).days // 7 + 1))
    return None


def current_position(plan: dict[str, Any], today: date) -> dict[str, Any]:
    auto = auto_position(plan, today)
    phase, week = auto if auto else (plan["phase"], plan["week"])
    return {"phase": phase, "week": week, "auto": auto is not None}


def stage_key(phase: str, week: int, flower_weeks: int) -> str:
    if phase == "seed":
        return "seed"
    if phase == "veg":
        return "veg1" if week <= 2 else "veg2"
    if week == flower_weeks:
        return "flush"
    if week <= 2:
        return "flo1"
    if week <= flower_weeks - 3:
        return "flo2"
    return "flo3"


def env_of(plan: dict[str, Any], key: str) -> dict[str, Any]:
    env = copy.deepcopy(ENV[key])
    env.update(copy.deepcopy((plan.get("envOv") or {}).get(key) or {}))
    return env


def svp(temp_c: float) -> float:
    return 0.61078 * math.exp(17.27 * temp_c / (temp_c + 237.3))


def plan_status(plan: dict[str, Any], today: date, last: dict[str, Any] | None = None) -> dict[str, Any]:
    pos = current_position(plan, today)
    key = stage_key(pos["phase"], pos["week"], plan["floWeeks"])
    flower = _date(plan.get("floStart"))
    if pos["phase"] == "seed":
        max_week = 2
    else:
        max_week = plan["vegWeeks"] if pos["phase"] == "veg" else plan["floWeeks"]
    return {
        **pos,
        "max_week": max_week,
        "stage": key,
        "stage_name": ENV[key]["n"],
        "env": env_of(plan, key),
        "harvest": (flower + timedelta(days=plan["floWeeks"] * 7)).isoformat() if flower else None,
        "last_watering": ({"date": last["date"], "type": last.get("type"), "liters": last.get("liters")}
                          if last else None),
    }


def control_targets(plan: dict[str, Any], today: date) -> dict[str, Any]:
    """Room control targets for the current week of a plan.

    Day and night temperature are the middle of Growplan's ranges, the tolerance is
    half the narrower range; humidity likewise. Growplan's VPD targets are leaf VPD
    (leaf cooler than the air by the offset of the VPD calculator), the devices and the
    room control work with the VPD of the air. The day target is therefore converted
    with the leaf offset at the day temperature. At night the leaf is about as warm as
    the air; the night target follows from night temperature and humidity.
    """
    pos = current_position(plan, today)
    key = stage_key(pos["phase"], pos["week"], plan["floWeeks"])
    env = env_of(plan, key)

    def mid(r: list[float]) -> float:
        return (r[0] + r[1]) / 2

    def half(r: list[float]) -> float:
        return (r[1] - r[0]) / 2

    def clamp(value: float, low: float, high: float) -> float:
        return max(low, min(high, value))

    humi = clamp(mid(env["rh"]), 20, 95)
    leaf = float(plan.get("leafOff") or 0)
    day_temp = mid(env["tag"])
    day_vpd = mid(env["vpd"]) + svp(day_temp) - svp(day_temp - leaf)
    night_vpd = svp(mid(env["nacht"])) * (1 - mid(env["rh"]) / 100)
    # rounded half up like the frontend (Math.round), so both show the same targets
    return {
        "temp": {"day": _round(clamp(mid(env["tag"]), 5, 40), 1), "night": _round(clamp(mid(env["nacht"]), 5, 40), 1),
                 "tolerance": _round(clamp(min(half(env["tag"]), half(env["nacht"])), 0.2, 10), 1)},
        "humi": {"day": _round(humi, 0), "night": _round(humi, 0), "tolerance": _round(clamp(half(env["rh"]), 1, 30), 0)},
        "vpd": {"day": _round(clamp(day_vpd, 0.2, 3), 2), "night": _round(clamp(night_vpd, 0.2, 3), 2),
                "tolerance": _round(clamp(half(env["vpd"]), 0.02, 1), 2)},
        "stage": key, "stage_name": ENV[key]["n"], "phase": pos["phase"], "week": pos["week"],
        "light_hours": env["h"], "leaf_offset": leaf, "leaf_vpd": env["vpd"],
    }


def plan_bands(plan: dict[str, Any], today: date) -> dict[str, Any]:
    """Target ranges of the current week to compare with what the sensors measure.

    Same as the overview (frontend engine.planBands): temperature, humidity and PPFD as the
    plan states them; the leaf VPD range shifted to air VPD with the leaf offset at the
    middle of the day temperature, at night the range around the room control's night VPD.
    """
    targets = control_targets(plan, today)
    env = env_of(plan, targets["stage"])
    day_temp = (env["tag"][0] + env["tag"][1]) / 2
    shift = svp(day_temp) - svp(day_temp - float(targets["leaf_offset"]))

    def edge(value: float) -> float:
        return _round(max(0.0, value), 2)

    night, tolerance = targets["vpd"]["night"], targets["vpd"]["tolerance"]
    return {
        "stage": targets["stage"], "stage_name": targets["stage_name"], "phase": targets["phase"],
        "week": targets["week"], "light_hours": env["h"], "leaf_offset": targets["leaf_offset"],
        "temp": {"day": list(env["tag"]), "night": list(env["nacht"])},
        "humi": {"day": list(env["rh"]), "night": list(env["rh"])},
        "vpd": {"day": [edge(env["vpd"][0] + shift), edge(env["vpd"][1] + shift)],
                "night": [edge(night - tolerance), edge(night + tolerance)]},
        "ppfd": list(env["ppfd"]),
    }


def plan_for_next_grow(plan: dict[str, Any]) -> dict[str, Any]:
    """The plan after a harvest: schedule, lamp, tent and climate settings stay, the grow starts over."""
    fresh = copy.deepcopy(plan)
    fresh.update({"phase": "seed", "week": 1, "vegStart": "", "floStart": "", "luxIn": ""})
    fresh["plants"] = [{**p, "start": "", "note": "", "gone": False} for p in plan.get("plants", []) if not p.get("gone")]
    for plant in fresh["plants"]:
        plant.pop("gone", None)
    return sanitize_plan(fresh)


# ------------------------------------------------------------------ CSV export
TYPE_LBL = {"feed": "Dünger", "water": "Nur Wasser", "flush": "Spülen", "note": "Notiz"}
PHASE_LBL = {"seed": "Anzucht", "veg": "Wachstum", "flower": "Blüte"}
CSV_HEADER = ["Datum", "Art", "Pflanzen", "Phase", "Woche", "Schema", "Liter", "Stärke %", "EC Gießwasser",
              "pH Gießwasser", "EC Drain", "pH Drain", "Dünger laut Schema", "Zusätzlich gegeben", "Maßnahmen", "Notiz"]


def _js(value: Any, lang: str = "de") -> str:
    """A number written like JavaScript's String(): 5 not 5.0, German decimal comma."""
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return str(value) if lang == "en" else str(value).replace(".", ",")


def _num_de(value: float, decimals: int, lang: str = "de") -> str:
    return _js(_round(value, decimals), lang)


def _csv_cell(value: Any, sep: str = ";") -> str:
    text = "" if value is None else str(value)
    if sep in text or re.search(r'["\r\n]', text):
        text = '"' + text.replace('"', '""') + '"'
    return text


def _plants_label(plan: dict[str, Any], entry: dict[str, Any], lang: str = "de") -> str:
    if not entry.get("plants"):
        return tr("Alle Pflanzen", lang)
    names = {p["id"]: p["name"] for p in plan.get("plants", [])}
    return ", ".join(names.get(pid, tr("unbekannte Pflanze", lang)) for pid in entry["plants"])


def _mix_text(entry: dict[str, Any], lang: str = "de") -> str:
    if entry.get("type") not in ("feed", "flush") or not entry.get("mix"):
        return ""
    factor = (entry.get("strength") or 100) / 100
    liters = entry.get("liters") or 0
    return ", ".join(f"{tr(x['n'], lang)} {'?' if x.get('v') is None else _num_de(x['v'] * factor * liters, 1, lang)} "
                     f"{x['u']}" for x in entry["mix"])


def _extra_text(entry: dict[str, Any], lang: str = "de") -> str:
    return ", ".join(tr(x["n"], lang) + (f" {_num_de(x['a'], 1, lang)} {x['u']}" if x.get("a") is not None else "")
                     for x in entry.get("extra") or [])


def log_csv(plan: dict[str, Any], log_newest_first: list[dict[str, Any]], lang: str = "de") -> str:
    """The watering log as CSV like the Growplan app writes it (semicolons, BOM for Excel).

    In English: commas between the fields and decimal points, texts translated."""
    sep = "," if lang == "en" else ";"
    rows = [[tr(h, lang) for h in CSV_HEADER]]
    for e in reversed(log_newest_first):
        feeding = e.get("type") in ("feed", "flush")
        rows.append([
            e["date"], tr(TYPE_LBL.get(e.get("type"), e.get("type")), lang), _plants_label(plan, e, lang),
            tr(PHASE_LBL.get(e.get("phase"), ""), lang),
            "" if e.get("phase") == "seed" else e.get("week"), tr((e.get("sched") or {}).get("name", ""), lang),
            "" if e.get("type") == "note" else _js(e.get("liters"), lang), e.get("strength") if feeding else "",
            _js(e.get("ecIn"), lang), _js(e.get("phIn"), lang), _js(e.get("ecOut"), lang), _js(e.get("phOut"), lang),
            _mix_text(e, lang), _extra_text(e, lang), ", ".join(tr(x, lang) for x in e.get("tags") or []),
            e.get("note") or "",
        ])
    return "\ufeff" + "\r\n".join(sep.join(_csv_cell(c, sep) for c in row) for row in rows)


def file_slug(text: str) -> str:
    text = (text or "growplan").lower()
    for a, b in (("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("ß", "ss")):
        text = text.replace(a, b)
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-") or "growplan"


# --------------------------------------------------------------------- service
class GrowPlanService:
    def __init__(self, db: Database, bus: EventBus, tz: str) -> None:
        self.db = db
        self.bus = bus
        self.tz = ZoneInfo(tz)
        self.plans: dict[str, dict[str, Any]] = {}
        self.library: dict[str, Any] = sanitize_library(None)
        self._meta: dict[str, tuple[int, dict[str, Any] | None]] = {}
        # change counter per plan (settings or log), lets open pages reload changes from elsewhere
        self._rev: dict[str, int] = {}
        self._task: asyncio.Task | None = None
        self._lock = asyncio.Lock()
        self.on_change: Callable[[], None] | None = None

    async def start(self) -> None:
        for record in await self.db.list_growplans():
            record["data"] = sanitize_plan(record["data"])
            self.plans[record["id"]] = record
            self._meta[record["id"]] = await self.db.growlog_meta(record["id"])
        self.library = sanitize_library(await self.db.get_setting("growplan_library", None))
        self._task = asyncio.create_task(self._midnight_loop(), name="growplan-day")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _midnight_loop(self) -> None:
        """Phase and week move on at midnight; tell the clients."""
        while True:
            now = datetime.now(self.tz)
            tomorrow = datetime.combine(now.date() + timedelta(days=1), datetime.min.time(), tzinfo=self.tz)
            await asyncio.sleep(max(60.0, (tomorrow - now).total_seconds() + 5))
            if self.plans:
                self.publish()
                if self.on_change:
                    self.on_change()

    def today(self) -> date:
        return datetime.now(self.tz).date()

    # ---------------------------------------------------------------- queries
    def summary(self, record: dict[str, Any]) -> dict[str, Any]:
        count, last = self._meta.get(record["id"], (0, None))
        return {
            "id": record["id"], "room_id": record.get("room_id"), "name": record.get("name") or "",
            "created": record["created"], "updated": record["updated"], "entries": count,
            "rev": self._rev.get(record["id"], 0),
            "data": record["data"], "status": plan_status(record["data"], self.today(), last),
        }

    def summaries(self) -> list[dict[str, Any]]:
        return [self.summary(r) for r in sorted(self.plans.values(), key=lambda r: r["created"])]

    def publish(self, library: bool = False) -> None:
        payload: dict[str, Any] = {"plans": self.summaries()}
        if library:
            payload["library"] = self.library
        self.bus.publish("growplan", payload)

    def get(self, plan_id: str) -> dict[str, Any]:
        record = self.plans.get(plan_id)
        if record is None:
            raise KeyError(plan_id)
        return record

    def for_room(self, room_id: str) -> dict[str, Any] | None:
        return next((r for r in self.plans.values() if r.get("room_id") == room_id), None)

    def plan_for_tent(self, room_id: str, rooms_exist: bool) -> dict[str, Any] | None:
        """The plan of a room; without any room the plan without a tent (latest) stands for all devices."""
        if room_id != "alle":
            return self.for_room(room_id)
        if rooms_exist:
            return None
        loose = [r for r in self.plans.values() if not r.get("room_id")]
        return max(loose, key=lambda r: r["updated"]) if loose else None

    def targets_for_room(self, room_id: str) -> dict[str, Any] | None:
        record = self.for_room(room_id)
        if record is None:
            return None
        return {"plan_id": record["id"], **control_targets(record["data"], self.today())}

    # -------------------------------------------------------------- changes
    def _changed(self, library: bool = False, plan_id: str | None = None) -> None:
        if plan_id is not None:
            self._rev[plan_id] = self._rev.get(plan_id, 0) + 1
        self.publish(library)
        if self.on_change:
            self.on_change()

    async def create(self, room_id: str | None, name: str, data: Any = None) -> dict[str, Any]:
        async with self._lock:
            if len(self.plans) >= MAX_PLANS:
                raise GrowPlanError(f"Höchstens {MAX_PLANS} Pläne.")
            if room_id and self.for_room(room_id):
                raise GrowPlanError("Dieses Zelt hat schon einen Growplan.")
            now = int(time.time())
            record = {"id": f"gp-{secrets.token_hex(4)}", "room_id": room_id or None,
                      "name": (name or "").strip()[:60] or "Mein Grow",
                      "data": sanitize_plan(data), "created": now, "updated": now}
            await self.db.save_growplan(record)
            self.plans[record["id"]] = record
            self._meta[record["id"]] = (0, None)
        self._changed(plan_id=record["id"])
        return record

    async def update(self, plan_id: str, data: Any = None, name: str | None = None) -> dict[str, Any]:
        async with self._lock:
            record = self.get(plan_id)
            if data is not None:
                record["data"] = sanitize_plan(data)
            if name is not None:
                record["name"] = name.strip()[:60] or record.get("name") or "Mein Grow"
            record["updated"] = int(time.time())
            await self.db.save_growplan(record)
        self._changed(plan_id=plan_id)
        return record

    async def assign(self, plan_id: str, room_id: str | None) -> dict[str, Any]:
        async with self._lock:
            record = self.get(plan_id)
            if room_id:
                other = self.for_room(room_id)
                if other is not None and other["id"] != plan_id:
                    raise GrowPlanError("Dieses Zelt hat schon einen Growplan. Löse ihn dort zuerst.")
            record["room_id"] = room_id or None
            record["updated"] = int(time.time())
            await self.db.save_growplan(record)
        self._changed(plan_id=plan_id)
        return record

    async def room_deleted(self, room_id: str) -> None:
        for record in self.plans.values():
            if record.get("room_id") == room_id:
                record["room_id"] = None
                self._changed(plan_id=record["id"])

    async def delete(self, plan_id: str) -> None:
        async with self._lock:
            self.get(plan_id)
            await self.db.delete_growplan(plan_id)
            self.plans.pop(plan_id, None)
            self._meta.pop(plan_id, None)
            self._rev.pop(plan_id, None)
        self._changed()

    async def log(self, plan_id: str) -> list[dict[str, Any]]:
        self.get(plan_id)
        return await self.db.list_growlog(plan_id)

    async def _log_changed(self, plan_id: str) -> None:
        self._meta[plan_id] = await self.db.growlog_meta(plan_id)
        self._changed(plan_id=plan_id)

    async def save_entry(self, plan_id: str, raw: Any) -> dict[str, Any]:
        self.get(plan_id)
        entry = sanitize_entry(raw, strict=True)
        count, _ = self._meta.get(plan_id, (0, None))
        if count >= MAX_LOG and entry["id"] not in await self.db.growlog_ids(plan_id):
            raise GrowPlanError(f"Das Protokoll ist voll ({MAX_LOG} Einträge).")
        await self.db.save_growlog(plan_id, [entry])
        await self._log_changed(plan_id)
        return entry

    async def delete_entry(self, plan_id: str, entry_id: str) -> bool:
        self.get(plan_id)
        deleted = await self.db.delete_growlog(plan_id, entry_id) > 0
        await self._log_changed(plan_id)
        return deleted

    async def clear_log(self, plan_id: str) -> int:
        self.get(plan_id)
        deleted = await self.db.delete_growlog(plan_id)
        await self._log_changed(plan_id)
        return deleted

    async def save_library(self, patch: Any) -> dict[str, Any]:
        if not isinstance(patch, dict):
            raise GrowPlanError("Ungültige Daten.")
        async with self._lock:
            merged = {**self.library, **{k: v for k, v in patch.items() if k in LIBRARY_KEYS}}
            self.library = sanitize_library(merged)
            await self.db.set_setting("growplan_library", self.library)
        self._changed(library=True)
        return self.library

    # ------------------------------------------------------- backup exchange
    async def import_backup(self, plan_id: str, backup: Any) -> dict[str, Any]:
        """Merge a Growplan backup (format 2) into a plan, as the app does.

        Entries with the same id are updated, new ones added; custom schedules and
        adjusted built-in schedules go into the shared library. The settings of the
        backup are taken over only while the plan's log is still empty.
        """
        record = self.get(plan_id)
        if not isinstance(backup, dict) or backup.get("app") != "growplan" or not isinstance(backup.get("log"), list):
            raise GrowPlanError("Kein Growplan-Backup.")
        known = await self.db.growlog_ids(plan_id)
        was_empty = not known
        entries: dict[str, dict[str, Any]] = {}
        skipped = 0
        for raw in backup["log"][:MAX_LOG]:
            try:
                entry = sanitize_entry(raw, strict=False)
            except GrowPlanError:
                skipped += 1
                continue
            entries[entry["id"]] = entry
        if len(known | set(entries)) > MAX_LOG:
            raise GrowPlanError(f"Zu viele Einträge: höchstens {MAX_LOG} pro Plan.")
        added = sum(1 for entry_id in entries if entry_id not in known)
        library = copy.deepcopy(self.library)
        customs = {c["id"]: c for c in library["custom"]}
        custom_count = 0
        for item in backup.get("custom") if isinstance(backup.get("custom"), list) else []:
            sched = sanitize_schedule(item, custom=True)
            if sched and sched["id"] not in BUILTIN_IDS:
                customs[sched["id"]] = sched
                custom_count += 1
        library["custom"] = list(customs.values())
        ovr_count = 0
        if isinstance(backup.get("ovr"), dict):
            for sched_id, item in backup["ovr"].items():
                if sched_id in BUILTIN_IDS:
                    sched = sanitize_schedule(item, custom=False, sched_id=sched_id)
                    if sched:
                        library["ovr"][sched_id] = sched
                        ovr_count += 1
        settings = backup.get("settings") if isinstance(backup.get("settings"), dict) else None
        settings_applied = bool(was_empty and settings)
        if settings_applied:
            data = {**record["data"], **{k: v for k, v in settings.items() if k in PLAN_KEYS}}
            for key in ("check", "checkCustom", "checkOff"):
                if key in settings:
                    library[key] = settings[key]
        async with self._lock:
            if entries:
                await self.db.save_growlog(plan_id, list(entries.values()))
            self.library = sanitize_library(library)
            await self.db.set_setting("growplan_library", self.library)
            if settings_applied:
                record["data"] = sanitize_plan(data)
            record["updated"] = int(time.time())
            await self.db.save_growplan(record)
            self._meta[plan_id] = await self.db.growlog_meta(plan_id)
        self._changed(library=True, plan_id=plan_id)
        return {"added": added, "updated": len(entries) - added, "skipped": skipped,
                "custom": custom_count, "ovr": ovr_count, "settings": settings_applied}

    async def export_backup(self, plan_id: str) -> dict[str, Any]:
        """The plan as a Growplan backup (format 2) that the Android app can load."""
        record = self.get(plan_id)
        settings = {"view": "heute", "theme": "", "logFilter": "", **copy.deepcopy(record["data"]),
                    "check": copy.deepcopy(self.library["check"]),
                    "checkCustom": copy.deepcopy(self.library["checkCustom"]),
                    "checkOff": list(self.library["checkOff"])}
        log = await self.db.list_growlog(plan_id)
        log.reverse()  # oldest first, like the app appends them
        return {"app": "growplan", "format": 2,
                "exported": datetime.now(ZoneInfo("UTC")).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                "settings": settings, "log": log, "custom": copy.deepcopy(self.library["custom"]),
                "ovr": copy.deepcopy(self.library["ovr"])}

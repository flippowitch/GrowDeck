"""Tests the English texts of the server (dictionary, pattern matching, CSV export).

    cd backend && python tests/test_i18n.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import i18n  # noqa: E402
from app.growplan import default_plan, log_csv  # noqa: E402
from app.i18n import tr  # noqa: E402

ok = 0
DICT = Path(__file__).resolve().parents[2] / "frontend" / "src" / "i18n" / "en.json"


def check(condition: bool, label: str) -> None:
    global ok
    if not condition:
        raise AssertionError(label)
    ok += 1


def test_dictionary() -> None:
    data = json.loads(DICT.read_text(encoding="utf-8"))
    check(len(data) > 1500, f"dictionary has {len(data)} entries")
    empty = [k for k, v in data.items() if not isinstance(v, str) or (not v.strip() and k.strip())]
    check(not empty, f"empty translations: {empty[:5]}")
    wrong = [k for k, v in data.items()
             if sorted(re.findall(r"\{(\w+)\}", k)) != sorted(re.findall(r"\{(\w+)\}", v))]
    check(not wrong, f"placeholders differ: {wrong[:5]}")


def test_translate() -> None:
    i18n.reload()
    check(tr("Gerät nicht gefunden.", "de") == "Gerät nicht gefunden.", "German stays German")
    check(tr("Gerät nicht gefunden.", "en") == "Device not found.", "exact")
    check(tr("GGS Controller ist offline.", "en") == "GGS Controller is offline.", "pattern")
    check(tr("Steckdose 3", "en") == "Outlet 3", "label pattern")
    check(tr("Temperatur · Luftfeuchte", "en") == "Temperature · Humidity", "parts joined by ·")
    check(tr("Unbekannter Text, den es nicht gibt", "en") == "Unbekannter Text, den es nicht gibt", "unknown stays")
    check(tr("", "en") == "" and tr(None, "en") is None, "empty")
    event = "„Nachtlüfter“ schaltet Steckdose 2 an GGS Power Strip AC5 0002: Ein"
    check(tr(event, "en") == "“Nachtlüfter” switches Outlet 2 on GGS Power Strip AC5 0002: On",
          f"nested translation: {tr(event, 'en')}")
    check(tr("Zeltsteuerung Zelt 1: Befeuchter (Befeuchter, AeroStream H19) aus, Luftfeuchte im Zielbereich", "en")
          == "Tent control Zelt 1: Humidifier (Humidifier, AeroStream H19) off, humidity in range", "tent control event")
    check(i18n.clean_language("en") == "en" and i18n.clean_language("fr") == i18n.DEFAULT_LANGUAGE, "languages")


def test_csv() -> None:
    plan = default_plan()
    log = [{"id": "e1", "date": "2026-09-20", "type": "feed", "phase": "flower", "week": 2, "liters": 5.5,
            "strength": 100, "ecIn": 1.4, "phIn": 6.2, "plants": [], "tags": ["Getoppt"], "note": "ok, gut",
            "mix": [{"n": "Bio-Bloom", "v": 2, "u": "ml"}]}]
    de = log_csv(plan, log).lstrip("﻿").split("\r\n")
    check(de[0].startswith("Datum;Art;Pflanzen;Phase;Woche") and ";5,5;" in de[1] and "Blüte" in de[1],
          f"German CSV unchanged: {de}")
    en = log_csv(plan, log, "en").lstrip("﻿").split("\r\n")
    check(en[0].startswith("Date,Type,Plants,Stage,Week") or en[0].startswith("Date,Type,Plants"), f"English header: {en[0]}")
    check(",5.5," in en[1] and "All plants" in en[1] and "Nutrients" in en[1] and '"ok, gut"' in en[1],
          f"English row: {en[1]}")
    check("Blüte" not in en[1] and "Getoppt" not in en[1], "values translated")


if __name__ == "__main__":
    test_dictionary()
    test_translate()
    test_csv()
    print(f"i18n: {ok} checks ok")

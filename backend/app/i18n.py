"""English for texts the server sends out itself (Telegram, web address, CSV exports).

GrowDeck works in German internally. The dictionary is the one the web page uses
(frontend/src/i18n/en.json, copied into the image as app/i18n_en.json): German text -> English.
Keys with {placeholders} also work as patterns, so "GGS Controller ist offline." is found via
"{name} ist offline.". Captured parts are translated again and German decimal commas become
points. Texts joined by " · " or line breaks are translated piece by piece.
"""

from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path
from typing import Any

_LOGGER = logging.getLogger(__name__)

LANGUAGES = ("de", "en")
_env = (os.environ.get("GD_LANGUAGE") or "de").strip().lower()[:2]
DEFAULT_LANGUAGE = _env if _env in LANGUAGES else "de"

_CANDIDATES = (
    Path(__file__).with_name("i18n_en.json"),
    Path(__file__).resolve().parents[2] / "frontend" / "src" / "i18n" / "en.json",
)
_PLACEHOLDER = re.compile(r"\{(\w+)\}")
_NUMERIC = re.compile(r"^[\d\s.,–+\-/:%]+$")
_HAS_LETTER = re.compile(r"[A-Za-zÄÖÜäöüß]")

_dict: dict[str, str] | None = None
_patterns: list[tuple[re.Pattern[str], list[str], str, str]] = []
_cache: dict[str, str] = {}


def _load() -> dict[str, str]:
    global _dict
    if _dict is not None:
        return _dict
    _dict = {}
    for path in _CANDIDATES:
        try:
            if path.is_file():
                _dict = json.loads(path.read_text(encoding="utf-8"))
                break
        except (OSError, ValueError) as err:
            _LOGGER.warning("English texts could not be read from %s: %s", path, err)
    patterns = []
    for key, en in _dict.items():
        if "{" not in key:
            continue
        names: list[str] = []
        literals: list[str] = []
        source, last = "", 0
        for m in _PLACEHOLDER.finditer(key):
            literal = key[last:m.start()]
            literals.append(literal)
            source += re.escape(literal) + "(.*?)"
            names.append(m.group(1))
            last = m.end()
        literals.append(key[last:])
        source += re.escape(key[last:])
        words = "".join(literals)
        if not names or not _HAS_LETTER.search(words):
            continue
        longest = max(literals, key=len)
        patterns.append((re.compile(source, re.S), names, en, longest, len(words)))
    patterns.sort(key=lambda p: -p[4])
    _patterns[:] = [p[:4] for p in patterns]
    return _dict


def reload() -> None:
    """For tests: read the dictionary again."""
    global _dict
    _dict = None
    _cache.clear()
    _load()


def _english_numbers(text: str) -> str:
    return re.sub(r"(\d),(\d)", r"\1.\2", text)


def _interpolate(text: str, values: dict[str, str]) -> str:
    return _PLACEHOLDER.sub(lambda m: values.get(m.group(1), m.group(0)), text)


def _part(text: str, depth: int) -> str:
    if _NUMERIC.match(text):
        return _english_numbers(text)
    if depth >= 3:
        return text
    hit = _load().get(text)
    if hit is not None:
        return hit
    return _dynamic(text, depth + 1)


def _dynamic(text: str, depth: int) -> str:
    if depth == 0 and text in _cache:
        return _cache[text]
    result = text
    for regex, names, en, longest in _patterns:
        if longest and longest not in text:
            continue
        m = regex.fullmatch(text)
        if not m:
            continue
        result = _interpolate(en, {name: _part(m.group(i + 1), depth) for i, name in enumerate(names)})
        break
    else:
        for sep in ("\n", " · "):
            if sep in text:
                result = sep.join(_part(p, depth) for p in text.split(sep))
                break
    if depth == 0:
        if len(_cache) > 5000:
            _cache.clear()
        _cache[text] = result
    return result


def tr(text: Any, lang: str | None) -> Any:
    """`text` in the language `lang` ('de' returns it unchanged)."""
    if lang != "en" or not isinstance(text, str) or not text:
        return text
    hit = _load().get(text)
    if hit is not None:
        return hit
    return _dynamic(text, 0)


def clean_language(value: Any) -> str:
    return value if value in LANGUAGES else DEFAULT_LANGUAGE


async def server_language(db: Any) -> str:
    """Language of notifications (Optionen → Benachrichtigungen)."""
    return clean_language(await db.get_setting("language", None))

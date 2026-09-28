# Vendored AC Infinity cloud client

Source: https://github.com/dalinicus/homeassistant-acinfinity (MIT, see LICENSE)
Commit: 4134e959e146630eea70897d79ffb6157972537b (integration version 2.3.1)

Files: `client.py` and `const.py` from `custom_components/ac_infinity/`.

Changes for GrowDeck:
- Home Assistant imports removed (`Platform`, `HomeAssistantError`).
- `asyncio.timeout` replaces the async-timeout package.
- Exceptions derive from `ACInfinityError`.

Everything else, including the API endpoints and request encoding, is unchanged
so that upstream fixes can be merged by diffing against the commit above.

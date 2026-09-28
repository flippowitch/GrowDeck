# Vendored code

Source: https://github.com/lientry/homeassistant-vivosun-growhub (MIT License, see LICENSE)
Commit: see UPSTREAM_COMMIT

Vendored files: api.py, aws_auth.py, encryption.py, mqtt_client.py, models.py,
exceptions.py, redaction.py, const.py

Local modifications:
- const.py: removed the Home Assistant import and the PLATFORMS list.
- api.py: added `get_point_log_raw()` which returns the complete newest
  point-log row instead of a fixed key subset.

Everything else is unchanged so that upstream fixes can be merged easily.
- mqtt_client.py: diagnostics only, no protocol change. The client records
  `last_error` (why the session ended), `connected_at` and `last_published`, and
  logs websocket close frames at WARNING level instead of a generic traceback.

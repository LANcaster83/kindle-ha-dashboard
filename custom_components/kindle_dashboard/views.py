"""HTTP endpoints used by the Kindle script.

Both views accept either a normal Home Assistant authenticated request or the
per-entry device token passed as ``?token=``, ``X-Kindle-Token`` or
``Authorization: Bearer``. Kindle firmware ships a busybox wget without HTTPS,
so the token-in-query form is the one the shipped script uses.
"""

from __future__ import annotations

import hmac
import json
import logging
from typing import Any

from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant
from homeassistant.helpers.http import KEY_AUTHENTICATED, KEY_HASS

from .api import KindleDashApiError
from .const import CONF_DEVICE_TOKEN, DOMAIN, IMAGE_PATH, STATUS_PATH
from .coordinator import KindleConfigEntry

_LOGGER = logging.getLogger(__name__)

MAX_STATUS_BODY = 16 * 1024


def _presented_tokens(request: web.Request) -> list[str]:
    tokens: list[str] = []
    if query := request.query.get("token"):
        tokens.append(query)
    if header := request.headers.get("X-Kindle-Token"):
        tokens.append(header)
    auth = request.headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        tokens.append(auth[7:].strip())
    return tokens


def _loaded_entries(hass: HomeAssistant) -> list[KindleConfigEntry]:
    return [entry for entry in hass.config_entries.async_entries(DOMAIN) if hasattr(entry, "runtime_data")]


def _resolve_entry(request: web.Request) -> KindleConfigEntry | None:
    """Return the config entry this request is allowed to use, or None."""
    hass: HomeAssistant = request.app[KEY_HASS]
    entries = _loaded_entries(hass)
    if not entries:
        return None
    presented = _presented_tokens(request)
    for entry in entries:
        expected = entry.data.get(CONF_DEVICE_TOKEN, "")
        if expected and any(hmac.compare_digest(expected, candidate) for candidate in presented):
            return entry
    if request.get(KEY_AUTHENTICATED, False):
        wanted = request.query.get("entry_id")
        for entry in entries:
            if wanted is None or entry.entry_id == wanted:
                return entry
    return None


class KindleImageView(HomeAssistantView):
    """Proxy the renderer PNG to the Kindle."""

    url = IMAGE_PATH
    name = f"api:{DOMAIN}:image"
    requires_auth = False

    async def get(self, request: web.Request) -> web.StreamResponse:
        """Return the latest dashboard PNG."""
        entry = _resolve_entry(request)
        if entry is None:
            return self.json_message("Unauthorized", 401)
        runtime = entry.runtime_data
        fresh = request.query.get("render") == "1"
        try:
            body, headers = await runtime.api.image(fresh=fresh)
        except KindleDashApiError as err:
            _LOGGER.warning("Image fetch failed: %s", err)
            return self.json_message(str(err), 502)
        runtime.coordinator.mark_image_fetched()
        response = web.Response(body=body, content_type="image/png")
        response.headers["Cache-Control"] = "no-cache"
        for key, value in headers.items():
            response.headers[key] = value
        return response


class KindleStatusView(HomeAssistantView):
    """Receive battery and health reports from the Kindle."""

    url = STATUS_PATH
    name = f"api:{DOMAIN}:status"
    requires_auth = False

    async def post(self, request: web.Request) -> web.Response:
        """Store a status report."""
        entry = _resolve_entry(request)
        if entry is None:
            return self.json_message("Unauthorized", 401)
        if request.content_length is not None and request.content_length > MAX_STATUS_BODY:
            return self.json_message("Payload too large", 413)
        payload: dict[str, Any] = {}
        raw = await request.read()
        if raw:
            try:
                data = json.loads(raw.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                return self.json_message("Invalid JSON", 400)
            if not isinstance(data, dict):
                return self.json_message("Expected a JSON object", 400)
            payload = data
        # Also accept form/query parameters for the simplest wget one-liners.
        for key in ("battery", "charging", "uptime", "firmware", "rssi", "free_mem", "message"):
            if key in request.query and key not in payload:
                payload[key] = _coerce(request.query[key])
        entry.runtime_data.coordinator.update_from_kindle(payload)
        return self.json({"ok": True})


def _coerce(value: str) -> Any:
    lowered = value.strip().lower()
    if lowered in ("true", "false"):
        return lowered == "true"
    try:
        return int(lowered)
    except ValueError:
        return value

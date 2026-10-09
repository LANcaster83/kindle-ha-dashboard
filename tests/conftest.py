"""Shared fixtures."""

from __future__ import annotations

from collections.abc import Generator
from typing import Any

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.kindle_dashboard.const import (
    CONF_ADDON_TOKEN,
    CONF_ADDON_URL,
    CONF_DEVICE_NAME,
    CONF_DEVICE_TOKEN,
    DOMAIN,
)

RENDERER_URL = "http://renderer.test:8080"
DEVICE_TOKEN = "kindle-device-token-123"

STATUS_OK: dict[str, Any] = {
    "ok": True,
    "rendering": False,
    "last_render": "2026-10-08T12:00:00.000Z",
    "last_duration_ms": 4200,
    "last_error": None,
    "last_error_at": None,
    "render_count": 3,
    "error_count": 0,
    "image_width": 1264,
    "image_height": 1680,
    "image_bytes": 250000,
    "interval_seconds": 60,
    "next_render": "2026-10-08T12:01:00.000Z",
    "uptime_seconds": 180,
    "version": "0.1.0",
}

PNG_BYTES = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108000000003a7e9b550000000a4944415408d76360000000020001e221bc330000000049454e44ae426082"
)


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations: None) -> Generator[None]:
    """Enable loading custom integrations in all tests."""
    yield


@pytest.fixture
def mock_entry() -> MockConfigEntry:
    """Return a config entry pointing at the mocked renderer."""
    return MockConfigEntry(
        domain=DOMAIN,
        title="Kindle",
        unique_id=RENDERER_URL,
        data={
            CONF_DEVICE_NAME: "Kindle",
            CONF_ADDON_URL: RENDERER_URL,
            CONF_ADDON_TOKEN: "",
            CONF_DEVICE_TOKEN: DEVICE_TOKEN,
        },
    )

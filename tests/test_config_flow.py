"""Config flow tests."""

from __future__ import annotations

from homeassistant import config_entries
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMocker

from custom_components.kindle_dashboard.const import (
    CONF_ADDON_TOKEN,
    CONF_ADDON_URL,
    CONF_DEVICE_NAME,
    CONF_DEVICE_TOKEN,
    DOMAIN,
)

from .conftest import DEVICE_TOKEN, RENDERER_URL, STATUS_OK


async def test_user_flow_success(hass: HomeAssistant, aioclient_mock: AiohttpClientMocker) -> None:
    """A reachable renderer creates an entry."""
    aioclient_mock.get(f"{RENDERER_URL}/status", json=STATUS_OK)
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {}
    # The device token is pre-generated for the user.
    schema_defaults = {
        str(k): k.default() for k in result["data_schema"].schema if callable(getattr(k, "default", None))
    }
    assert len(schema_defaults[CONF_DEVICE_TOKEN]) >= 24

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        {
            CONF_DEVICE_NAME: "Kuchnia",
            CONF_ADDON_URL: f"{RENDERER_URL}/",
            CONF_ADDON_TOKEN: "",
            CONF_DEVICE_TOKEN: DEVICE_TOKEN,
        },
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "Kuchnia"
    assert result["data"][CONF_ADDON_URL] == RENDERER_URL
    assert result["data"][CONF_DEVICE_TOKEN] == DEVICE_TOKEN


async def test_user_flow_errors(hass: HomeAssistant, aioclient_mock: AiohttpClientMocker) -> None:
    """Connection and validation errors are reported on the form."""
    aioclient_mock.get("http://down.test:8080/status", exc=OSError("boom"))
    aioclient_mock.get("http://locked.test:8080/status", status=401)
    aioclient_mock.get(f"{RENDERER_URL}/status", json=STATUS_OK)

    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    base = {CONF_DEVICE_NAME: "Kindle", CONF_ADDON_TOKEN: "", CONF_DEVICE_TOKEN: DEVICE_TOKEN}

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {**base, CONF_ADDON_URL: "http://down.test:8080"}
    )
    assert result["errors"] == {"base": "cannot_connect"}

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {**base, CONF_ADDON_URL: "http://locked.test:8080"}
    )
    assert result["errors"] == {CONF_ADDON_TOKEN: "invalid_auth"}

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {**base, CONF_ADDON_URL: "renderer:8080"}
    )
    assert result["errors"] == {CONF_ADDON_URL: "invalid_url"}

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {**base, CONF_ADDON_URL: RENDERER_URL, CONF_DEVICE_TOKEN: "short"}
    )
    assert result["errors"] == {CONF_DEVICE_TOKEN: "token_too_short"}

    result = await hass.config_entries.flow.async_configure(result["flow_id"], {**base, CONF_ADDON_URL: RENDERER_URL})
    assert result["type"] is FlowResultType.CREATE_ENTRY

    # Same renderer twice is aborted.
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {**base, CONF_ADDON_URL: RENDERER_URL})
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"


async def test_options_flow_updates_tokens(hass: HomeAssistant, aioclient_mock: AiohttpClientMocker) -> None:
    """The options flow rewrites entry data so the HTTP views see the new device token."""
    aioclient_mock.get(f"{RENDERER_URL}/status", json=STATUS_OK)
    entry = MockConfigEntry(
        domain=DOMAIN,
        unique_id=RENDERER_URL,
        data={
            CONF_DEVICE_NAME: "Kindle",
            CONF_ADDON_URL: RENDERER_URL,
            CONF_ADDON_TOKEN: "",
            CONF_DEVICE_TOKEN: DEVICE_TOKEN,
        },
    )
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    result = await hass.config_entries.options.async_init(entry.entry_id)
    assert result["type"] is FlowResultType.FORM
    result = await hass.config_entries.options.async_configure(
        result["flow_id"],
        {CONF_ADDON_URL: RENDERER_URL, CONF_ADDON_TOKEN: "srv", CONF_DEVICE_TOKEN: "new-device-token"},
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    assert entry.data[CONF_DEVICE_TOKEN] == "new-device-token"
    assert entry.data[CONF_ADDON_TOKEN] == "srv"

"""Kindle Dashboard: expose the kindledash renderer to a jailbroken Kindle."""

from __future__ import annotations

import logging

from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.exceptions import ConfigEntryNotReady, HomeAssistantError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.typing import ConfigType
import voluptuous as vol

from .api import KindleDashApi, KindleDashApiError
from .const import CONF_ADDON_TOKEN, CONF_ADDON_URL, DOMAIN, SERVICE_RENDER
from .coordinator import KindleConfigEntry, KindleCoordinator, KindleRuntime
from .views import KindleImageView, KindleStatusView

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = [Platform.BUTTON, Platform.SENSOR]

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Register the HTTP views and the render service once."""
    hass.http.register_view(KindleImageView())
    hass.http.register_view(KindleStatusView())

    async def handle_render(call: ServiceCall) -> None:
        entries = [e for e in hass.config_entries.async_entries(DOMAIN) if hasattr(e, "runtime_data")]
        if not entries:
            raise HomeAssistantError("No Kindle Dashboard entry is loaded")
        for entry in entries:
            runtime: KindleRuntime = entry.runtime_data
            try:
                await runtime.api.render()
            except KindleDashApiError as err:
                raise HomeAssistantError(str(err)) from err
            await runtime.coordinator.async_request_refresh()

    hass.services.async_register(DOMAIN, SERVICE_RENDER, handle_render, schema=vol.Schema({}))
    return True


async def async_setup_entry(hass: HomeAssistant, entry: KindleConfigEntry) -> bool:
    """Set up a renderer connection from a config entry."""
    options = {**entry.data, **entry.options}
    api = KindleDashApi(
        async_get_clientsession(hass),
        options[CONF_ADDON_URL],
        options.get(CONF_ADDON_TOKEN) or None,
    )
    coordinator = KindleCoordinator(hass, entry, api)
    try:
        await coordinator.async_config_entry_first_refresh()
    except ConfigEntryNotReady:
        raise
    entry.runtime_data = KindleRuntime(api=api, coordinator=coordinator)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: KindleConfigEntry) -> bool:
    """Unload a config entry."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)

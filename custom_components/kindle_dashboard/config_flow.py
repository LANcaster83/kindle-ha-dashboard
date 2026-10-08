"""Config flow for the Kindle Dashboard integration."""

from __future__ import annotations

import logging
import secrets
from typing import Any

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult, OptionsFlowWithReload
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.hassio import is_hassio
import voluptuous as vol

from .api import KindleDashApi, KindleDashApiError, KindleDashAuthError
from .const import (
    ADDON_PORT,
    ADDON_SLUG_SUFFIX,
    CONF_ADDON_TOKEN,
    CONF_ADDON_URL,
    CONF_DEVICE_NAME,
    CONF_DEVICE_TOKEN,
    DEFAULT_ADDON_URL,
    DEFAULT_DEVICE_NAME,
    DOMAIN,
)
from .coordinator import KindleConfigEntry

_LOGGER = logging.getLogger(__name__)


async def async_discover_addon_url(hass: HomeAssistant) -> str | None:
    """Ask the Supervisor for the kindledash app hostname, if it is installed."""
    if not is_hassio(hass):
        return None
    try:
        from homeassistant.components.hassio import get_supervisor_client  # noqa: PLC0415

        client = get_supervisor_client(hass)
        installed = await client.addons.list()
        for addon in installed:
            if addon.slug.endswith(ADDON_SLUG_SUFFIX):
                info = await client.addons.addon_info(addon.slug)
                return f"http://{info.hostname}:{ADDON_PORT}"
    except Exception as err:
        _LOGGER.debug("App discovery via Supervisor failed: %s", err)
    return None


async def validate_renderer(hass: HomeAssistant, url: str, token: str | None) -> dict[str, Any]:
    """Check that the renderer answers on /status."""
    api = KindleDashApi(async_get_clientsession(hass), url, token)
    return await api.status()


def _schema(defaults: dict[str, Any], include_device_name: bool) -> vol.Schema:
    fields: dict[Any, Any] = {}
    if include_device_name:
        fields[vol.Required(CONF_DEVICE_NAME, default=defaults.get(CONF_DEVICE_NAME, DEFAULT_DEVICE_NAME))] = str
    fields[vol.Required(CONF_ADDON_URL, default=defaults.get(CONF_ADDON_URL, DEFAULT_ADDON_URL))] = str
    fields[vol.Optional(CONF_ADDON_TOKEN, description={"suggested_value": defaults.get(CONF_ADDON_TOKEN, "")})] = str
    fields[vol.Required(CONF_DEVICE_TOKEN, default=defaults.get(CONF_DEVICE_TOKEN, ""))] = str
    return vol.Schema(fields)


def _normalise(user_input: dict[str, Any]) -> dict[str, Any]:
    data = dict(user_input)
    data[CONF_ADDON_URL] = str(data[CONF_ADDON_URL]).strip().rstrip("/")
    data[CONF_ADDON_TOKEN] = str(data.get(CONF_ADDON_TOKEN) or "").strip()
    data[CONF_DEVICE_TOKEN] = str(data[CONF_DEVICE_TOKEN]).strip()
    return data


class KindleDashboardConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle the UI setup."""

    VERSION = 1

    def __init__(self) -> None:
        self._discovered_url: str | None = None
        self._generated_token = secrets.token_urlsafe(24)

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Ask for the renderer URL and tokens."""
        errors: dict[str, str] = {}
        if self._discovered_url is None:
            self._discovered_url = await async_discover_addon_url(self.hass) or DEFAULT_ADDON_URL

        if user_input is not None:
            data = _normalise(user_input)
            if not data[CONF_ADDON_URL].startswith(("http://", "https://")):
                errors[CONF_ADDON_URL] = "invalid_url"
            elif len(data[CONF_DEVICE_TOKEN]) < 8:
                errors[CONF_DEVICE_TOKEN] = "token_too_short"
            else:
                try:
                    await validate_renderer(self.hass, data[CONF_ADDON_URL], data[CONF_ADDON_TOKEN] or None)
                except KindleDashAuthError:
                    errors[CONF_ADDON_TOKEN] = "invalid_auth"
                except KindleDashApiError:
                    errors["base"] = "cannot_connect"
                if not errors:
                    await self.async_set_unique_id(data[CONF_ADDON_URL].lower())
                    self._abort_if_unique_id_configured()
                    return self.async_create_entry(title=data[CONF_DEVICE_NAME], data=data)

        defaults = {
            CONF_ADDON_URL: self._discovered_url,
            CONF_DEVICE_TOKEN: self._generated_token,
            **(user_input or {}),
        }
        return self.async_show_form(
            step_id="user",
            data_schema=_schema(defaults, include_device_name=True),
            errors=errors,
            description_placeholders={"image_path": f"/api/{DOMAIN}/image", "status_path": f"/api/{DOMAIN}/status"},
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: KindleConfigEntry) -> KindleDashboardOptionsFlow:
        """Return the options flow."""
        return KindleDashboardOptionsFlow()


class KindleDashboardOptionsFlow(OptionsFlowWithReload):
    """Let the user change the renderer URL and tokens later."""

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Edit connection settings."""
        errors: dict[str, str] = {}
        if user_input is not None:
            data = _normalise(user_input)
            if not data[CONF_ADDON_URL].startswith(("http://", "https://")):
                errors[CONF_ADDON_URL] = "invalid_url"
            elif len(data[CONF_DEVICE_TOKEN]) < 8:
                errors[CONF_DEVICE_TOKEN] = "token_too_short"
            else:
                try:
                    await validate_renderer(self.hass, data[CONF_ADDON_URL], data[CONF_ADDON_TOKEN] or None)
                except KindleDashAuthError:
                    errors[CONF_ADDON_TOKEN] = "invalid_auth"
                except KindleDashApiError:
                    errors["base"] = "cannot_connect"
                if not errors:
                    # Device token is looked up from entry.data by the HTTP views, so keep data and options in sync.
                    self.hass.config_entries.async_update_entry(
                        self.config_entry, data={**self.config_entry.data, **data}
                    )
                    return self.async_create_entry(title="", data=data)

        current = {**self.config_entry.data, **self.config_entry.options, **(user_input or {})}
        return self.async_show_form(
            step_id="init", data_schema=_schema(current, include_device_name=False), errors=errors
        )

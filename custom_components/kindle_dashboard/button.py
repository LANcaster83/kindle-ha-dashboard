"""Button to force a re-render."""

from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .api import KindleDashApiError
from .coordinator import KindleConfigEntry
from .entity import KindleEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: KindleConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback
) -> None:
    """Set up the render button."""
    async_add_entities([RenderNowButton(entry)])


class RenderNowButton(KindleEntity, ButtonEntity):
    """Ask the renderer to produce a fresh image now."""

    _attr_translation_key = "render_now"
    _attr_icon = "mdi:refresh"

    def __init__(self, entry: KindleConfigEntry) -> None:
        super().__init__(entry.runtime_data.coordinator, "render_now")
        self._api = entry.runtime_data.api

    async def async_press(self) -> None:
        """Trigger a render."""
        try:
            await self._api.render()
        except KindleDashApiError as err:
            raise HomeAssistantError(f"Render failed: {err}") from err
        await self.coordinator.async_request_refresh()

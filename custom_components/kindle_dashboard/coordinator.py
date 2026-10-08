"""Data coordinator for the Kindle Dashboard integration."""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import datetime
import logging
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed
from homeassistant.util import dt as dt_util

from .api import KindleDashApi, KindleDashApiError
from .const import DOMAIN, SCAN_INTERVAL

_LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class KindleData:
    """State exposed to entities."""

    renderer: dict[str, Any] = field(default_factory=dict)
    renderer_online: bool = False
    battery: int | None = None
    charging: bool | None = None
    kindle_extra: dict[str, Any] = field(default_factory=dict)
    last_seen: datetime | None = None
    last_image_fetch: datetime | None = None

    @property
    def last_render(self) -> datetime | None:
        """Return the renderer's last successful render time."""
        value = self.renderer.get("last_render")
        return dt_util.parse_datetime(value) if isinstance(value, str) else None

    @property
    def last_error(self) -> str | None:
        """Return the renderer's last error message."""
        value = self.renderer.get("last_error")
        return value if isinstance(value, str) else None


type KindleConfigEntry = ConfigEntry[KindleRuntime]


@dataclass
class KindleRuntime:
    """Objects kept for the lifetime of a config entry."""

    api: KindleDashApi
    coordinator: KindleCoordinator


class KindleCoordinator(DataUpdateCoordinator[KindleData]):
    """Polls the renderer status and merges in data pushed by the Kindle."""

    config_entry: KindleConfigEntry

    def __init__(self, hass: HomeAssistant, entry: KindleConfigEntry, api: KindleDashApi) -> None:
        super().__init__(
            hass,
            _LOGGER,
            config_entry=entry,
            name=f"{DOMAIN} {entry.title}",
            update_interval=SCAN_INTERVAL,
        )
        self.api = api
        self._kindle = KindleData()

    async def _async_update_data(self) -> KindleData:
        try:
            status = await self.api.status()
        except KindleDashApiError as err:
            if self.data is not None:
                # Keep Kindle-pushed values, mark the renderer offline.
                return replace(self.data, renderer_online=False)
            raise UpdateFailed(str(err)) from err
        return replace(self._current(), renderer=status, renderer_online=True)

    def _current(self) -> KindleData:
        return self.data if self.data is not None else self._kindle

    def update_from_kindle(self, payload: dict[str, Any]) -> None:
        """Merge a status report POSTed by the Kindle script."""
        battery = payload.get("battery")
        charging = payload.get("charging")
        extra = {k: v for k, v in payload.items() if k not in ("battery", "charging")}
        current = self._current()
        new = replace(
            current,
            battery=int(battery) if isinstance(battery, (int, float)) else current.battery,
            charging=bool(charging) if isinstance(charging, bool) else current.charging,
            kindle_extra={**current.kindle_extra, **extra},
            last_seen=dt_util.utcnow(),
        )
        self._kindle = new
        self.async_set_updated_data(new)

    def mark_image_fetched(self) -> None:
        """Record that the Kindle fetched an image."""
        now = dt_util.utcnow()
        new = replace(self._current(), last_seen=now, last_image_fetch=now)
        self._kindle = new
        self.async_set_updated_data(new)

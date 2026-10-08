"""Sensors for the Kindle Dashboard integration."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.const import PERCENTAGE, EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .coordinator import KindleConfigEntry, KindleData
from .entity import KindleEntity


@dataclass(frozen=True, kw_only=True)
class KindleSensorDescription(SensorEntityDescription):
    """Describes a Kindle sensor."""

    value_fn: Callable[[KindleData], datetime | int | str | None]
    attributes_fn: Callable[[KindleData], dict[str, Any]] | None = None


def _renderer_attrs(data: KindleData) -> dict[str, Any]:
    keys = (
        "last_duration_ms",
        "render_count",
        "error_count",
        "image_width",
        "image_height",
        "interval_seconds",
        "next_render",
        "version",
    )
    return {key: data.renderer.get(key) for key in keys if key in data.renderer}


def _kindle_attrs(data: KindleData) -> dict[str, Any]:
    return {"charging": data.charging, **data.kindle_extra}


SENSORS: tuple[KindleSensorDescription, ...] = (
    KindleSensorDescription(
        key="battery",
        translation_key="battery",
        device_class=SensorDeviceClass.BATTERY,
        state_class=SensorStateClass.MEASUREMENT,
        native_unit_of_measurement=PERCENTAGE,
        value_fn=lambda d: d.battery,
        attributes_fn=_kindle_attrs,
    ),
    KindleSensorDescription(
        key="last_seen",
        translation_key="last_seen",
        device_class=SensorDeviceClass.TIMESTAMP,
        entity_category=EntityCategory.DIAGNOSTIC,
        value_fn=lambda d: d.last_seen,
    ),
    KindleSensorDescription(
        key="last_render",
        translation_key="last_render",
        device_class=SensorDeviceClass.TIMESTAMP,
        entity_category=EntityCategory.DIAGNOSTIC,
        value_fn=lambda d: d.last_render,
        attributes_fn=_renderer_attrs,
    ),
    KindleSensorDescription(
        key="renderer_status",
        translation_key="renderer_status",
        device_class=SensorDeviceClass.ENUM,
        options=["ok", "error", "offline"],
        entity_category=EntityCategory.DIAGNOSTIC,
        value_fn=lambda d: "offline" if not d.renderer_online else ("ok" if d.renderer.get("ok") else "error"),
        attributes_fn=lambda d: {"last_error": d.last_error, "last_error_at": d.renderer.get("last_error_at")},
    ),
)


async def async_setup_entry(
    hass: HomeAssistant, entry: KindleConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback
) -> None:
    """Set up sensors."""
    coordinator = entry.runtime_data.coordinator
    async_add_entities(KindleSensor(coordinator, description) for description in SENSORS)


class KindleSensor(KindleEntity, SensorEntity):
    """A Kindle Dashboard sensor."""

    entity_description: KindleSensorDescription

    def __init__(self, coordinator: Any, description: KindleSensorDescription) -> None:
        super().__init__(coordinator, description.key)
        self.entity_description = description

    @property
    def native_value(self) -> datetime | int | str | None:
        """Return the state."""
        return self.entity_description.value_fn(self.coordinator.data)

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """Return extra attributes."""
        if self.entity_description.attributes_fn is None:
            return None
        return self.entity_description.attributes_fn(self.coordinator.data)

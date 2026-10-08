"""Constants for the Kindle Dashboard integration."""

from __future__ import annotations

from datetime import timedelta

DOMAIN = "kindle_dashboard"

CONF_ADDON_URL = "addon_url"
CONF_ADDON_TOKEN = "addon_token"
CONF_DEVICE_TOKEN = "device_token"
CONF_DEVICE_NAME = "device_name"

DEFAULT_ADDON_URL = "http://local-kindledash:8080"
DEFAULT_DEVICE_NAME = "Kindle"
ADDON_SLUG_SUFFIX = "_kindledash"
ADDON_PORT = 8080

SCAN_INTERVAL = timedelta(seconds=60)

IMAGE_PATH = f"/api/{DOMAIN}/image"
STATUS_PATH = f"/api/{DOMAIN}/status"

SERVICE_RENDER = "render"

ATTR_BATTERY = "battery"
ATTR_CHARGING = "charging"
ATTR_UPTIME = "uptime"
ATTR_FIRMWARE = "firmware"
ATTR_RSSI = "rssi"
ATTR_FREE_MEM = "free_mem"
ATTR_MESSAGE = "message"

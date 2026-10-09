#!/bin/sh
# shellcheck disable=SC2034
# Kindle Dashboard configuration. Plain POSIX sh, sourced by bin/kindledash.sh.
# Edit the values below, keep the quotes.

# --- Server -----------------------------------------------------------------
# Image URL. Two options:
#  a) via the Home Assistant integration (recommended): HA host + /api/kindle_dashboard/image
#  b) directly from the renderer app:                   http://<ha-host>:8080/kindle.png
# Kindle's busybox wget has no HTTPS: use plain http:// URLs.
IMAGE_URL="http://10.3.0.104:8123/api/kindle_dashboard/image"

# Status endpoint of the integration (battery reports). Leave empty when
# fetching directly from the renderer app (it has no status endpoint).
STATUS_URL="http://10.3.0.104:8123/api/kindle_dashboard/status"

# Device token from the integration's config flow (or the app's server_token
# when using option b). Sent as ?token=... on every request.
TOKEN="CHANGE-ME"

# --- Timing -------------------------------------------------------------------
# Seconds between frames.
INTERVAL=60
# Do a full (flashing) e-ink refresh every N frames to clear ghosting.
FULL_REFRESH_EVERY=5
# Seconds between battery/status reports to STATUS_URL (0 = never).
BATTERY_REPORT_EVERY=300
# Show a battery warning on screen at or below this level (%).
LOW_BATTERY_PERCENT=15
# HTTP timeout in seconds.
HTTP_TIMEOUT=30
# Stop automatically after this many seconds (0 = run until stopped).
MAX_RUNTIME=0

# --- Display ------------------------------------------------------------------
# Path to fbink. Empty = auto-detect (bin/fbink, then KOReader's copy, then eips fallback).
FBINK_BIN=""
# Extra fbink -g image options (comma separated). Add w=-2,h=-2 to scale to fit the screen.
FBINK_IMG_OPTS="halign=CENTER,valign=CENTER"
# Set to 1 to draw in the framebuffer's native (landscape on Oasis) layout
# instead of fbink's automatic portrait rotation. Try this if the image shows up rotated.
FBINK_NO_SW_ROTA=0

# --- UI mode ------------------------------------------------------------------
# Default mode when started without an argument:
#   keep           leave the Kindle UI alone; "Stop dashboard" in KUAL works. The status
#                  bar clock may redraw over the image until the next frame.
#   freeze         disable the status bar (pillow) and freeze the window manager,
#                  like KOReader does. Clean image; exit by holding the power button.
#   stop_framework stop the whole Kindle GUI (lowest CPU/RAM). Exit by holding the power button.
UI_MODE="keep"

# Host to ping while waiting for Wi-Fi. Empty = host part of IMAGE_URL.
WIFI_TEST_HOST=""

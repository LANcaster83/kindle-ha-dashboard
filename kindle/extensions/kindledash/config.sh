#!/bin/sh
# shellcheck disable=SC2034
# Kindle Dashboard configuration. Plain POSIX sh, sourced by bin/kindledash.sh.
# Edit the values below, keep the quotes.

# --- Server -----------------------------------------------------------------
# Image URL. Two options:
#  a) via the Home Assistant integration (recommended): HA base URL + /api/kindle_dashboard/image
#  b) directly from the renderer app:                   http://<ha-host>:8080/kindle.png
# Use the URL Home Assistant really listens on (here port 80; add :8123 if yours
# uses the default port). Kindle's busybox wget has no HTTPS: plain http:// only.
IMAGE_URL="http://10.3.0.104/api/kindle_dashboard/image"

# Status endpoint of the integration (battery reports). Leave empty when
# fetching directly from the renderer app (it has no status endpoint).
STATUS_URL="http://10.3.0.104/api/kindle_dashboard/status"

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
# Path to fbink. Empty = auto-detect: bin/fbink inside the extension, then the
# copy installed by the KindleModding hotfix (/mnt/us/libkh/bin/fbink, full build),
# then KOReader's (/mnt/us/koreader/fbink). Copies built without image support
# (KOReader's is, MINIMAL=1) are skipped and logged; with no usable fbink the
# daemon falls back to the firmware's eips -g.
FBINK_BIN=""
# Extra fbink -g image options (comma separated). Add w=-2,h=-2 to scale to fit the screen.
FBINK_IMG_OPTS="halign=CENTER,valign=CENTER"
# Orientation: fbink draws the PNG 1:1 into the framebuffer and never rotates it
# on Kindle. The Oasis framebuffer is portrait (1264x1680) while the Home screen
# or KUAL is in front, so a landscape dashboard must arrive already rotated:
# keep width 1680 x height 1264 and rotation 90 (or 270 to flip it) in the app.
# The daemon logs "frame WxH / framebuffer WxH" and warns when they do not match.

# --- UI mode ------------------------------------------------------------------
# Default mode when started without an argument:
#   keep           leave the Kindle UI alone; "Stop dashboard" in KUAL works. The status
#                  bar clock may redraw over the image until the next frame.
#   stop_framework stop the whole Kindle GUI (lowest CPU/RAM, nothing redraws over
#                  the image). KUAL is gone too: to stop, create a file named STOP
#                  in this folder over USB and eject (the daemon restores the GUI
#                  within INTERVAL seconds), or restart the Kindle (hold power ~40 s).
# (The former "freeze" mode froze the Kindle on FW 5.16 and was removed.)
UI_MODE="keep"

# Host to ping while waiting for Wi-Fi. Empty = host part of IMAGE_URL.
WIFI_TEST_HOST=""

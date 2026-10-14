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
# keep width 1680 x height 1264 and rotation 90 or 270 in the app (whichever puts
# the page buttons where you want them while the framebuffer reports rota=0).
# The Oasis framework also flips the framebuffer by 180 degrees (rota 0 <-> 2)
# from the accelerometer, which turned a fixed PNG upside down between runs. The
# daemon now reads the rotation with "fbink -e" before every fetch and asks the
# server for a counter-rotated frame (?fb_rotate=N), so the picture stays put.
# The log shows "fb rota=N" on every frame and every change.
#
# Seconds between rotation checks while waiting for the next frame; a change
# fetches a new frame at once instead of after INTERVAL. 0 = only check per frame.
ROTATION_POLL=5
# Optional: ask the window manager to stop following the accelerometer while the
# dashboard runs (lipc-set-prop com.lab126.winmgr orientationLock U|D|L|R), restored
# on stop. Not needed for a correct picture (see above) and unverified on FW 5.16:
# leave empty unless the flip itself bothers you. The log says whether it took.
ORIENTATION_LOCK=""

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

# Host to ping while waiting for Wi-Fi. Empty = host part of IMAGE_URL, "none" = do not
# wait (set it when the server drops ICMP; otherwise every frame waits up to 60 s).
WIFI_TEST_HOST=""

# --- Hardware buttons (Oasis page buttons) --------------------------------------
# The daemon reads the two page buttons from /dev/input/eventN and uses them for the
# front light; both held together stop the dashboard. 1 = on, 0 = off.
BUTTONS=1
# Key codes (Linux input, KOReader's device.lua for the Oasis 2): 104 is the upper and
# 109 the lower button in portrait. With the buttons at the bottom (rotation 270) the
# upper one is on the right. Swap the two numbers to swap the buttons.
BUTTON_LIGHT_UP=104      # raises the front light
BUTTON_LIGHT_DOWN=109    # lowers the front light
# Front light step per press and its range (com.lab126.powerd flIntensity, 0-24 on the Oasis).
BUTTON_LIGHT_STEP=2
LIGHT_MIN=0
LIGHT_MAX=24
# Both buttons held this many whole seconds: stop the daemon, restore the UI and open
# the Home screen (same as "Stop dashboard", also works in stop_framework mode).
BUTTON_HOLD_SECONDS=1
# Seconds the "Light N/24" message stays before the frame is redrawn over it.
BUTTON_MESSAGE_SECONDS=1
# Input device override, e.g. "/dev/input/event1". Empty = auto-detect: the device whose
# sysfs key bitmap lists both key codes, else one named like gpio-keys. The log says
# which one was chosen and lists every input device by name ("Buttons: ..." lines).
BUTTON_DEVICE=""
# Note: busybox sh cannot grab the device exclusively, so in keep mode the Kindle UI
# sees the presses too (the Home screen pages underneath; the frame is redrawn after
# BUTTON_MESSAGE_SECONDS). In stop_framework mode the buttons belong to the daemon.

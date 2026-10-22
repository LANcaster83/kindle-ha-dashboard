# Kindle side: KUAL extension `kindledash`

Copy `extensions/kindledash` to `/mnt/us/extensions/kindledash` on the Kindle
(USB drive mode), edit `config.sh`, then start it from KUAL. See the main
[README](../README.md#3-kindle-kual-extension) for the full walkthrough.

```
kindledash/
├── config.xml        KUAL extension manifest
├── menu.json         KUAL menu entries (start / stop / fetch once / status)
├── config.sh         your settings: server URL, token, interval, UI mode, buttons
├── bin/kindledash.sh daemon: fetch PNG -> fbink -> sleep, battery reports, button listener
├── bin/start.sh      background launcher used by KUAL
├── bin/stop.sh       stops the daemon and restores the UI
├── bin/status.sh     prints state + log tail on the screen
└── log/              created at runtime
```

Orientation: on Kindle, `fbink -g` copies the PNG 1:1 into the framebuffer and
never rotates it (`FBINK_NO_SW_ROTA` only exists for PocketBook/Kobo builds).
The Oasis framebuffer is portrait, 1264x1680, whenever the Home screen or KUAL
is in front, so the renderer app ships the landscape dashboard already rotated
(`rotation: 90` or `270`). The Oasis framework also flips that framebuffer by
180° from the accelerometer (`fbink -e` reports `currentRota=0` or `2`), so the
daemon reads the rotation before every fetch, passes it as `?fb_rotate=N` and
the app returns the frame counter-rotated; while waiting it re-checks every
`ROTATION_POLL` seconds. KOReader does the same thing in its own way (it reads
`com.lab126.winmgr accelerometer` and rotates in software). The daemon logs the
orientation state at start, `Frame WxH, framebuffer WxH rota=N` after the first
fetch, every drawn frame with its rotation, and warns on screen when the image
would be cropped. `ORIENTATION_LOCK` in `config.sh` optionally sets
`com.lab126.winmgr orientationLock` for the run (unverified on FW 5.16).

Buttons: the daemon reads the Oasis page buttons from `/dev/input/eventN`
(key codes 104 upper / 109 lower, from KOReader's `device.lua`) with a
background subshell doing `dd bs=16 count=1` + `od` per `input_event`, steps
`com.lab126.powerd flIntensity` by `BUTTON_LIGHT_STEP`, shows `Light N/24`
with fbink and redraws the frame a second later; both buttons held
`BUTTON_HOLD_SECONDS` stop the daemon and open the Home screen
(`lipc-set-prop com.lab126.appmgrd start app://com.lab126.booklet.home`, as
KOReader's exit does). The device is found from the sysfs key bitmap
(`/sys/class/input/eventN/device/capabilities/key`, 32-bit words, most
significant first), else by a `gpio-keys`-like name, `BUTTON_DEVICE` overrides.
No exclusive grab is possible from busybox sh (`EVIOCGRAB` is an ioctl), so in
`keep` mode the framework sees the presses too; `stop_framework` is the mode
where the buttons belong to the daemon. See the main README's
[Buttons](../README.md#buttons-oasis-page-buttons) section.

Tests: `kindle/test/dry-run.sh` runs the daemon under `busybox sh` with fake
`fbink`, `curl` and `lipc-*` tools (no device needed) and checks the
`fb_rotate` it sends for `rota=0`, `2` and unknown, the mid-interval re-fetch
when the rotation flips, the `STOP` file, SIGTERM and the orientation lock
restore. For the buttons it builds a fake `/sys/class/input` (a touchscreen and
a `gpio-keys` device with keys 104/109/116 in its bitmap) and feeds 16-byte
`input_event` records (32-bit ARM layout: `tv_sec`, `tv_usec`, `type`, `code`,
`value`, little endian) through a FIFO standing in for `/dev/input/event1`:
detection, light up/down, clamping at 24, an unmapped key, a short double
press (cancelled) and the held exit (daemon gone, Home screen call, no `dd`
reader left), plus the `BUTTON_DEVICE` override and a missing device. CI runs
it next to shellcheck.

## fbink

`fbink` is not bundled. The daemon takes the first of these that was **built
with image support** and falls back to the firmware's `eips -g` when none is:

1. `bin/fbink` inside the extension (your own copy, optional);
2. `/mnt/us/libkh/bin/fbink`, installed by the KindleModding post-jailbreak
   hotfix (<https://github.com/KindleModding/Hotfix>, `src/install.sh`
   "Installing fbink"; FBInk 1.25.0 for Kindle built from the
   `KindleModding/FBInk` fork, full build);
3. `/mnt/us/koreader/fbink`: KOReader builds its copy with `MINIMAL=1`
   (koreader-base `thirdparty/fbink/CMakeLists.txt`: "we don't care about image
   support"), so `fbink -g` answers `Image support is disabled in this FBInk
   build!` and draws nothing. This was the "fetch OK, no image" bug of 0.2.0.
4. `/usr/bin/fbink`.

The check is static (the "Image support is disabled" message only exists in
minimal builds), so a rejected copy is logged as `Skipping …: built without
image support`. Set `FBINK_BIN` in `config.sh` to force a path. To ship your
own, build FBInk from <https://github.com/NiLuJe/FBInk> with the Kindle
toolchain (`make kindle`, image support is on by default) and drop it in `bin/`.

## Stopping a `stop_framework` run

With the Kindle GUI stopped there is no KUAL. Hold both page buttons for a
second (the daemon restores the GUI and opens the Home screen), or create an
empty file named `STOP` in this extension's folder over USB and eject (the
daemon checks for it every `ROTATION_POLL` seconds and runs `start
lab126_gui`), run `bin/stop.sh` over SSH, or restart the device (hold the
power button ~40 s).

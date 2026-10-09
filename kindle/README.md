# Kindle side: KUAL extension `kindledash`

Copy `extensions/kindledash` to `/mnt/us/extensions/kindledash` on the Kindle
(USB drive mode), edit `config.sh`, then start it from KUAL. See the main
[README](../README.md#3-kindle-kual-extension) for the full walkthrough.

```
kindledash/
├── config.xml        KUAL extension manifest
├── menu.json         KUAL menu entries (start / stop / fetch once / status)
├── config.sh         your settings: server URL, token, interval, UI mode
├── bin/kindledash.sh daemon: fetch PNG -> fbink -> sleep, battery reports
├── bin/start.sh      background launcher used by KUAL
├── bin/stop.sh       stops the daemon and restores the UI
├── bin/status.sh     prints state + log tail on the screen
└── log/              created at runtime
```

Orientation: on Kindle, `fbink -g` copies the PNG 1:1 into the framebuffer and
never rotates it (`FBINK_NO_SW_ROTA` only exists for PocketBook/Kobo builds).
The Oasis framebuffer is portrait, 1264x1680, whenever the Home screen or KUAL
is in front, so the renderer app ships the landscape dashboard already rotated
(`rotation: 90`). The daemon logs `Frame WxH, framebuffer WxH` after the first
fetch and warns on screen when the image would be cropped.

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

With the Kindle GUI stopped there is no KUAL. Either create an empty file named
`STOP` in this extension's folder over USB and eject (the daemon checks for it
every `INTERVAL` seconds and runs `start lab126_gui`), run `bin/stop.sh` over
SSH, or restart the device (hold the power button ~40 s).

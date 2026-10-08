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

`fbink` is not bundled. The daemon looks for `bin/fbink` inside the extension,
then for KOReader's copy at `/mnt/us/koreader/fbink`, and falls back to the
firmware's `eips`. KOReader is installed on the target device, so nothing else
is needed; to ship your own copy, take `fbink` from a KOReader Kindle release
(`koreader/fbink`) or build it from <https://github.com/NiLuJe/FBInk>.

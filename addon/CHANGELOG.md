# Changelog

## 0.2.1

- `ha_url` accepts an empty value again: the configuration UI sends `""` for a
  cleared field, which the `url?` schema rejected ("Failed to save: expected a
  URL"). The schema is now `str?`; the app validates the URL itself and treats
  `""` like absent (auto-detection).
- Renders no longer stall for ~16 minutes. When the page stopped answering,
  0.2.0 retried `Runtime.evaluate` four times at puppeteer's default 180 s
  `protocolTimeout`, then waited up to another 180 s for the tab to close.
  Now the whole attempt is bounded by `render_timeout_ms` (default 45 s),
  `protocolTimeout` is set to the same value, a protocol timeout is never
  retried, and the error names the phase (`Render timed out after 45000 ms
  during probe`). After a timeout Chromium is closed, killed if it does not
  exit within 5 s, and relaunched for the next render; a tab that will not
  close is treated the same way.
- `/status` reports `consecutive_errors` (failures since the last good render).
- Timed-out renders skip the `/data/last-error.png` screenshot (it would hang
  too); other failures still capture it.

## 0.2.0

- `ha_url` is optional: on HAOS the port is taken from the Supervisor
  (`/core/info`, `hassio_api`), otherwise `homeassistant:8123` then `:80` are
  probed. Home Assistant on port 80 (`http://10.3.0.104`) works out of the box.
- Landscape defaults for the Kindle Oasis: viewport `1680x1264`, `rotation: 90`
  (the device framebuffer is portrait). `width`/`height` now always describe
  the dashboard viewport; `rotation` only turns the finished PNG.
- Startup robustness: the token is seeded with `evaluateOnNewDocument` before
  the first navigation (no more "Execution context was destroyed"), pages are
  awaited with `load` plus a bounded wait for `hui-root` instead of
  `networkidle2`.
- Clear errors: login page vs. "not the Home Assistant frontend (HTTP n)"
  with the status of the main document. Failed renders save a screenshot to
  `/data/last-error.png`, served at `/last-error.png`.
- Self-signed certificates on `https://homeassistant` are accepted.

## 0.1.0

- Initial release: headless Chromium renderer for a Lovelace dashboard,
  e-ink post-processing (grayscale, contrast, 16-level Floyd-Steinberg
  dithering, rotation), HTTP endpoints `/kindle.png`, `/status`, `/render`,
  `/health`, optional server token, configurable interval.

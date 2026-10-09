# Kindle Dashboard Renderer

## What it does

1. Starts headless Chromium, logs into this Home Assistant with the long-lived
   access token you provide (stored in the browser's `localStorage`, the same
   way the frontend keeps its session).
2. Opens the dashboard at `ha_url + dashboard_path`, hides the Lovelace header
   and sidebar, waits `render_delay_ms`, takes a `width x height` screenshot.
3. Converts it to 8-bit grayscale, applies `contrast`, quantises to
   `gray_levels` with Floyd-Steinberg dithering, rotates by `rotation`.
4. Serves the result on port 8080 and repeats every `interval` seconds.

### Finding Home Assistant

Leave `ha_url` empty on HAOS. At startup the app asks the Supervisor
(`GET http://supervisor/core/info`, needs `hassio_api`) which port Home
Assistant listens on and uses `http://homeassistant:<port>`. Without a
Supervisor it probes `http://homeassistant:8123`, then `http://homeassistant`
(port 80), and finally falls back to `http://homeassistant:8123` with a warning
in the log. The chosen URL and why is logged at startup (`Home Assistant URL:
...`) and shown on `/config` as `haUrlSource`.

Set `ha_url` only when that fails or HA runs elsewhere. It must be the URL Home
Assistant *actually* answers on from inside the container: the frontend port
is `http.server_port` in `configuration.yaml`, 8123 by default. The reference
install here uses port 80, so `ha_url: http://10.3.0.104` (no `:8123`).

### When a render fails

The error names the cause:

- *showed the login page*: the long-lived token was rejected (missing, revoked,
  or created on another instance).
- *is not the Home Assistant frontend (HTTP 404 ...)*: `ha_url` or
  `dashboard_path` points at something else (a 404 page, a reverse proxy, ...).
- *Could not load ...*: connection refused or timeout; check `ha_url`.

Every failed render also leaves a screenshot of what Chromium saw at
`/data/last-error.png`, served as `GET /last-error.png`.

## Endpoints

| Path | Method | Description |
|------|--------|-------------|
| `/kindle.png` | GET | Latest image. `?render=1` forces a fresh render first. Supports `ETag`/`If-None-Match`. |
| `/status` | GET | JSON: `ok`, `last_render`, `last_error`, `render_count`, `image_width`, ... |
| `/render` | POST | Render now, returns the status document. |
| `/config` | GET | Effective options with secrets masked, plus `haUrlSource`. |
| `/last-error.png` | GET | Screenshot of the last failed render (404 until one happened). |
| `/health` | GET | Always 200 while the process runs (used by the watchdog). |
| `/` | GET | Small preview page. |

If `server_token` is set, every endpoint except `/health` requires it as
`?token=...`, header `X-Kindle-Token` or `Authorization: Bearer`.

## Options

| Option | Default | Notes |
|--------|---------|-------|
| `ha_url` | empty = auto | Leave empty on HAOS (Supervisor tells the port). Otherwise the URL HA really listens on, e.g. `http://10.3.0.104` for port 80. |
| `access_token` | required | Long-lived access token (Profile -> Security). |
| `dashboard_path` | `/dashboard-test-2` | Any Lovelace path, e.g. `/lovelace/0`. |
| `url_query` | empty | Appended to the URL, e.g. `?kiosk` when the kiosk-mode plugin is installed. |
| `width`, `height` | `1680`, `1264` | Dashboard viewport in CSS pixels: landscape Oasis. Portrait: `1264`, `1680`. |
| `rotation` | `90` | Rotate the finished PNG clockwise: 0, 90, 180, 270. The Oasis framebuffer is portrait, so a landscape viewport needs 90 (or 270 to flip it); portrait uses 0 (or 180). |
| `zoom` | `1.0` | CSS zoom; use ~1.5-2.0 if cards look tiny at 300 ppi. |
| `interval` | `60` | Seconds between renders. |
| `render_delay_ms` | `1500` | Extra wait for cards (graphs, cameras) to finish. |
| `color_scheme` | `light` | Emulated `prefers-color-scheme`. Light is better on e-ink. |
| `theme`, `language` | empty | Optional HA theme name and UI language (`pl`). |
| `hide_header` | `true` | Hide the toolbar and dock the sidebar away. |
| `gray_levels` | `16` | Kindle e-ink has 16 levels; 2 gives pure black/white. |
| `dither` | `true` | Floyd-Steinberg dithering when quantising. |
| `contrast` | `1.15` | Multiplier around mid-gray before quantising. |
| `server_token` | empty | Protects the endpoints; the integration passes it as `addon_token`. |

## Notes

- `apparmor` is disabled for this app because Chromium needs namespaces the
  default profile blocks. Chromium itself runs with `--no-sandbox` inside the
  container.
- Port 8080 is published on the host so the Kindle can fetch
  `http://<ha-host>:8080/kindle.png` directly. Remove the port mapping in the
  app's Network settings if you only use the integration's proxy endpoint.
- Rendering takes 3-10 s on x86; a Raspberry Pi 4 needs noticeably longer and
  more RAM (Chromium ~300 MB).
- Environment-only knobs (compose / local runs): `KD_RENDER_TIMEOUT_MS`
  (default 45000), `KD_LOG_LEVEL`, `KD_ERROR_SCREENSHOT` (empty disables the
  failure screenshot).
- The Web UI preview shows the PNG exactly as the Kindle receives it, i.e.
  rotated when `rotation` is not 0.

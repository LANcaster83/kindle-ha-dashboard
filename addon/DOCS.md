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

## Endpoints

| Path | Method | Description |
|------|--------|-------------|
| `/kindle.png` | GET | Latest image. `?render=1` forces a fresh render first. Supports `ETag`/`If-None-Match`. |
| `/status` | GET | JSON: `ok`, `last_render`, `last_error`, `render_count`, `image_width`, ... |
| `/render` | POST | Render now, returns the status document. |
| `/config` | GET | Effective options with secrets masked. |
| `/health` | GET | Always 200 while the process runs (used by the watchdog). |
| `/` | GET | Small preview page. |

If `server_token` is set, every endpoint except `/health` requires it as
`?token=...`, header `X-Kindle-Token` or `Authorization: Bearer`.

## Options

| Option | Default | Notes |
|--------|---------|-------|
| `ha_url` | `http://homeassistant:8123` | Frontend URL as seen from the app. Keep the default on HAOS. |
| `access_token` | required | Long-lived access token (Profile -> Security). |
| `dashboard_path` | `/dashboard-test-2` | Any Lovelace path, e.g. `/lovelace/0`. |
| `url_query` | empty | Appended to the URL, e.g. `?kiosk` when the kiosk-mode plugin is installed. |
| `width`, `height` | `1264`, `1680` | Kindle Oasis portrait. Swap them (or use `rotation`) for landscape. |
| `rotation` | `0` | Rotate the final PNG clockwise: 0, 90, 180, 270. |
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

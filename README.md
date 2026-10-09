# kindle-ha-dashboard

Turn a jailbroken Kindle Oasis into a Home Assistant wall dashboard that
refreshes every 60 seconds.

```
 Home Assistant OS                                      Kindle Oasis (jailbroken)
 ┌──────────────────────────────────────────────┐       ┌──────────────────────────┐
 │ Kindle Dashboard Renderer app (addon/)       │       │ KUAL extension           │
 │  headless Chromium → screenshot → gray PNG   │       │ kindle/extensions/       │
 │  GET :8080/kindle.png  /status  POST /render │◄──┐   │  kindledash.sh loop:     │
 └──────────────────────────────────────────────┘   │   │   wget PNG → fbink -g    │
 ┌──────────────────────────────────────────────┐   │   │   every 60 s, full       │
 │ HACS integration kindle_dashboard            │   │   │   refresh every 5 frames │
 │  (custom_components/) proxies the image      │───┘   │   POST battery report    │
 │  GET  /api/kindle_dashboard/image?token=…    │◄──────│                          │
 │  POST /api/kindle_dashboard/status?token=…   │◄──────│                          │
 │  sensors: battery, last seen, last render,   │       └──────────────────────────┘
 │  renderer status; button/service: render now │
 └──────────────────────────────────────────────┘
```

Three components, one repository:

| Component | Path | Installed as |
|-----------|------|--------------|
| Renderer | `addon/` | Home Assistant app ("add-on") from this repo as a custom app repository |
| Integration | `custom_components/kindle_dashboard/` | HACS custom integration (this repo as a custom repository) |
| Kindle extension | `kindle/extensions/kindledash/` | KUAL extension, copied over USB |

The integration is deliberately thin: the app does all the rendering. The
integration adds a single token-protected URL on the normal HA port, a battery
sensor fed by the Kindle, "last seen" / "last render" diagnostics and a
*Render now* button and service.

## Requirements

- Home Assistant OS (tested target: HAOS VM at `http://10.3.0.104`) with HACS.
  The app is built on the x86-64/aarch64 HA base image; Chromium needs roughly
  300 MB of RAM while rendering.
- Kindle Oasis (2017/2019, 1264x1680 @ 300 ppi) with firmware 5.16.x,
  jailbroken (WinterBreak), with **KUAL** installed. **KOReader** is used for
  its bundled `fbink`; if you do not want KOReader, see
  [kindle/README.md](kindle/README.md) for other ways to get `fbink`.
- The Kindle must reach HA over plain **HTTP** (busybox `wget` on the Kindle has
  no TLS). The default URLs use `http://10.3.0.104:8123`.

> **Private repository note.** The Supervisor and HACS clone repositories
> anonymously. While this GitHub repository is private, use the *manual*
> installation paths described below (local app in `/addons`, integration copied
> to `/config/custom_components`), or make the repository public.

## 1. Renderer app (add-on)

### Install

Option A, custom repository (repository must be public):

1. Settings → Apps (Add-ons) → App store → ⋮ → *Repositories* → add
   `https://github.com/LANcaster83/kindle-ha-dashboard` → *Add*.
   One-click: [![Add repository](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FLANcaster83%2Fkindle-ha-dashboard)
2. Install **Kindle Dashboard Renderer**. The image is built locally on the
   HAOS host (a few minutes the first time).

Option B, local app (works with a private repo): copy the `addon/` folder to the
HAOS `addons` share as `addons/kindledash` (Samba app, or `ssh` into the OS),
then Settings → Apps → App store → ⋮ → *Check for updates*. It shows up under
*Local apps*.

### Configure

1. In HA: your profile → *Security* → *Long-lived access tokens* → *Create
   token* (name it `kindledash`). Copy it.
2. App → *Configuration*:
   - `access_token`: the token from step 1.
   - `dashboard_path`: `/dashboard-test-2` (default) or any Lovelace path.
   - Leave `ha_url` at `http://homeassistant:8123` on HAOS.
   - Optional: `server_token` (random string) to protect the app's own port.
3. *Start*. Open the *Web UI* (`http://10.3.0.104:8080/`) to see the preview
   and status; `http://10.3.0.104:8080/kindle.png` is the image.

Full option reference: [addon/DOCS.md](addon/DOCS.md).

## 2. HACS integration

### Install

Option A (public repo): HACS → ⋮ → *Custom repositories* → URL
`https://github.com/LANcaster83/kindle-ha-dashboard`, type *Integration* → *Add*
→ search *Kindle Dashboard* → *Download* → restart HA.

Option B (private repo): copy `custom_components/kindle_dashboard` into
`/config/custom_components/` and restart HA. HACS will not manage updates in
this case.

### Configure

Settings → Devices & services → *Add integration* → *Kindle Dashboard*:

| Field | Value |
|-------|-------|
| Device name | e.g. `Kindle kuchnia` |
| Renderer URL | Pre-filled from the Supervisor when the app is installed (`http://<repo-hash>-kindledash:8080`, or `http://local-kindledash:8080` for a local app). |
| Renderer server token | Only if you set `server_token` in the app. |
| Device token | Pre-generated. **Copy it**, it goes into `config.sh` on the Kindle. Can be changed later under *Configure*. |

You get a device *Kindle …* with:

- `sensor.<name>_battery` (%, attributes: `charging`, `firmware`, `uptime`, …) fed by the Kindle,
- `sensor.<name>_last_seen` (last image fetch or status report from the Kindle),
- `sensor.<name>_last_render` (from the app, attributes: render count, errors, image size),
- `sensor.<name>_renderer_status` (`ok` / `error` / `offline`),
- `button.<name>_render_now` and service `kindle_dashboard.render`.

Endpoints (token = device token, or a logged-in HA session):

- `GET http://10.3.0.104:8123/api/kindle_dashboard/image?token=…` → PNG (`&render=1` forces a fresh render),
- `POST http://10.3.0.104:8123/api/kindle_dashboard/status?token=…` with JSON `{"battery": 73, "charging": false, …}`.

## 3. Kindle (KUAL extension)

### Prerequisites on the Kindle

- Jailbreak (done: WinterBreak) and KUAL (done).
- **Install the post-jailbreak hotfix** (MobileRead "Hotfix" package via
  MRInstaller: copy `Update_hotfix_*.bin` to `/mnt/us/mrpackages/` and run
  *Install MR Packages* from KUAL). The device log reports it is still missing.
  Keep OTA updates blocked (`renameotabin` is installed).
- Airplane mode off, Wi-Fi joined to the network that can reach HA.

### Copy the extension (USB drive mode)

1. Connect the Kindle over USB; it appears as a drive (`/dev/sda`, "Kindle
   Internal Storage" on Linux). Mount it read-write.
2. Copy `kindle/extensions/kindledash` to `<kindle>/extensions/kindledash` so
   that `<kindle>/extensions/kindledash/config.xml` exists.
3. Edit `<kindle>/extensions/kindledash/config.sh`:

   ```sh
   IMAGE_URL="http://10.3.0.104:8123/api/kindle_dashboard/image"
   STATUS_URL="http://10.3.0.104:8123/api/kindle_dashboard/status"
   TOKEN="<device token from the integration>"
   INTERVAL=60
   ```

   To bypass the integration use `IMAGE_URL="http://10.3.0.104:8080/kindle.png"`,
   `STATUS_URL=""` and the app's `server_token` as `TOKEN`.
4. Eject safely, disconnect.

From the Linux dev box: `sudo mount /dev/sda /mnt/kindle && cp -r kindle/extensions/kindledash /mnt/kindle/extensions/ && sudo umount /mnt/kindle`.

### Run

KUAL → **Kindle Dashboard**:

| Entry | What it does |
|-------|--------------|
| *Fetch once (test)* | Downloads one frame and draws it. Use this first. |
| *Start dashboard* | Loop in `keep` mode: Kindle UI stays alive, screensaver and Wi-Fi sleep disabled. *Stop dashboard* from KUAL works. The Kindle status bar clock may redraw over the top of the image until the next frame. |
| *Start dashboard (freeze UI)* | Disables the status bar and freezes the window manager (KOReader's recipe). Clean image. Leave by holding the power button for ~7 s and choosing *Restart*, or by `bin/stop.sh` over SSH. |
| *Start dashboard (stop framework)* | Stops the whole Kindle GUI: least RAM/CPU. Leave by restart. |
| *Stop dashboard* | Stops the loop, restores UI/screensaver. |
| *Show status / log* | Prints state, battery and the log tail on the screen. |

The loop: wait for network → `wget` the PNG (kept on tmpfs) → `fbink -g`
(partial refresh; full flashing refresh every `FULL_REFRESH_EVERY` frames and
after a failed fetch) → report battery to `STATUS_URL` every
`BATTERY_REPORT_EVERY` seconds → sleep `INTERVAL`. On fetch errors the last
image stays and a small `offline since HH:MM (n)` marker is printed at the
bottom. Below `LOW_BATTERY_PERCENT` a `battery N%` marker is shown.

Logs: `/mnt/us/extensions/kindledash/log/kindledash.log`.

## Configuration reference

- App options: [addon/DOCS.md](addon/DOCS.md).
- Kindle: [kindle/extensions/kindledash/config.sh](kindle/extensions/kindledash/config.sh) is self-documented.
- Integration: everything is in the config flow / *Configure* dialog.

## Local development (no HAOS needed)

```sh
cp .env.example .env        # fill KD_HA_URL and KD_ACCESS_TOKEN
docker compose up --build   # renderer on http://localhost:8080/
```

Renderer (TypeScript, Node 22 via fnm, pnpm):

```sh
cd addon/app && pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Integration (Python 3.13 via uv):

```sh
uv sync --group dev
uv run ruff check . && uv run ruff format --check . && uv run pytest
```

Kindle scripts: `shellcheck -s sh kindle/extensions/kindledash/bin/*.sh`. The
daemon runs under busybox `sh`; keep it POSIX.

CI (`.github/workflows/ci.yaml`) runs all of the above plus hassfest, the HACS
validator and an amd64 Docker build of the app.

## Troubleshooting

**Ghosting / grey residue.** Lower `FULL_REFRESH_EVERY` (every full refresh
flashes black→white). Increase `contrast` in the app (1.3–1.6) or set
`gray_levels: 2` for pure black and white. Keep dithering on for photos and
graphs, off for text-only dashboards.

**Image is rotated or cut off.** The Oasis framebuffer is natively landscape;
`fbink` rotates to portrait automatically. If the picture comes out sideways
set `FBINK_NO_SW_ROTA=1` in `config.sh`, or set `rotation: 90` in the app (the
viewport is swapped for you). Add `w=-2,h=-2` to `FBINK_IMG_OPTS` to scale to
fit instead of cropping.

**Kindle shows "offline since …".** The fetch failed. Check Wi-Fi (the daemon
pings the server host and asks `wifid` to enable the radio), that the URL is
`http://` (no TLS on the Kindle), the token, and the app log (Settings → Apps →
Kindle Dashboard Renderer → *Log*). `Fetch once (test)` prints a hint on
screen; the log has details.

**Wi-Fi drops after a few minutes.** `preventScreenSaver` keeps the device
awake, which keeps Wi-Fi up. If the Kindle still sleeps, make sure the loop is
running (`Show status / log`) and that no power-save app is installed. The
Kindle reconnects by itself; the daemon waits up to 60 s per frame.

**Battery.** Staying awake with Wi-Fi on drains the Oasis in roughly 1–2 days.
Use a USB power source for a permanent wall display, or raise `INTERVAL`. The
battery sensor in HA lets you automate a notification (`below: 15`).

**App log says "Home Assistant showed the login page".** The long-lived token
is missing, revoked, or `ha_url` points at a different origin than the token
was created on. Create a new token and restart the app.

**Header / sidebar still visible.** The hide logic walks the frontend's shadow
DOM and may lag behind a frontend release. Install the *kiosk-mode* HACS
plugin and set `url_query: ?kiosk`.

**Cards are tiny.** 300 ppi: set `zoom: 1.5` to `2.0`, or design a dedicated
dashboard for the Kindle (one column, large fonts, light theme).

**Chromium fails to start in the app.** The app disables AppArmor and passes
`--no-sandbox`; on a very small host raise the RAM. The watchdog restarts the
app if `/health` stops answering.

## Security

- The HA long-lived token lives only in the app's options and in Chromium's
  profile inside the container.
- The Kindle never holds the HA token: it only has the device token, which
  grants access to one image and the status endpoint.
- Traffic Kindle ↔ HA is plain HTTP on the LAN. Put the Kindle on a trusted
  network.

## License

MIT, see [LICENSE](LICENSE).

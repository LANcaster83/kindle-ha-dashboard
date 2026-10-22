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
  The app is built on the x86-64/aarch64 HA base image. Give the host **at
  least 4 vCPU and 4 GB RAM**: on a 2 vCPU / 2 GB VM headless Chromium timed
  out on almost every render and only about one frame in ten reached the
  Kindle; with 4 vCPU / 4 GB the same setup renders every minute with zero
  timeouts and zero errors. See [Tuning](#tuning-what-worked-on-the-oasis-2).
- Kindle Oasis (2017/2019, 1264x1680 @ 300 ppi) with firmware 5.16.x,
  jailbroken (WinterBreak), with **KUAL** installed. **KOReader** is used for
  its bundled `fbink`; if you do not want KOReader, see
  [kindle/README.md](kindle/README.md) for other ways to get `fbink`.
- The Kindle must reach HA over plain **HTTP** (busybox `wget` on the Kindle has
  no TLS). Use the URL HA really listens on: this instance answers on port 80,
  so the defaults use `http://10.3.0.104` (a stock install would be
  `http://<host>:8123`).

## 1. Renderer app (add-on)

### Install

Option A, custom repository:

1. Settings → Apps (Add-ons) → App store → ⋮ → *Repositories* → add
   `https://github.com/LANcaster83/kindle-ha-dashboard` → *Add*.
   One-click: [![Add repository](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FLANcaster83%2Fkindle-ha-dashboard)
2. Install **Kindle Dashboard Renderer**. The image is built locally on the
   HAOS host (a few minutes the first time).

Option B, local app: copy the `addon/` folder to the HAOS `addons` share as `addons/kindledash` (Samba app, or `ssh` into the OS),
then Settings → Apps → App store → ⋮ → *Check for updates*. It shows up under
*Local apps*.

### Configure

1. In HA: your profile → *Security* → *Long-lived access tokens* → *Create
   token* (name it `kindledash`). Copy it.
2. App → *Configuration*:
   - `access_token`: the token from step 1.
   - `dashboard_path`: `/dashboard-test-2` (default) or any Lovelace path.
   - `ha_url`: leave **empty** on HAOS. The app asks the Supervisor which port
     HA listens on (here 80, so it uses `http://homeassistant`). Set it only if
     the log warns, to the URL HA really answers on, e.g. `http://10.3.0.104`
     (not `:8123` on this host).
   - `width`/`height`/`rotation`: `1680`/`1264`/`90` (default) is a landscape
     dashboard for the Oasis; `270` if the page buttons end up on the wrong
     side, see [Orientation](#orientation) below.
   - `zoom`: `1.5` on the 300 ppi Oasis, `contrast`: `0.95` looked best on
     the real panel, see [Tuning](#tuning-what-worked-on-the-oasis-2).
   - Optional: `server_token` (random string) to protect the app's own port.
3. *Start*. Open the *Web UI* (`http://10.3.0.104:8080/`) to see the preview
   and status; `http://10.3.0.104:8080/kindle.png` is the image. The log says
   which HA URL was picked (`Home Assistant URL: ...`). A failed render leaves
   `http://10.3.0.104:8080/last-error.png` showing what Chromium saw.

Full option reference: [addon/DOCS.md](addon/DOCS.md).

## 2. HACS integration

### Install

Option A (public repo): HACS → ⋮ → *Custom repositories* → URL
`https://github.com/LANcaster83/kindle-ha-dashboard`, type *Integration* → *Add*
→ search *Kindle Dashboard* → *Download* → restart HA.

Option B (manual): copy `custom_components/kindle_dashboard` into
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

- `GET http://10.3.0.104/api/kindle_dashboard/image?token=…` → PNG (`&render=1` forces a fresh render),
- `POST http://10.3.0.104/api/kindle_dashboard/status?token=…` with JSON `{"battery": 73, "charging": false, …}`.

(`http://10.3.0.104` is HA's own port here, 80; append `:8123` on a stock install.)

## 3. Kindle (KUAL extension)

### Prerequisites on the Kindle

- Jailbreak (done: WinterBreak) and KUAL (done).
- **Install the post-jailbreak hotfix** if the jailbreak log says it is
  missing: `Update_hotfix_universal.bin` from
  <https://github.com/KindleModding/Hotfix/releases> into
  `/mnt/us/mrpackages/`, then `;log mrpi` in the Kindle search box (or KUAL →
  *Helper* → *Install MR Packages*). Keep OTA updates blocked (`renameotabin`
  is installed). The hotfix also installs the `fbink` the dashboard draws with
  (`/mnt/us/libkh/bin/fbink`, a full FBInk build with PNG support). KOReader's
  `fbink` is a text-only build (`MINIMAL=1`) and **cannot draw images**; the
  daemon skips it. See [kindle/README.md](kindle/README.md#fbink).
- Airplane mode off, Wi-Fi joined to the network that can reach HA.

### Copy the extension (USB drive mode)

1. Connect the Kindle over USB; it appears as a drive (`/dev/sda`, "Kindle
   Internal Storage" on Linux). Mount it read-write.
2. Copy `kindle/extensions/kindledash` to `<kindle>/extensions/kindledash` so
   that `<kindle>/extensions/kindledash/config.xml` exists.
3. Edit `<kindle>/extensions/kindledash/config.sh`:

   ```sh
   IMAGE_URL="http://10.3.0.104/api/kindle_dashboard/image"
   STATUS_URL="http://10.3.0.104/api/kindle_dashboard/status"
   TOKEN="<device token from the integration>"
   INTERVAL=60
   ```

   To bypass the integration use `IMAGE_URL="http://10.3.0.104:8080/kindle.png"`,
   `STATUS_URL=""` and the app's `server_token` as `TOKEN`.
4. Eject safely, disconnect.

From the Linux dev box (vfat, mount as your user so the copy is writable):
`sudo mount -o uid=$(id -u),gid=$(id -g) /dev/sda /mnt/kindle && cp -r kindle/extensions/kindledash /mnt/kindle/extensions/ && sync && sudo umount /mnt/kindle`.

### Orientation

- The Oasis panel is 1264x1680. On Kindle, `fbink -g` copies the PNG 1:1 into
  the framebuffer and **never rotates** it (verified in FBInk's source: the
  `FBINK_NO_SW_ROTA` switch only exists in the PocketBook/Kobo code paths).
- While the Home screen or KUAL is in front the framebuffer is **portrait**
  (landscape exists only inside the stock reader), so a landscape dashboard
  must arrive already rotated. That is the app default: viewport `1680x1264`,
  `rotation: 90`, giving a 1264x1680 PNG.
- **The Oasis flips its framebuffer by 180°** when you turn the device over:
  the framework follows the accelerometer and switches the framebuffer
  rotation between `rota=0` and `rota=2` (both seen in this device's log).
  Nothing in the PNG changes, so a fixed `rotation` was right in one state and
  upside down in the other ("sometimes 90 is right, sometimes 270"). Since
  0.2.2 the daemon reads the rotation with `fbink -e` before every fetch and
  asks the app for a counter-rotated frame (`?fb_rotate=N`, served from the
  cached render, no re-render); while waiting for the next frame it re-checks
  every `ROTATION_POLL` (5 s) and fetches at once when the rotation changed.
- **What to set**: `rotation` in the app is the base orientation for
  `rota=0`. Start the dashboard, read `fb rota=` from `Show status / log`. If
  the log says `rota=0` and the page buttons are on the wrong side, switch
  `rotation` between `90` and `270` and restart the app. If the log says
  `rota=2`, turn the Kindle over or wait for the next frame (the daemon
  compensates) before judging. For buttons at the bottom this device uses
  `270` (the user's finding; verify once with the log as above).
- Portrait dashboard: `width: 1264`, `height: 1680`, `rotation: 0` (or `180`);
  the same compensation applies.
- Optional `ORIENTATION_LOCK="U"` in `config.sh` additionally asks the window
  manager to stop following the accelerometer
  (`lipc-set-prop com.lab126.winmgr orientationLock U`, restored on stop). It
  is not needed for a correct picture and is unverified on firmware 5.16; the
  log reports whether the call was accepted.
- The daemon logs `Orientation: fb rota=N winmgr orientation=… accelerometer=…
  orientationLock=…` at start, `Frame WxH, framebuffer WxH rota=N` after the
  first fetch, `Drew frame n (fb rota=N, fb_rotate=N, full=…)` for every
  frame, and `Framebuffer rotation changed: rota 0 -> 2` when it flips. It
  prints a warning on screen when the frame is larger than the framebuffer
  (it would be cropped).

### Run

KUAL → **Kindle Dashboard**:

| Entry | What it does |
|-------|--------------|
| *Fetch once (test)* | Downloads one frame and draws it. Use this first. |
| *Start dashboard* | Loop in `keep` mode: Kindle UI stays alive, screensaver and Wi-Fi sleep disabled. *Stop dashboard* from KUAL works. The Kindle status bar clock may redraw over the top of the image until the next frame. |
| *Start dashboard (stop framework)* | Stops the whole Kindle GUI (`stop lab126_gui`): least RAM/CPU, nothing redraws over the image, the page buttons belong to the daemon alone. KUAL is gone with it, so to stop: **hold both page buttons for a second** (see [Buttons](#buttons-oasis-page-buttons)), or connect USB, create an empty file `STOP` in `extensions/kindledash/`, eject; the daemon sees it within `INTERVAL` seconds and starts the GUI again. Or restart the Kindle (hold power ~40 s). |
| *Stop dashboard* | Stops the loop, restores UI/screensaver. Holding both page buttons does the same and opens the Home screen. |
| *Show status / log* | Prints state, battery and the log tail on the screen. |

The former *freeze UI* entry (KOReader's "disable pillow + `SIGSTOP awesome`"
recipe) froze the Kindle on FW 5.16.2 and was removed: that recipe only works
for a foreground app that owns the input and resumes the window manager itself.

The loop: wait for network → `curl`/`wget` the PNG (kept on tmpfs) → `fbink -g`
(first frame and every `FULL_REFRESH_EVERY` frames a full, flashing refresh,
also after a failed fetch; otherwise partial) → report battery to `STATUS_URL`
every `BATTERY_REPORT_EVERY` seconds → sleep `INTERVAL`. On fetch errors the
last image stays and a small `offline since HH:MM (n)` marker is printed at the
bottom. Below `LOW_BATTERY_PERCENT` a `battery N%` marker is shown.

Logs: `/mnt/us/extensions/kindledash/log/kindledash.log`. Each start logs the
tools it found (`Tools: http=… fbink=… eips=… lipc=…`), the battery source,
the orientation state, the frame vs framebuffer geometry, every drawn frame
with the framebuffer rotation it was fetched for, and every failed
`fbink`/`eips`/`lipc-set-prop` call with its exit code and stderr. "Fetch once OK" without a "Drew" line before it never happens any more:
a fetched-but-not-drawn frame is reported as such on screen and in the log.

### Buttons (Oasis page buttons)

Since extension 0.3.0 the daemon reads the two page buttons (Linux input
events, `gpio-keys`) and uses them for the front light. With the Kindle
rotated so that the buttons are at the bottom (`rotation: 270` in the app):

| Gesture | Effect |
|---------|--------|
| Right button (the upper one in portrait, key code 104) | Front light **+2** (`BUTTON_LIGHT_STEP`), `Light 12/24` shown at the bottom for a second, then the frame is redrawn. |
| Left button (the lower one, key code 109) | Front light **−2**. Clamped to `LIGHT_MIN`–`LIGHT_MAX` (0–24 on the Oasis, `(max)`/`(min)` in the message). |
| Both held for `BUTTON_HOLD_SECONDS` (1 s) | Stops the daemon exactly like *Stop dashboard* (UI and screensaver restored, `start lab126_gui` after a `stop_framework` run) and opens the Home screen. Releasing either button earlier cancels it. |

Single presses act on release; a press of both never changes the light. The
light is set through `lipc-set-prop com.lab126.powerd flIntensity`, the same
property the Kindle's own slider uses, so the slider shows the new value.

Everything is in `config.sh`: `BUTTONS=1` (0 disables the listener), the two
key codes (swap them to swap the buttons), the step, the range, the hold time,
the message time and `BUTTON_DEVICE` to force `/dev/input/eventN`. Without an
override the daemon picks the input device whose sysfs key bitmap
(`/sys/class/input/eventN/device/capabilities/key`) lists both codes, else the
first one named like `gpio-keys`, and logs the choice together with every
input device's name (`Buttons: /dev/input/event1 ("gpio-keys") reports keys
104 and 109; input devices: event0="…" …`, then `Buttons: listening on …`).
Every press and release is logged (`Buttons: key 104 (up) pressed`), so is
each light change (`Light 10 -> 12/24 (key up)`), an unmapped key such as
power (`key 116 pressed (not mapped)`), the cancelled or completed hold and
the Home screen call.

How it works: a background subshell of the daemon reads one 16-byte
`input_event` at a time with `dd bs=16 count=1` (a blocking read, nothing
buffered) and decodes it with `od`. busybox `sh` cannot `ioctl(EVIOCGRAB)`,
so there is no exclusive grab: in `keep` mode the Kindle UI receives the same
presses (the Home screen pages underneath the dashboard, which the redraw a
second later covers again). In `stop_framework` mode nothing else listens and
the buttons are the only way to leave besides the `STOP` file. The listener is
started after the UI mode is applied and stopped first on every exit; *Stop
dashboard* and `bin/stop.sh` also kill a leftover `dd` reader, so no reader
survives the daemon.

Buttons do nothing? Check `Show status / log` for the `Buttons:` lines: no
`listening on` line means detection failed (the log lists the devices it saw;
set `BUTTON_DEVICE`), presses without `Light` lines mean lipc could not read
`flIntensity`, no `pressed` lines at all mean the wrong device (try the other
`eventN` names from the list).

## Tuning: what worked on the Oasis 2

Real numbers from the reference deployment (HAOS VM, HA on port 80, Kindle
Oasis 2 on firmware 5.16.2.1.1, `/dashboard-test-2`):

| Setting | Value | Why |
|---------|-------|-----|
| HAOS VM | **4 vCPU / 4 GB RAM** | With 2 vCPU / 2 GB headless Chromium timed out constantly and only every ~10th frame rendered; with 4/4 zero timeouts and zero errors over the same dashboard. |
| `width` / `height` | `1680` / `1264` | Landscape viewport for the 1264x1680 panel. |
| `rotation` | `270` | Page buttons at the bottom in this mount (`90` puts them at the top). The daemon compensates the Oasis 180° flips, see [Orientation](#orientation). |
| `zoom` | `1.5` | At 300 ppi the cards are tiny at 1.0; 2.0 was too much. |
| `contrast` | `0.95` | The default 1.15 was too harsh on the real panel with the default dithering. |
| `interval` | `60` | `INTERVAL=60` on the Kindle to match. |
| `ha_url` | empty | Auto-detected via the Supervisor; HA listens on port 80 here. |
| `gray_levels` / `dither` | `16` / `true` | Defaults. |

Symptoms of a host that is too small, before you touch anything else:

- app log: `Render timed out after 45000 ms during <phase>` (typically
  `navigate`, `wait-dashboard` or `screenshot`) on most renders;
- `/status`: `render_count` growing much slower than one per `interval` and
  `consecutive_errors` above 0;
- HA: `sensor.<name>_renderer_status` flapping between `ok` and `error`, the
  Kindle showing the same frame for minutes.

`zoom` is a CSS zoom of the page body: `1.5` makes the viewport effectively
1120x843 CSS pixels (1680/1.5 x 1264/1.5), so the dashboard reflows as on a
smaller screen. Fewer cards fit per row, text and icons get larger. Design the
dashboard for the zoomed size, or use a dedicated single-column view.

`contrast` multiplies the gray values around mid-gray before quantising to
`gray_levels`; values above 1 push light grays to white and dark grays to
black. On the Oasis panel 1.15 lost card borders and light text, 0.95 kept
them. The default stays at 1.15 because it also drives the ghosting advice
below; set 0.95 if the picture looks harsh.

## Configuration reference

- App options: [addon/DOCS.md](addon/DOCS.md).
- Kindle: [kindle/extensions/kindledash/config.sh](kindle/extensions/kindledash/config.sh) is self-documented (server, timing, display, UI mode, buttons).
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
validator and an amd64 Docker build of the app; it can also be started by hand
(*Run workflow*).

## Troubleshooting

**Ghosting / grey residue.** Lower `FULL_REFRESH_EVERY` (every full refresh
flashes black→white). Increase `contrast` in the app (1.3–1.6) or set
`gray_levels: 2` for pure black and white. Keep dithering on for photos and
graphs, off for text-only dashboards. Picture too harsh instead (thin borders
and light text gone)? Lower `contrast` to about 0.95.

**Image is rotated, cut off or blank.** See [Orientation](#orientation): the
framebuffer is portrait, `fbink` does not rotate, so the PNG must be 1264 wide
x 1680 high (`rotation: 90` or `270` with a landscape viewport). *Show status /
log* prints the frame and framebuffer sizes. Add `w=-2,h=-2` to
`FBINK_IMG_OPTS` to scale to fit instead of cropping. A blank screen after
*Fetch once* means the fetch failed; the log tail names the reason.

**Image upside down, but only sometimes.** The Oasis framebuffer flips 180°
with the accelerometer (`rota=0` vs `rota=2` in the log). Extension 0.2.2 with
app 0.2.2 compensates on every fetch; make sure both are updated (`Tools:`
line and `fb_rotate=` in the log, `version` in `/status`). If it is upside
down *and* the log says `rota=0`, swap `rotation` 90 <-> 270 in the app.

**Page buttons do nothing.** See [Buttons](#buttons-oasis-page-buttons): the
log tail names the input device the daemon picked and every device it saw.
Set `BUTTON_DEVICE="/dev/input/eventN"` to one of them, restart, and press
again; the matching `Buttons: key N pressed` lines tell you the codes to put
in `BUTTON_LIGHT_UP` / `BUTTON_LIGHT_DOWN`. In `keep` mode the Home screen
pages underneath the dashboard on every press; use `stop_framework` for a
wall display.

**Most renders time out, only every ~10th frame reaches the Kindle.** The host
is too small for headless Chromium: 2 vCPU / 2 GB was not enough, 4 vCPU / 4 GB
is, see [Tuning](#tuning-what-worked-on-the-oasis-2).

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

**App log says "is not the Home Assistant frontend (HTTP 404 ...)" or "Could
not load".** `ha_url` (or `dashboard_path`) points at something that is not
the HA frontend: a mistyped URL such as `http://10.3.0.104/8123`, a port HA
does not listen on (`ERR_CONNECTION_REFUSED`), or a reverse proxy. Leave
`ha_url` empty on HAOS or set it to the URL HA really answers on; the
screenshot at `/last-error.png` shows what Chromium got.

**Header / sidebar still visible.** The hide logic walks the frontend's shadow
DOM and may lag behind a frontend release. Install the *kiosk-mode* HACS
plugin and set `url_query: ?kiosk`.

**Cards are tiny.** 300 ppi: set `zoom: 1.5` (2.0 was too much on the Oasis),
or design a dedicated dashboard for the Kindle (one column, large fonts, light
theme). Zoom shrinks the CSS viewport and reflows the cards, see
[Tuning](#tuning-what-worked-on-the-oasis-2).

**Chromium fails to start in the app.** The app disables AppArmor and passes
`--no-sandbox`; on a small host raise the RAM and CPU (4 vCPU / 4 GB worked,
2 / 2 did not). The watchdog restarts the app if `/health` stops answering.

## Security

- The HA long-lived token lives only in the app's options and in Chromium's
  profile inside the container.
- The Kindle never holds the HA token: it only has the device token, which
  grants access to one image and the status endpoint.
- Traffic Kindle ↔ HA is plain HTTP on the LAN. Put the Kindle on a trusted
  network.

## License

MIT, see [LICENSE](LICENSE).

#!/bin/sh
# Dry run of the Kindle daemon under busybox sh with fake fbink/curl/lipc tools.
# Checks the framebuffer-rotation handling: the fb_rotate query parameter the daemon
# sends, the log lines it writes, the mid-interval re-fetch when the rotation flips,
# and the optional orientation lock with its restore on stop. Then the hardware
# buttons: input device detection from a fake sysfs, a fake /dev/input stream of
# 16-byte input_event records (32-bit ARM layout), front light steps and clamping,
# the both-held exit (daemon stops, Home screen, no reader left behind).
# Usage: kindle/test/dry-run.sh   (needs busybox and a POSIX sh; no device, no network)
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
DAEMON="${HERE}/../extensions/kindledash/bin/kindledash.sh"
# Absolute path: PATH is replaced below and must not contain the real system tools.
BUSYBOX="$(command -v "${BUSYBOX:-busybox}" 2>/dev/null || true)"
[ -n "${BUSYBOX}" ] || { echo "busybox not found" >&2; exit 2; }

T="$(mktemp -d)"
pid=""
cleanup() {
    if [ -n "${pid}" ]; then kill "${pid}" 2>/dev/null || true; fi
    rm -rf "${T}"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
FAKE="${T}/fake"
BB="${T}/bb"
EXT="${T}/ext"
RUN="${T}/run"
mkdir -p "${FAKE}" "${BB}" "${EXT}" "${RUN}"

# Every applet busybox offers, so the daemon runs on the same tools as on the Kindle.
for applet in $("${BUSYBOX}" --list); do
    ln -sf "${BUSYBOX}" "${BB}/${applet}"
done

# --- fakes --------------------------------------------------------------------
# fbink: -e prints the state line with the rotation from $FAKE/rota (empty file = no rota);
# every other call is recorded. Must not contain the "Image support is disabled" marker.
cat >"${FAKE}/fbink" <<FBINK
#!/bin/sh
case "\$1" in
    -e)
        rota="\$(cat "${FAKE}/rota" 2>/dev/null)"
        line="FBINK_VERSION='v1.25.0';viewWidth=1264;viewHeight=1680;screenWidth=1264;screenHeight=1680;FBID='0P8';deviceName='Oasis 2'"
        [ -n "\${rota}" ] && line="\${line};currentRota=\${rota}"
        echo "\${line};canRotate=0;"
        ;;
    *) echo "fbink \$*" >>"${FAKE}/fbink.log" ;;
esac
exit 0
FBINK
# curl: records the URL and writes the fixture PNG to the -o target.
cat >"${FAKE}/curl" <<CURL
#!/bin/sh
out=""
url=""
while [ \$# -gt 0 ]; do
    case "\$1" in
        -o) out="\$2"; shift ;;
        -m|-H|-d) shift ;;
        -*) ;;
        *) url="\$1" ;;
    esac
    shift
done
echo "\${url}" >>"${FAKE}/curl.log"
[ -n "\${out}" ] && [ "\${out}" != "/dev/null" ] && cp "${FAKE}/fixture.png" "\${out}"
exit 0
CURL
cat >"${FAKE}/lipc-get-prop" <<LIPC
#!/bin/sh
f="${FAKE}/prop.\$1.\$2"
[ -f "\${f}" ] && cat "\${f}" && exit 0
exit 1
LIPC
# lipc-set-prop: records the call and stores the value so that lipc-get-prop returns it.
cat >"${FAKE}/lipc-set-prop" <<LIPC
#!/bin/sh
echo "\$*" >>"${FAKE}/lipc-set.log"
echo "\$3" >"${FAKE}/prop.\$1.\$2"
exit 0
LIPC
printf '#!/bin/sh\nexit 0\n' >"${FAKE}/ping"
chmod 755 "${FAKE}"/fbink "${FAKE}"/curl "${FAKE}"/lipc-get-prop "${FAKE}"/lipc-set-prop "${FAKE}"/ping
# 1x1 8-bit grayscale PNG.
printf '\211PNG\r\n\032\n\000\000\000\015IHDR\000\000\000\001\000\000\000\001\010\000\000\000\000\072\176\233\125\000\000\000\012IDAT\010\327\143\140\000\000\000\002\000\001\342\041\274\063\000\000\000\000IEND\256\102\140\202' >"${FAKE}/fixture.png"
echo 87 >"${FAKE}/prop.com.lab126.powerd.battLevel"
echo 0 >"${FAKE}/prop.com.lab126.powerd.isCharging"
echo U >"${FAKE}/prop.com.lab126.winmgr.orientation"
echo U >"${FAKE}/prop.com.lab126.winmgr.accelerometer"
echo off >"${FAKE}/prop.com.lab126.winmgr.orientationLock"
echo 10 >"${FAKE}/prop.com.lab126.powerd.flIntensity"

# Fake input: sysfs with a touchscreen (BTN_TOUCH only) and a gpio-keys device whose key
# bitmap lists 104, 109 and 116 (power) in 32-bit words, most significant first; the
# matching /dev/input/event1 is a FIFO the test writes input_event records into.
SYS="${T}/sys"
DEV="${T}/dev"
mkdir -p "${SYS}/event0/device/capabilities" "${SYS}/event1/device/capabilities" "${DEV}"
echo "touchscreen" >"${SYS}/event0/device/name"
echo "400 0 0 0 0 0 0 0 0 0 0" >"${SYS}/event0/device/capabilities/key"
echo "gpio-keys" >"${SYS}/event1/device/name"
echo "102100 0 0 0" >"${SYS}/event1/device/capabilities/key"
mkfifo "${DEV}/event1"
# Keep the FIFO open read-write for the whole run: opening it only for writing would block
# until the daemon reads, and closing it would feed the listener an EOF.
exec 3<>"${DEV}/event1"
le32() { printf '\\%03o\\%03o\\%03o\\%03o' $(($1 & 255)) $((($1 >> 8) & 255)) $((($1 >> 16) & 255)) $((($1 >> 24) & 255)); }
le16() { printf '\\%03o\\%03o' $(($1 & 255)) $((($1 >> 8) & 255)); }
input_event() {
    # $1 = tv_sec, $2 = tv_usec, $3 = type, $4 = code, $5 = value: one 16-byte record.
    # shellcheck disable=SC2059
    printf "$(le32 "$1")$(le32 "$2")$(le16 "$3")$(le16 "$4")$(le32 "$5")" >&3
}
press() { input_event 1 0 1 "$1" 1; input_event 1 0 0 0 0; }
release() { input_event 1 0 1 "$1" 0; input_event 1 0 0 0 0; }

export PATH="${FAKE}:${BB}"
export KINDLEDASH_DIR="${EXT}"
export KINDLEDASH_RUN_DIR="${RUN}"
export KINDLEDASH_INPUT_SYS="${SYS}"
export KINDLEDASH_INPUT_DEV="${DEV}"
LOG="${EXT}/log/kindledash.log"

# --- helpers ------------------------------------------------------------------
failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }
expect_grep() { grep -q -- "$1" "$2" || fail "expected '$1' in $(basename "$2")"; }
expect_no_grep() { ! grep -q -- "$1" "$2" || fail "did not expect '$1' in $(basename "$2")"; }
wait_for() {
    # $1 = pattern, $2 = file, $3 = max tenths of a second
    n=0
    while ! grep -q -- "$1" "$2" 2>/dev/null; do
        n=$((n + 1))
        [ "${n}" -ge "$3" ] && return 1
        sleep 0.1
    done
    return 0
}
reset() {
    rm -rf "${EXT}" "${RUN}" "${FAKE}/curl.log" "${FAKE}/fbink.log" "${FAKE}/lipc-set.log"
    mkdir -p "${EXT}/log" "${RUN}"
    # Run the tmpfs copy directly (the script re-execs itself from RUN_DIR otherwise).
    cp "${DAEMON}" "${RUN}/kindledash.sh"
    cat >"${EXT}/config.sh" <<CFG
IMAGE_URL="http://ha.test/api/kindle_dashboard/image"
STATUS_URL="http://ha.test/api/kindle_dashboard/status"
TOKEN="t0k3n"
INTERVAL=${1:-60}
ROTATION_POLL=${2:-5}
ORIENTATION_LOCK="${3:-}"
BATTERY_REPORT_EVERY=1
FULL_REFRESH_EVERY=5
HTTP_TIMEOUT=5
FBINK_BIN="${FAKE}/fbink"
# busybox sh prefers its own applets, so a fake ping is never used: skip the check.
WIFI_TEST_HOST="none"
BUTTONS=${BUTTONS:-0}
BUTTON_DEVICE="${BUTTON_DEVICE:-}"
BUTTON_LIGHT_STEP=2
BUTTON_HOLD_SECONDS=1
BUTTON_MESSAGE_SECONDS=1
CFG
}
stop_daemon() {
    # Waits up to $1 tenths of a second for the daemon to exit, kills it otherwise.
    n=0
    while kill -0 "${pid}" 2>/dev/null; do
        n=$((n + 1))
        [ "${n}" -ge "$1" ] && { kill "${pid}"; return 1; }
        sleep 0.1
    done
    return 0
}
daemon() { "${BUSYBOX}" sh "${RUN}/kindledash.sh" "$@"; }

# --- 1. fetch once, framebuffer upright -----------------------------------------
echo 0 >"${FAKE}/rota"
reset
daemon --once || fail "daemon --once exited with rc=$?"
expect_grep '/image?token=t0k3n&fb_rotate=0$' "${FAKE}/curl.log"
expect_grep 'Orientation: fb rota=0 winmgr orientation=U accelerometer=U orientationLock=off' "${LOG}"
expect_grep 'Fetch once: fb rota=0, requesting fb_rotate=0' "${LOG}"
expect_grep 'Frame 1x1 (8/0 bitdepth/colortype), framebuffer 1264x1680 rota=0' "${LOG}"
expect_grep 'Fetch once OK (fb rota=0)' "${LOG}"
expect_grep 'fbink -q -c -f -g file=' "${FAKE}/fbink.log"

# --- 2. fetch once, framebuffer upside down -------------------------------------
echo 2 >"${FAKE}/rota"
reset
daemon --once || fail "daemon --once exited with rc=$?"
expect_grep '/image?token=t0k3n&fb_rotate=2$' "${FAKE}/curl.log"
expect_grep 'Fetch once OK (fb rota=2)' "${LOG}"

# --- 3. fetch once, fbink reports no rotation -----------------------------------
: >"${FAKE}/rota"
reset
daemon --once || fail "daemon --once exited with rc=$?"
expect_grep '/image?token=t0k3n$' "${FAKE}/curl.log"
expect_no_grep 'fb_rotate' "${FAKE}/curl.log"
expect_grep 'Orientation: fb rota=?' "${LOG}"
expect_grep 'Fetch once OK (fb rota=unknown)' "${LOG}"

# --- 4. loop: rotation flips mid-interval, STOP file, orientation lock ------------
echo 0 >"${FAKE}/rota"
reset 30 1 U
# Not via daemon(): a background function runs in a subshell, which is what $! would name.
"${BUSYBOX}" sh "${RUN}/kindledash.sh" keep &
pid=$!
wait_for 'Drew frame 1 (fb rota=0, fb_rotate=0, full=1)' "${LOG}" 100 || fail "first frame not drawn"
expect_grep 'Framebuffer rota=0 (was unknown): requesting fb_rotate=0, full refresh' "${LOG}"
expect_grep 'Orientation lock set: orientationLock=U (was off)' "${LOG}"
expect_grep '^com.lab126.winmgr orientationLock U$' "${FAKE}/lipc-set.log"
expect_grep 'status?token=t0k3n$' "${FAKE}/curl.log"

echo 2 >"${FAKE}/rota"
wait_for 'Drew frame 2 (fb rota=2, fb_rotate=2, full=1)' "${LOG}" 100 || fail "no re-fetch after the rotation flip"
expect_grep 'Framebuffer rotation changed: rota 0 -> 2, fetching a counter-rotated frame now' "${LOG}"
expect_grep 'Framebuffer rota=2 (was 0): requesting fb_rotate=2, full refresh' "${LOG}"
expect_grep '/image?token=t0k3n&fb_rotate=2$' "${FAKE}/curl.log"
[ "$(grep -c '/image?' "${FAKE}/curl.log")" -eq 2 ] || fail "expected exactly 2 image fetches, got $(grep -c '/image?' "${FAKE}/curl.log")"

touch "${EXT}/STOP"
n=0
while kill -0 "${pid}" 2>/dev/null; do
    n=$((n + 1))
    [ "${n}" -ge 100 ] && { fail "daemon did not stop on STOP file"; kill "${pid}"; break; }
    sleep 0.1
done
wait "${pid}" 2>/dev/null || true
expect_grep 'Stop file found' "${LOG}"
expect_grep 'Orientation lock restored: orientationLock=off' "${LOG}"
expect_grep '^com.lab126.winmgr orientationLock off$' "${FAKE}/lipc-set.log"
expect_grep '^com.lab126.powerd preventScreenSaver 0$' "${FAKE}/lipc-set.log"

# --- 5. loop without lock: no winmgr writes, SIGTERM stops it -------------------
echo 0 >"${FAKE}/rota"
reset 30 1
# Not via daemon(): a background function runs in a subshell, which is what $! would name.
"${BUSYBOX}" sh "${RUN}/kindledash.sh" keep &
pid=$!
wait_for 'Drew frame 1 ' "${LOG}" 100 || fail "first frame not drawn (no lock)"
expect_no_grep 'orientationLock' "${FAKE}/lipc-set.log"
kill -TERM "${pid}"
wait "${pid}" 2>/dev/null || true
expect_grep 'Stopping (signal/exit)' "${LOG}"
expect_no_grep 'Orientation lock restored' "${LOG}"

# --- 6. buttons: detection, light up/down, clamping, cancelled hold, held exit ------
echo 0 >"${FAKE}/rota"
echo 10 >"${FAKE}/prop.com.lab126.powerd.flIntensity"
BUTTONS=1 reset 30 1
"${BUSYBOX}" sh "${RUN}/kindledash.sh" keep &
pid=$!
wait_for 'Drew frame 1 ' "${LOG}" 100 || fail "first frame not drawn (buttons)"
wait_for 'Buttons: listening on ' "${LOG}" 50 || fail "listener not started"
expect_grep "Buttons: ${DEV}/event1 (\"gpio-keys\") reports keys 104 and 109; input devices: event0=\"touchscreen\" event1=\"gpio-keys\"" "${LOG}"
expect_grep "Buttons: listening on ${DEV}/event1 (pid [0-9]*): key 104 = light +2, key 109 = light -2 (0-24), both held 1s = stop; mode keep" "${LOG}"
# upper button: +2
press 104; release 104
wait_for 'Light 10 -> 12/24 (key up)' "${LOG}" 50 || fail "light not raised"
expect_grep 'Buttons: key 104 (up) pressed' "${LOG}"
expect_grep 'Buttons: key 104 (up) released' "${LOG}"
expect_grep '^com.lab126.powerd flIntensity 12$' "${FAKE}/lipc-set.log"
expect_grep 'fbink -q -y -1 -m  Light 12/24 $' "${FAKE}/fbink.log"
wait_for 'fbink -q -g file=.*current.png' "${FAKE}/fbink.log" 50 || fail "frame not redrawn after the light message"
# lower button: -2, twice
press 109; release 109
wait_for 'Light 12 -> 10/24 (key down)' "${LOG}" 50 || fail "light not lowered"
press 109; release 109
wait_for 'Light 10 -> 8/24 (key down)' "${LOG}" 50 || fail "light not lowered twice"
# clamp at the top
echo 23 >"${FAKE}/prop.com.lab126.powerd.flIntensity"
press 104; release 104
wait_for 'Light 23 -> 24/24 (key up)' "${LOG}" 50 || fail "light not clamped to 24"
expect_grep 'fbink -q -y -1 -m  Light 24/24 (max) $' "${FAKE}/fbink.log"
press 104; release 104
wait_for 'Light stays 24/24 (key up, at the limit)' "${LOG}" 50 || fail "no limit message"
# unmapped key (power) is logged and ignored
press 116; release 116
wait_for 'Buttons: key 116 pressed (not mapped)' "${LOG}" 50 || fail "unmapped key not logged"
# both pressed, released before the hold time: no light change, no exit
sets="$(grep -c flIntensity "${FAKE}/lipc-set.log")"
press 104; press 109
sleep 0.3
release 109; release 104
wait_for 'Buttons: released before 1s, exit cancelled' "${LOG}" 50 || fail "short double press not cancelled"
sleep 0.3
[ "$(grep -c flIntensity "${FAKE}/lipc-set.log")" -eq "${sets}" ] || fail "double press changed the light"
kill -0 "${pid}" 2>/dev/null || fail "daemon exited on a short double press"
# both held: daemon stops, UI restored, Home screen, dd reader gone
dd_pid="$(cat "${RUN}/buttons.dd" 2>/dev/null)"
[ -n "${dd_pid}" ] || fail "no dd pid recorded"
press 104; press 109
stop_daemon 60 || fail "daemon did not stop on the held buttons"
wait "${pid}" 2>/dev/null || true
expect_grep 'Buttons: both held 1s: stopping the dashboard, back to Home' "${LOG}"
expect_grep 'Buttons: listener stopped' "${LOG}"
expect_grep '^com.lab126.appmgrd start app://com.lab126.booklet.home$' "${FAKE}/lipc-set.log"
expect_grep 'Returned to the Home screen (try 1)' "${LOG}"
expect_grep '^com.lab126.powerd preventScreenSaver 0$' "${FAKE}/lipc-set.log"
sleep 0.2
! kill -0 "${dd_pid}" 2>/dev/null || fail "dd reader (pid ${dd_pid}) still alive after exit"
[ ! -f "${RUN}/buttons.dd" ] || fail "buttons.dd not cleaned up"
[ ! -f "${RUN}/pid" ] || fail "pidfile not removed"
# (no release events: nothing reads the FIFO now and they would reach the next daemon)

# --- 7. buttons: BUTTON_DEVICE override, SIGTERM leaves no reader ----------------
BUTTONS=1 BUTTON_DEVICE="${DEV}/event1" reset 30 1
"${BUSYBOX}" sh "${RUN}/kindledash.sh" keep &
pid=$!
wait_for 'Buttons: listening on ' "${LOG}" 100 || fail "listener not started (override)"
expect_grep "Buttons: using BUTTON_DEVICE=${DEV}/event1 from config.sh" "${LOG}"
expect_no_grep 'reports keys' "${LOG}"
wait_for 'Drew frame 1 ' "${LOG}" 100 || fail "first frame not drawn (override)"
dd_pid="$(cat "${RUN}/buttons.dd" 2>/dev/null)"
kill -TERM "${pid}"
stop_daemon 50 || fail "daemon did not stop on SIGTERM (buttons)"
wait "${pid}" 2>/dev/null || true
expect_grep 'Buttons: listener stopped' "${LOG}"
expect_no_grep 'booklet.home' "${FAKE}/lipc-set.log"
sleep 0.2
[ -n "${dd_pid}" ] || fail "no dd pid recorded (override)"
! kill -0 "${dd_pid}" 2>/dev/null || fail "dd reader still alive after SIGTERM"

# --- 8. buttons disabled / no device ----------------------------------------------
BUTTONS=0 reset 30 1
daemon --once || fail "daemon --once exited with rc=$?"
expect_no_grep 'Buttons:' "${LOG}"
BUTTONS=1 BUTTON_DEVICE="${DEV}/missing" reset 30 1
"${BUSYBOX}" sh "${RUN}/kindledash.sh" keep &
pid=$!
wait_for 'Drew frame 1 ' "${LOG}" 100 || fail "first frame not drawn (missing device)"
expect_grep "Buttons: ${DEV}/missing does not exist or is not readable, listener not started" "${LOG}"
kill -TERM "${pid}"
wait "${pid}" 2>/dev/null || true
expect_no_grep 'listener stopped' "${LOG}"

if [ "${failures}" -gt 0 ]; then
    echo "--- kindledash.log"; cat "${LOG}" 2>/dev/null
    echo "--- curl.log"; cat "${FAKE}/curl.log" 2>/dev/null
    echo "--- lipc-set.log"; cat "${FAKE}/lipc-set.log" 2>/dev/null
    echo "--- fbink.log"; cat "${FAKE}/fbink.log" 2>/dev/null
    echo "dry-run: ${failures} failure(s)" >&2
    exit 1
fi
echo "dry-run: all checks passed"

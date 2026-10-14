#!/bin/sh
# Kindle Dashboard daemon: fetch PNG, draw with fbink, report battery, repeat.
# Runs on jailbroken Kindle firmware 5.x (busybox sh). Started by bin/start.sh
# or directly: kindledash.sh [keep|stop_framework] [--once]

# KUAL does not guarantee a sane PATH for the scripts it launches; lipc-*,
# eips, gasgauge-info and the upstart tools all live in /usr/bin and /sbin.
PATH="${PATH}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

EXT_DIR="${KINDLEDASH_DIR:-/mnt/us/extensions/kindledash}"
RUN_DIR="${KINDLEDASH_RUN_DIR:-/var/tmp/kindledash}"
PIDFILE="${RUN_DIR}/pid"
LOG_FILE="${EXT_DIR}/log/kindledash.log"
STOP_FILE="${EXT_DIR}/STOP"

# /mnt/us is vfat over fuse: run a copy of this script from tmpfs so that
# USB drive mode or an update of the extension cannot pull the rug from under us.
if [ "$(dirname "$0")" != "${RUN_DIR}" ]; then
    mkdir -p "${RUN_DIR}"
    cp -f "$0" "${RUN_DIR}/kindledash.sh"
    chmod 755 "${RUN_DIR}/kindledash.sh"
    exec "${RUN_DIR}/kindledash.sh" "$@"
fi

mkdir -p "${RUN_DIR}" "${EXT_DIR}/log"

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
IMAGE_URL=""
STATUS_URL=""
TOKEN=""
INTERVAL=60
FULL_REFRESH_EVERY=5
BATTERY_REPORT_EVERY=300
LOW_BATTERY_PERCENT=15
HTTP_TIMEOUT=30
MAX_RUNTIME=0
FBINK_BIN=""
FBINK_IMG_OPTS="halign=CENTER,valign=CENTER"
UI_MODE="keep"
WIFI_TEST_HOST=""
ORIENTATION_LOCK=""
ROTATION_POLL=5
# Hardware buttons (Oasis page buttons): see config.sh.
BUTTONS=1
BUTTON_DEVICE=""
BUTTON_LIGHT_UP=104
BUTTON_LIGHT_DOWN=109
BUTTON_LIGHT_STEP=2
BUTTON_HOLD_SECONDS=1
BUTTON_MESSAGE_SECONDS=1
LIGHT_MIN=0
LIGHT_MAX=24
# Where input devices are looked up (overridden by the dry run).
INPUT_SYS="${KINDLEDASH_INPUT_SYS:-/sys/class/input}"
INPUT_DEV="${KINDLEDASH_INPUT_DEV:-/dev/input}"

if [ -f "${EXT_DIR}/config.sh" ]; then
    # shellcheck disable=SC1091
    . "${EXT_DIR}/config.sh"
fi

ONCE=0
for arg in "$@"; do
    case "${arg}" in
        keep | stop_framework | freeze) UI_MODE="${arg}" ;;
        --once) ONCE=1 ;;
    esac
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >>"${LOG_FILE}"
}

rotate_log() {
    if [ -f "${LOG_FILE}" ] && [ "$(wc -c <"${LOG_FILE}")" -gt 262144 ]; then
        tail -n 300 "${LOG_FILE}" >"${LOG_FILE}.tmp" && mv -f "${LOG_FILE}.tmp" "${LOG_FILE}"
    fi
}

# Run a command, keep its stderr, log it with the exit code when it fails.
# $1 = label for the log, rest = command. Returns the command's exit code.
STDERR_FILE="${RUN_DIR}/stderr"
run_logged() {
    label="$1"
    shift
    "$@" >/dev/null 2>"${STDERR_FILE}"
    rc=$?
    if [ "${rc}" -ne 0 ]; then
        log "${label} failed rc=${rc}: $(tr '\n' ' ' <"${STDERR_FILE}" | cut -c1-300)"
    fi
    return "${rc}"
}

fbink_has_image_support() {
    # FBInk built with MINIMAL=1 (KOReader's copy) compiles the image code out and
    # replies "Image support is disabled in this FBInk build" to -g. That message
    # only exists in such builds, so its presence in the binary is the tell.
    ! grep -q 'Image support is disabled in this FBInk build' "$1" 2>/dev/null
}

find_fbink() {
    # Prints the first fbink that can draw images. Candidates: our own copy, the
    # one installed by the KindleModding hotfix (full build), KOReader's (text
    # only), a system one. Logs every rejected candidate.
    if [ -n "${FBINK_BIN}" ]; then
        [ -f "${FBINK_BIN}" ] || log "FBINK_BIN=${FBINK_BIN} not found"
        set -- "${FBINK_BIN}"
    else
        set -- "${EXT_DIR}/bin/fbink" /mnt/us/libkh/bin/fbink /mnt/us/koreader/fbink /usr/bin/fbink
    fi
    for candidate in "$@"; do
        [ -f "${candidate}" ] || continue
        if fbink_has_image_support "${candidate}"; then
            echo "${candidate}"
            return 0
        fi
        log "Skipping ${candidate}: built without image support (cannot draw PNG)"
    done
    return 1
}

# Copy fbink to tmpfs too (same vfat reasoning as above).
FBINK_SRC="$(find_fbink)"
FBINK=""
if [ -n "${FBINK_SRC}" ]; then
    cp -f "${FBINK_SRC}" "${RUN_DIR}/fbink" && chmod 755 "${RUN_DIR}/fbink" && FBINK="${RUN_DIR}/fbink"
fi
EIPS=""
command -v eips >/dev/null 2>&1 && EIPS="eips"

HTTP_CLIENT=""
if command -v curl >/dev/null 2>&1; then
    HTTP_CLIENT="curl"
elif command -v wget >/dev/null 2>&1; then
    HTTP_CLIENT="wget"
fi

url_host() {
    echo "$1" | sed -e 's|^[a-z]*://||' -e 's|/.*$||' -e 's|:.*$||'
}

say() {
    # Print one line of text at the bottom of the screen without disturbing the image much.
    if [ -n "${FBINK}" ]; then
        "${FBINK}" -q -y -1 -m "$1" >/dev/null 2>&1
    elif [ -n "${EIPS}" ]; then
        eips 0 39 "$1" >/dev/null 2>&1
    fi
}

DRAWS_OK=0
draw_image() {
    # $1 = png path, $2 = 1 for full refresh. Tries fbink, then eips.
    # Logs the first success and every failure (exit code + stderr).
    if [ -n "${FBINK}" ]; then
        fb_opts=""
        [ "$2" = "1" ] && fb_opts="-c -f"
        # shellcheck disable=SC2086
        if run_logged "fbink ${fb_opts} -g" "${FBINK}" -q ${fb_opts} -g "file=$1,${FBINK_IMG_OPTS}"; then
            [ "${DRAWS_OK}" -eq 0 ] && log "Drew $1 with ${FBINK_SRC} (full=$2)"
            DRAWS_OK=$((DRAWS_OK + 1))
            return 0
        fi
    fi
    if [ -n "${EIPS}" ]; then
        [ "$2" = "1" ] && eips -c >/dev/null 2>&1
        if run_logged "eips -g" eips -g "$1"; then
            [ "${DRAWS_OK}" -eq 0 ] && log "Drew $1 with eips (full=$2)"
            [ "$2" = "1" ] && eips -f >/dev/null 2>&1
            DRAWS_OK=$((DRAWS_OK + 1))
            return 0
        fi
    fi
    [ -n "${FBINK}${EIPS}" ] || log "No fbink with image support and no eips: cannot draw"
    return 1
}

http_get() {
    # $1 = url, $2 = output file
    case "${HTTP_CLIENT}" in
        curl) curl -s -f -m "${HTTP_TIMEOUT}" -o "$2" "$1" ;;
        wget) wget -q -T "${HTTP_TIMEOUT}" -O "$2" "$1" ;;
        *) return 127 ;;
    esac
}

http_post_json() {
    # $1 = url, $2 = json body
    case "${HTTP_CLIENT}" in
        curl) curl -s -f -m 15 -o /dev/null -H 'Content-Type: application/json' -d "$2" "$1" ;;
        wget) wget -q -T 15 -O /dev/null --post-data "$2" "$1" ;;
        *) return 127 ;;
    esac
}

is_png() {
    [ -s "$1" ] && [ "$(head -c 8 "$1" | od -An -tx1 | tr -d ' \n')" = "89504e470d0a1a0a" ]
}

png_size() {
    # Prints "WxH" from the PNG IHDR chunk (bytes 16-23, big endian).
    hex="$(od -An -tx1 -j16 -N8 "$1" 2>/dev/null | tr -d ' \n')"
    [ "${#hex}" -eq 16 ] || return 1
    printf '%dx%d' "0x$(echo "${hex}" | cut -c1-8)" "0x$(echo "${hex}" | cut -c9-16)"
}

png_format() {
    # Prints "bitdepth/colortype" from IHDR (bytes 24-25): 8/0 = 8-bit grayscale.
    hex="$(od -An -tx1 -j24 -N2 "$1" 2>/dev/null | tr -d ' \n')"
    [ "${#hex}" -eq 4 ] || return 1
    printf '%d/%d' "0x$(echo "${hex}" | cut -c1-2)" "0x$(echo "${hex}" | cut -c3-4)"
}

fb_state() {
    # Prints fbink -e output one "key=value" per line (empty without fbink).
    [ -n "${FBINK}" ] || return 1
    "${FBINK}" -e 2>/dev/null | tr ';' '\n'
}

fb_geometry() {
    # Prints "WxH rota=N" of the framebuffer as fbink sees it (fbink draws 1:1, no rotation on Kindle).
    state="$(fb_state)" || return 1
    w="$(echo "${state}" | sed -n 's/^viewWidth=//p')"
    h="$(echo "${state}" | sed -n 's/^viewHeight=//p')"
    r="$(echo "${state}" | sed -n 's/^currentRota=//p')"
    [ -n "${w}" ] && [ -n "${h}" ] || return 1
    printf '%sx%s rota=%s' "${w}" "${h}" "${r:-?}"
}

fb_rota() {
    # Prints the framebuffer rotation (Linux fbdev "rotate": 0 upright, 1 CW, 2 upside down, 3 CCW)
    # as fbink reports it (currentRota), or nothing when unknown. On the Oasis the framework
    # flips it between 0 and 2 from the accelerometer, which turns a fixed PNG upside down.
    r="$(fb_state 2>/dev/null | sed -n 's/^currentRota=\([0-3]\)$/\1/p')"
    [ -n "${r}" ] && echo "${r}"
}

image_url() {
    # $1 = framebuffer rotation (may be empty). The app counter-rotates the frame for fb_rotate.
    case "$1" in
        [0-3]) echo "${IMAGE_URL}?token=${TOKEN}&fb_rotate=$1" ;;
        *) echo "${IMAGE_URL}?token=${TOKEN}" ;;
    esac
}

winmgr_get() {
    # Prints a com.lab126.winmgr property or "?" (no lipc, property unknown).
    v="$(lipc-get-prop com.lab126.winmgr "$1" 2>/dev/null)"
    echo "${v:-?}"
}

check_geometry() {
    # $1 = png path. Logs frame vs framebuffer size and warns when the image would be cropped.
    img="$(png_size "$1")" || return 0
    fmt="$(png_format "$1")"
    fb="$(fb_geometry)" || { log "Frame ${img} (${fmt:-?} bitdepth/colortype), framebuffer unknown (no fbink)"; return 0; }
    log "Frame ${img} (${fmt:-?} bitdepth/colortype), framebuffer ${fb}"
    iw="${img%x*}"; ih="${img#*x}"
    fbw="${fb%%x*}"; fbh="${fb#*x}"; fbh="${fbh%% *}"
    if [ "${iw}" -gt "${fbw}" ] || [ "${ih}" -gt "${fbh}" ]; then
        log "WARNING: frame ${img} is larger than the framebuffer ${fbw}x${fbh}: it will be cropped. Landscape dashboard on a portrait framebuffer? Set rotation: 90 (or 270) in the app, keep width 1680 x height 1264."
        say " image ${img} > screen ${fbw}x${fbh}: set rotation 90 in app "
    fi
}

lipc_set() {
    # $1 = source, $2 = property, $3 = value. Logs failures (missing tool, unknown property).
    run_logged "lipc-set-prop $1 $2 $3" lipc-set-prop "$1" "$2" "$3"
}

battery_level() {
    # Prints the battery percentage (empty when unknown). $1 = "log" also logs the source.
    # powerd owns the battery on FW 5.x: lipc-get-prop com.lab126.powerd battLevel.
    level="$(lipc-get-prop com.lab126.powerd battLevel 2>/dev/null)"
    source="lipc"
    if ! [ "${level:-x}" -ge 0 ] 2>/dev/null; then
        level="$(gasgauge-info -c 2>/dev/null | tr -d '% ')"
        source="gasgauge-info"
    fi
    if ! [ "${level:-x}" -ge 0 ] 2>/dev/null; then
        for f in /sys/class/power_supply/*/capacity; do
            [ -r "${f}" ] && level="$(cat "${f}" 2>/dev/null)" && break
        done
        source="sysfs"
    fi
    if ! [ "${level:-x}" -ge 0 ] 2>/dev/null; then
        level=""
        source="none"
    fi
    [ "$1" = "log" ] && log "Battery: ${level:-unknown} (via ${source})"
    echo "${level}"
}

is_charging() {
    c="$(lipc-get-prop com.lab126.powerd isCharging 2>/dev/null)"
    [ "${c}" = "1" ] && echo true || echo false
}

firmware_version() {
    sed -n 's/^Kindle \([0-9.]*\).*/\1/p' /etc/prettyversion.txt 2>/dev/null | head -n 1
}

wait_for_wifi() {
    # WIFI_TEST_HOST=none skips the check (host drops ICMP, or tests).
    host="${WIFI_TEST_HOST:-$(url_host "${IMAGE_URL}")}"
    [ -n "${host}" ] && [ "${host}" != "none" ] || return 0
    tries=0
    while ! ping -c 1 -W 2 "${host}" >/dev/null 2>&1; do
        tries=$((tries + 1))
        if [ "${tries}" -eq 1 ]; then
            log "Waiting for network (${host})"
            lipc_set com.lab126.cmd wirelessEnable 1
        fi
        if [ "${tries}" -ge 30 ]; then
            log "Network still down after ${tries} tries"
            return 1
        fi
        sleep 2
    done
    return 0
}

# ---------------------------------------------------------------------------
# UI handling
# ---------------------------------------------------------------------------
UI_APPLIED=""

ORIENTATION_LOCK_PREV=""

ui_enter() {
    # Keep the device awake and Wi-Fi on while we run.
    lipc_set com.lab126.powerd preventScreenSaver 1
    lipc_set com.lab126.cmd wirelessEnable 1
    if [ -n "${ORIENTATION_LOCK}" ]; then
        # Ask the window manager to stop following the accelerometer. The frame is counter-rotated
        # from what fbink reports anyway, so this only avoids the flip itself, not a wrong picture.
        ORIENTATION_LOCK_PREV="$(winmgr_get orientationLock)"
        if lipc_set com.lab126.winmgr orientationLock "${ORIENTATION_LOCK}"; then
            log "Orientation lock set: orientationLock=${ORIENTATION_LOCK} (was ${ORIENTATION_LOCK_PREV}), now orientation=$(winmgr_get orientation) fb rota=$(fb_rota || echo '?')"
        else
            log "Orientation lock refused; relying on fb_rotate compensation only"
            ORIENTATION_LOCK_PREV=""
        fi
    fi
    case "${UI_MODE}" in
        freeze)
            # KOReader's SIGSTOP-the-window-manager recipe only works for a foreground app that
            # owns the input and resumes the WM itself; for a daemon it leaves the Kindle
            # unresponsive (seen on FW 5.16.2). Not supported any more: behave like keep.
            log "UI mode freeze was removed (froze the Kindle on FW 5.16); running in keep mode"
            UI_MODE="keep"
            ;;
        stop_framework)
            if [ -d /etc/upstart ]; then
                # The job sends SIGTERM to its process tree on stop: do not die with it.
                trap "" TERM
                run_logged "stop lab126_gui" stop lab126_gui
                trap - TERM
            else
                run_logged "framework stop" /etc/init.d/framework stop
            fi
            UI_APPLIED="stop_framework"
            # The teardown ends with the framework blanking the screen; wait for it so
            # that our first frame is not wiped (KOReader waits 1.25 s, be generous).
            tries=0
            while pidof awesome pillow >/dev/null 2>&1 && [ "${tries}" -lt 20 ]; do
                tries=$((tries + 1))
                sleep 1
            done
            sleep 3
            log "Framework stopped (waited $((tries + 3))s, still running: $(pidof awesome pillow cvm 2>/dev/null || echo none))"
            ;;
    esac
}

ui_leave() {
    lipc_set com.lab126.powerd preventScreenSaver 0
    if [ -n "${ORIENTATION_LOCK_PREV}" ] && [ "${ORIENTATION_LOCK_PREV}" != "?" ]; then
        lipc_set com.lab126.winmgr orientationLock "${ORIENTATION_LOCK_PREV}" && log "Orientation lock restored: orientationLock=${ORIENTATION_LOCK_PREV}"
        ORIENTATION_LOCK_PREV=""
    fi
    case "${UI_APPLIED}" in
        stop_framework)
            if [ -d /etc/upstart ]; then
                run_logged "start lab126_gui" start lab126_gui
            else
                run_logged "framework start" /etc/init.d/framework start
            fi
            ;;
    esac
    UI_APPLIED=""
}

# ---------------------------------------------------------------------------
# Hardware buttons: front light up/down, both held = stop and go Home
# ---------------------------------------------------------------------------
# The Oasis page buttons are plain Linux input keys (gpio-keys): code 104 for the
# upper, 109 for the lower button in portrait (KOReader's device.lua, KindleOasis2).
# A listener subshell reads one 16-byte input_event at a time with dd (blocking
# read, nothing buffered), decodes it with od and acts on EV_KEY releases.
# busybox sh cannot ioctl(EVIOCGRAB), so in keep mode the Kindle UI sees the same
# presses (it pages the Home screen under the dashboard; the frame is redrawn
# BUTTON_MESSAGE_SECONDS later). In stop_framework mode the buttons are ours alone.

caps_has_key() {
    # $1 = sysfs capabilities/key (hex words, most significant first, 32-bit words
    # on the Kindle's ARM kernel), $2 = key code. True when the bit is set.
    word=$(($2 / 32))
    bit=$(($2 % 32))
    # shellcheck disable=SC2086
    set -- $1
    [ $# -gt "${word}" ] || return 1
    skip=$(($# - word - 1))
    while [ "${skip}" -gt 0 ]; do
        shift
        skip=$((skip - 1))
    done
    [ $(((0x$1 >> bit) & 1)) -eq 1 ]
}

find_button_device() {
    # Prints the /dev/input/eventN to read. BUTTON_DEVICE from config.sh wins; else the
    # first device whose sysfs key bitmap has both mapped codes; else the first one whose
    # name looks like a key/button driver. Logs the choice and every candidate's name.
    if [ -n "${BUTTON_DEVICE}" ]; then
        log "Buttons: using BUTTON_DEVICE=${BUTTON_DEVICE} from config.sh"
        echo "${BUTTON_DEVICE}"
        return 0
    fi
    seen=""
    by_name=""
    for sys in "${INPUT_SYS}"/event*; do
        [ -e "${sys}" ] || continue
        ev="${sys##*/}"
        name="$(cat "${sys}/device/name" 2>/dev/null)"
        caps="$(cat "${sys}/device/capabilities/key" 2>/dev/null)"
        seen="${seen} ${ev}=\"${name:-?}\""
        if caps_has_key "${caps}" "${BUTTON_LIGHT_UP}" && caps_has_key "${caps}" "${BUTTON_LIGHT_DOWN}"; then
            log "Buttons: ${INPUT_DEV}/${ev} (\"${name}\") reports keys ${BUTTON_LIGHT_UP} and ${BUTTON_LIGHT_DOWN}; input devices:${seen}"
            echo "${INPUT_DEV}/${ev}"
            return 0
        fi
        case "${name}" in
            *gpio*key* | *button* | *keypad* | mxckpd*) [ -n "${by_name}" ] || by_name="${ev}" ;;
        esac
    done
    if [ -n "${by_name}" ]; then
        log "Buttons: no device lists keys ${BUTTON_LIGHT_UP}/${BUTTON_LIGHT_DOWN} in sysfs, trying ${INPUT_DEV}/${by_name} by name; input devices:${seen}"
        echo "${INPUT_DEV}/${by_name}"
        return 0
    fi
    log "Buttons: no input device found for keys ${BUTTON_LIGHT_UP}/${BUTTON_LIGHT_DOWN} (input devices:${seen:- none}); set BUTTON_DEVICE in config.sh"
    return 1
}

front_light_step() {
    # $1 = up|down. Moves powerd's flIntensity by BUTTON_LIGHT_STEP within LIGHT_MIN..LIGHT_MAX,
    # prints "Light N/MAX" at the bottom and redraws the frame BUTTON_MESSAGE_SECONDS later.
    cur="$(lipc-get-prop com.lab126.powerd flIntensity 2>/dev/null)"
    if ! [ "${cur:-x}" -ge 0 ] 2>/dev/null; then
        log "Buttons: cannot read com.lab126.powerd flIntensity (lipc), key $1 ignored"
        say " light: powerd not reachable "
        schedule_redraw
        return 1
    fi
    if [ "$1" = "up" ]; then
        new=$((cur + BUTTON_LIGHT_STEP))
    else
        new=$((cur - BUTTON_LIGHT_STEP))
    fi
    [ "${new}" -gt "${LIGHT_MAX}" ] && new="${LIGHT_MAX}"
    [ "${new}" -lt "${LIGHT_MIN}" ] && new="${LIGHT_MIN}"
    note=""
    [ "${new}" -eq "${LIGHT_MAX}" ] && note=" (max)"
    [ "${new}" -eq "${LIGHT_MIN}" ] && note=" (min)"
    if [ "${new}" -ne "${cur}" ]; then
        lipc_set com.lab126.powerd flIntensity "${new}" && log "Light ${cur} -> ${new}/${LIGHT_MAX} (key $1)"
    else
        log "Light stays ${cur}/${LIGHT_MAX} (key $1, at the limit)"
    fi
    say " Light ${new}/${LIGHT_MAX}${note} "
    schedule_redraw
}

schedule_redraw() {
    # Redraw the current frame (partial refresh) after the message had its moment; a new
    # press restarts the timer so quick repeats do not flicker.
    kill "${redraw_pid}" 2>/dev/null
    (
        sleep "${BUTTON_MESSAGE_SECONDS}"
        [ -f "${CUR_PNG}" ] && draw_image "${CUR_PNG}" 0
    ) &
    redraw_pid=$!
    echo "${redraw_pid}" >"${RUN_DIR}/buttons.redraw"
}

button_listener() {
    # Runs in the background. $1 = input device. Single presses act on release; while both
    # buttons are down a timer fires after BUTTON_HOLD_SECONDS and stops the daemon ($$ is
    # still the daemon's pid in this subshell), releasing either button first cancels it.
    dev="$1"
    ev="${RUN_DIR}/buttons.event"
    STDERR_FILE="${RUN_DIR}/stderr.buttons"
    DRAWS_OK=1 # the main loop reports the first draw, not our redraws
    dd_pid=""
    timer_pid=""
    redraw_pid=""
    up_pressed=0
    down_pressed=0
    combo=0
    trap 'kill "${dd_pid}" "${timer_pid}" "${redraw_pid}" 2>/dev/null; exit 0' INT TERM
    while :; do
        rm -f "${ev}"
        dd if="${dev}" of="${ev}" bs=16 count=1 2>/dev/null &
        dd_pid=$!
        echo "${dd_pid}" >"${RUN_DIR}/buttons.dd"
        wait "${dd_pid}"
        rc=$?
        if [ ! -s "${ev}" ]; then
            log "Buttons: ${dev} closed or unreadable (dd rc=${rc}), listener stopped"
            break
        fi
        # struct input_event on 32-bit ARM: tv_sec u32, tv_usec u32, type u16, code u16, value s32 (little endian).
        # shellcheck disable=SC2046
        set -- $(od -An -tx1 "${ev}" 2>/dev/null)
        [ $# -ge 14 ] || continue
        type=$((0x$9 | (0x${10} << 8)))
        code=$((0x${11} | (0x${12} << 8)))
        value=$((0x${13} | (0x${14} << 8)))
        [ "${type}" -eq 1 ] || continue
        case "${code}" in
            "${BUTTON_LIGHT_UP}") key="up" ;;
            "${BUTTON_LIGHT_DOWN}") key="down" ;;
            *)
                [ "${value}" -eq 1 ] && log "Buttons: key ${code} pressed (not mapped)"
                continue
                ;;
        esac
        case "${value}" in
            1)
                log "Buttons: key ${code} (${key}) pressed"
                eval "${key}_pressed=1"
                if [ "${up_pressed}" -eq 1 ] && [ "${down_pressed}" -eq 1 ]; then
                    combo=1
                    kill "${timer_pid}" 2>/dev/null
                    (
                        sleep "${BUTTON_HOLD_SECONDS}"
                        log "Buttons: both held ${BUTTON_HOLD_SECONDS}s: stopping the dashboard, back to Home"
                        : >"${RUN_DIR}/buttons.exit"
                        kill -TERM $$
                    ) &
                    timer_pid=$!
                    echo "${timer_pid}" >"${RUN_DIR}/buttons.timer"
                fi
                ;;
            0)
                log "Buttons: key ${code} (${key}) released"
                eval "${key}_pressed=0"
                if [ -n "${timer_pid}" ]; then
                    kill "${timer_pid}" 2>/dev/null && log "Buttons: released before ${BUTTON_HOLD_SECONDS}s, exit cancelled"
                    timer_pid=""
                fi
                if [ "${combo}" -eq 1 ]; then
                    [ "${up_pressed}" -eq 0 ] && [ "${down_pressed}" -eq 0 ] && combo=0
                else
                    front_light_step "${key}"
                fi
                ;;
        esac
    done
}

BUTTONS_PID=""
buttons_start() {
    if [ "${BUTTONS}" != "1" ]; then
        log "Buttons: disabled (BUTTONS=${BUTTONS})"
        return 0
    fi
    dev="$(find_button_device)" || return 0
    if [ ! -r "${dev}" ]; then
        log "Buttons: ${dev} does not exist or is not readable, listener not started"
        return 0
    fi
    button_listener "${dev}" &
    BUTTONS_PID=$!
    log "Buttons: listening on ${dev} (pid ${BUTTONS_PID}): key ${BUTTON_LIGHT_UP} = light +${BUTTON_LIGHT_STEP}, key ${BUTTON_LIGHT_DOWN} = light -${BUTTON_LIGHT_STEP} (${LIGHT_MIN}-${LIGHT_MAX}), both held ${BUTTON_HOLD_SECONDS}s = stop; mode ${UI_MODE}"
}

kill_recorded() {
    # $1 = buttons.* file with a pid written by the listener. Only kills our own kind of
    # process (dd reader, sleep timer, a subshell of this script) in case the pid was reused.
    p="$(cat "${RUN_DIR}/$1" 2>/dev/null)"
    rm -f "${RUN_DIR}/$1"
    [ -n "${p}" ] || return 0
    # The group redirect also silences the shell when /proc/<pid> is already gone.
    cmd="$({ tr '\0' ' ' <"/proc/${p}/cmdline"; } 2>/dev/null)"
    case "${cmd}" in
        "" | dd\ * | sleep\ * | *kindledash*) kill "${p}" 2>/dev/null ;;
    esac
}

buttons_stop() {
    [ -n "${BUTTONS_PID}" ] || return 0
    kill "${BUTTONS_PID}" 2>/dev/null
    kill_recorded buttons.dd
    kill_recorded buttons.timer
    kill_recorded buttons.redraw
    wait "${BUTTONS_PID}" 2>/dev/null
    BUTTONS_PID=""
    log "Buttons: listener stopped"
}

go_home() {
    # Open the Home booklet (what KOReader does on exit). After a stop_framework run the
    # GUI is still coming up, so retry for a while.
    tries=0
    while [ "${tries}" -lt 15 ]; do
        if lipc-set-prop com.lab126.appmgrd start app://com.lab126.booklet.home >/dev/null 2>&1; then
            log "Returned to the Home screen (try $((tries + 1)))"
            return 0
        fi
        tries=$((tries + 1))
        sleep 2
    done
    log "Could not open the Home screen: lipc-set-prop com.lab126.appmgrd start app://com.lab126.booklet.home kept failing"
    return 1
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
cleanup() {
    log "Stopping (signal/exit)"
    buttons_stop
    ui_leave
    if [ -f "${RUN_DIR}/buttons.exit" ]; then
        rm -f "${RUN_DIR}/buttons.exit"
        go_home
    fi
    rm -f "${PIDFILE}"
    exit 0
}

log_environment() {
    log "Tools: http=${HTTP_CLIENT:-none} fbink=${FBINK_SRC:-none} eips=${EIPS:-none} lipc=$(command -v lipc-get-prop || echo none) fw=$(firmware_version)"
    battery_level log >/dev/null
    log "Orientation: fb rota=$(fb_rota || echo '?') winmgr orientation=$(winmgr_get orientation) accelerometer=$(winmgr_get accelerometer) orientationLock=$(winmgr_get orientationLock) (ORIENTATION_LOCK='${ORIENTATION_LOCK}', ROTATION_POLL=${ROTATION_POLL}s)"
}

wait_interval() {
    # Sleeps INTERVAL seconds in ROTATION_POLL steps. Returns 1 early when the framebuffer
    # rotation moved away from $1 (the Oasis was turned over) or the STOP file appeared, so the
    # loop fetches a frame for the new rotation at once instead of showing it upside down for a minute.
    slept=0
    while [ "${slept}" -lt "${INTERVAL}" ]; do
        step=$((INTERVAL - slept))
        if [ "${ROTATION_POLL}" -gt 0 ] && [ "${step}" -gt "${ROTATION_POLL}" ]; then
            step="${ROTATION_POLL}"
        fi
        sleep "${step}" &
        wait $!
        slept=$((slept + step))
        [ -f "${STOP_FILE}" ] && return 1
        if [ "${ROTATION_POLL}" -gt 0 ] && [ -n "$1" ]; then
            now_rota="$(fb_rota)"
            if [ -n "${now_rota}" ] && [ "${now_rota}" != "$1" ]; then
                log "Framebuffer rotation changed: rota $1 -> ${now_rota}, fetching a counter-rotated frame now"
                return 1
            fi
        fi
    done
    return 0
}

if [ "${ONCE}" = "1" ]; then
    # One-shot test: fetch and draw a single frame, no UI changes, no loop.
    rotate_log
    log "Fetch once: ${IMAGE_URL}"
    log_environment
    if [ -z "${HTTP_CLIENT}" ]; then
        say "kindledash: no curl/wget found"
        exit 1
    fi
    rota="$(fb_rota)"
    log "Fetch once: fb rota=${rota:-unknown}, requesting fb_rotate=${rota:-none}"
    if http_get "$(image_url "${rota}")" "${RUN_DIR}/once.png" && is_png "${RUN_DIR}/once.png"; then
        check_geometry "${RUN_DIR}/once.png"
        if draw_image "${RUN_DIR}/once.png" 1; then
            log "Fetch once OK (fb rota=${rota:-unknown})"
        else
            log "Fetch once: fetched but could not draw, see the lines above"
            say "kindledash: fetched, draw failed (see log)"
            exit 1
        fi
    else
        log "Fetch once failed (http rc=$?)"
        say "kindledash: fetch failed, see log"
        exit 1
    fi
    exit 0
fi

if [ -f "${PIDFILE}" ] && kill -0 "$(cat "${PIDFILE}")" 2>/dev/null; then
    log "Already running with pid $(cat "${PIDFILE}")"
    say "kindledash already running"
    exit 0
fi
echo $$ >"${PIDFILE}"
rm -f "${STOP_FILE}"
trap cleanup INT TERM
trap "" HUP

rotate_log
log "Starting: url=${IMAGE_URL} interval=${INTERVAL}s mode=${UI_MODE}"
log_environment
if [ -z "${HTTP_CLIENT}" ]; then
    say "kindledash: no curl/wget found"
    cleanup
fi
if [ -z "${TOKEN}" ] || [ "${TOKEN}" = "CHANGE-ME" ]; then
    log "TOKEN is not set in config.sh"
    say "kindledash: set TOKEN in config.sh"
fi

CUR_PNG="${RUN_DIR}/current.png"
TMP_PNG="${RUN_DIR}/next.png"
rm -f "${RUN_DIR}/buttons.exit"
ui_enter
buttons_start
say "kindledash starting..."

# Start at the threshold so the very first frame is a full, flashing refresh
# that clears whatever the Kindle UI left on the screen.
frame="${FULL_REFRESH_EVERY}"
failures=0
checked=0
started_at="$(date +%s)"
last_report=0
drawn=0
rota=""

while :; do
    now="$(date +%s)"
    if [ -f "${STOP_FILE}" ]; then
        log "Stop file found"
        break
    fi
    if [ "${MAX_RUNTIME}" -gt 0 ] && [ $((now - started_at)) -ge "${MAX_RUNTIME}" ]; then
        log "Max runtime reached"
        break
    fi

    wait_for_wifi
    prev_rota="${rota}"
    rota="$(fb_rota)"
    if [ "${rota}" != "${prev_rota}" ]; then
        log "Framebuffer rota=${rota:-unknown} (was ${prev_rota:-unknown}): requesting fb_rotate=${rota:-none}, full refresh"
        frame="${FULL_REFRESH_EVERY}"
    fi
    if http_get "$(image_url "${rota}")" "${TMP_PNG}" && is_png "${TMP_PNG}"; then
        mv -f "${TMP_PNG}" "${CUR_PNG}"
        full=0
        if [ "${failures}" -gt 0 ] || [ "${frame}" -ge "${FULL_REFRESH_EVERY}" ]; then
            full=1
            frame=0
        fi
        failures=0
        if [ "${checked}" = "0" ]; then
            check_geometry "${CUR_PNG}"
            checked=1
        fi
        if draw_image "${CUR_PNG}" "${full}"; then
            drawn=$((drawn + 1))
            log "Drew frame ${drawn} (fb rota=${rota:-unknown}, fb_rotate=${rota:-none}, full=${full})"
        else
            say " kindledash: draw failed, see log "
        fi
        frame=$((frame + 1))
    else
        failures=$((failures + 1))
        log "Fetch failed (${failures})"
        if [ -f "${CUR_PNG}" ] && [ "${failures}" -eq 1 ]; then
            draw_image "${CUR_PNG}" 1
        fi
        say " offline since $(date '+%H:%M') (${failures}) "
    fi

    bat="$(battery_level)"
    if [ -n "${bat}" ] && [ "${bat}" -le "${LOW_BATTERY_PERCENT}" ] 2>/dev/null; then
        say " battery ${bat}% "
    fi
    if [ "${BATTERY_REPORT_EVERY}" -gt 0 ] && [ -n "${STATUS_URL}" ] && [ $((now - last_report)) -ge "${BATTERY_REPORT_EVERY}" ]; then
        json="{\"battery\":${bat:-0},\"charging\":$(is_charging),\"uptime\":$((now - started_at)),\"firmware\":\"$(firmware_version)\",\"failures\":${failures},\"mode\":\"${UI_MODE}\",\"fb_rotate\":${rota:-null}}"
        if http_post_json "${STATUS_URL}?token=${TOKEN}" "${json}"; then
            last_report="${now}"
        else
            log "Status report failed"
            # retry in a minute instead of waiting the full interval
            last_report=$((now - BATTERY_REPORT_EVERY + 60))
        fi
    fi

    rotate_log
    wait_interval "${rota}" || true
done
cleanup

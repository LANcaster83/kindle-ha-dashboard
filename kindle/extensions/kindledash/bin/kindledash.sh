#!/bin/sh
# Kindle Dashboard daemon: fetch PNG, draw with fbink, report battery, repeat.
# Runs on jailbroken Kindle firmware 5.x (busybox sh). Started by bin/start.sh
# or directly: kindledash.sh [keep|freeze|stop_framework] [--once]

EXT_DIR="${KINDLEDASH_DIR:-/mnt/us/extensions/kindledash}"
RUN_DIR="/var/tmp/kindledash"
PIDFILE="${RUN_DIR}/pid"
LOG_FILE="${EXT_DIR}/log/kindledash.log"
STOP_FILE="${EXT_DIR}/STOP"

# /mnt/us is vfat over fuse: run a copy of this script from tmpfs so that
# USB drive mode or an update of the extension cannot pull the rug from under us.
if [ "$(dirname "$0")" != "/var/tmp" ]; then
    mkdir -p "${RUN_DIR}"
    cp -f "$0" /var/tmp/kindledash.sh
    chmod 755 /var/tmp/kindledash.sh
    exec /var/tmp/kindledash.sh "$@"
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

if [ -f "${EXT_DIR}/config.sh" ]; then
    # shellcheck disable=SC1091
    . "${EXT_DIR}/config.sh"
fi

ONCE=0
for arg in "$@"; do
    case "${arg}" in
        keep | freeze | stop_framework) UI_MODE="${arg}" ;;
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

find_fbink() {
    if [ -n "${FBINK_BIN}" ] && [ -x "${FBINK_BIN}" ]; then
        echo "${FBINK_BIN}"
        return
    fi
    for candidate in "${EXT_DIR}/bin/fbink" /mnt/us/koreader/fbink /mnt/us/libkh/bin/fbink /usr/bin/fbink; do
        if [ -x "${candidate}" ]; then
            echo "${candidate}"
            return
        fi
    done
    echo ""
}

# Copy fbink to tmpfs too (same vfat reasoning as above).
FBINK_SRC="$(find_fbink)"
FBINK=""
if [ -n "${FBINK_SRC}" ]; then
    cp -f "${FBINK_SRC}" "${RUN_DIR}/fbink" && chmod 755 "${RUN_DIR}/fbink" && FBINK="${RUN_DIR}/fbink"
fi

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
    else
        eips 0 39 "$1" >/dev/null 2>&1
    fi
}

draw_image() {
    # $1 = png path, $2 = 1 for full refresh
    if [ -n "${FBINK}" ]; then
        if [ "$2" = "1" ]; then
            "${FBINK}" -q -c -f -g "file=$1,${FBINK_IMG_OPTS}" >/dev/null 2>&1
        else
            "${FBINK}" -q -g "file=$1,${FBINK_IMG_OPTS}" >/dev/null 2>&1
        fi
    else
        if [ "$2" = "1" ]; then
            eips -c >/dev/null 2>&1
            eips -f -g "$1" >/dev/null 2>&1
        else
            eips -g "$1" >/dev/null 2>&1
        fi
    fi
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

fb_geometry() {
    # Prints "WxH rota=N" of the framebuffer as fbink sees it (fbink draws 1:1, no rotation on Kindle).
    [ -n "${FBINK}" ] || return 1
    state="$("${FBINK}" -e 2>/dev/null | tr ';' '\n')"
    w="$(echo "${state}" | sed -n 's/^viewWidth=//p')"
    h="$(echo "${state}" | sed -n 's/^viewHeight=//p')"
    r="$(echo "${state}" | sed -n 's/^currentRota=//p')"
    [ -n "${w}" ] && [ -n "${h}" ] || return 1
    printf '%sx%s rota=%s' "${w}" "${h}" "${r:-?}"
}

check_geometry() {
    # $1 = png path. Logs frame vs framebuffer size and warns when the image would be cropped.
    img="$(png_size "$1")" || return 0
    fb="$(fb_geometry)" || { log "Frame ${img}, framebuffer unknown (no fbink)"; return 0; }
    log "Frame ${img}, framebuffer ${fb}"
    iw="${img%x*}"; ih="${img#*x}"
    fbw="${fb%%x*}"; fbh="${fb#*x}"; fbh="${fbh%% *}"
    if [ "${iw}" -gt "${fbw}" ] || [ "${ih}" -gt "${fbh}" ]; then
        log "WARNING: frame ${img} is larger than the framebuffer ${fbw}x${fbh}: it will be cropped. Landscape dashboard on a portrait framebuffer? Set rotation: 90 (or 270) in the app, keep width 1680 x height 1264."
        say " image ${img} > screen ${fbw}x${fbh}: set rotation 90 in app "
    fi
}

battery_level() {
    level="$(lipc-get-prop com.lab126.power batteryLevel 2>/dev/null)"
    if [ -z "${level}" ]; then
        level="$(gasgauge-info -c 2>/dev/null | tr -d '% ')"
    fi
    echo "${level:-0}"
}

is_charging() {
    c="$(lipc-get-prop com.lab126.power isCharging 2>/dev/null)"
    [ "${c}" = "1" ] && echo true || echo false
}

firmware_version() {
    sed -n 's/^Kindle \([0-9.]*\).*/\1/p' /etc/prettyversion.txt 2>/dev/null | head -n 1
}

wait_for_wifi() {
    host="${WIFI_TEST_HOST:-$(url_host "${IMAGE_URL}")}"
    [ -n "${host}" ] || return 0
    tries=0
    while ! ping -c 1 -W 2 "${host}" >/dev/null 2>&1; do
        tries=$((tries + 1))
        if [ "${tries}" -eq 1 ]; then
            log "Waiting for network (${host})"
            lipc-set-prop com.lab126.cmd wirelessEnable 1 >/dev/null 2>&1
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

ui_enter() {
    # Keep the device awake and Wi-Fi on while we run.
    lipc-set-prop com.lab126.powerd preventScreenSaver 1 >/dev/null 2>&1
    lipc-set-prop com.lab126.cmd wirelessEnable 1 >/dev/null 2>&1
    case "${UI_MODE}" in
        freeze)
            # Same recipe as KOReader on FW >= 5.7.2: kill the status bar and freeze the WM.
            lipc-set-prop com.lab126.pillow disableEnablePillow disable >/dev/null 2>&1
            killall -STOP awesome >/dev/null 2>&1
            UI_APPLIED="freeze"
            ;;
        stop_framework)
            if [ -d /etc/upstart ]; then
                trap "" TERM
                stop lab126_gui >/dev/null 2>&1
                sleep 2
                trap - TERM
            else
                /etc/init.d/framework stop >/dev/null 2>&1
            fi
            UI_APPLIED="stop_framework"
            ;;
    esac
}

ui_leave() {
    lipc-set-prop com.lab126.powerd preventScreenSaver 0 >/dev/null 2>&1
    case "${UI_APPLIED}" in
        freeze)
            killall -CONT awesome >/dev/null 2>&1
            lipc-set-prop com.lab126.pillow disableEnablePillow enable >/dev/null 2>&1
            lipc-set-prop com.lab126.appmgrd start app://com.lab126.booklet.home >/dev/null 2>&1
            ;;
        stop_framework)
            if [ -d /etc/upstart ]; then
                start lab126_gui >/dev/null 2>&1
            else
                /etc/init.d/framework start >/dev/null 2>&1
            fi
            ;;
    esac
    UI_APPLIED=""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
cleanup() {
    log "Stopping (signal/exit)"
    ui_leave
    rm -f "${PIDFILE}"
    exit 0
}

if [ "${ONCE}" = "1" ]; then
    # One-shot test: fetch and draw a single frame, no UI changes, no loop.
    rotate_log
    log "Fetch once: ${IMAGE_URL} via ${HTTP_CLIENT:-none}, fbink=${FBINK_SRC:-eips}"
    if [ -z "${HTTP_CLIENT}" ]; then
        say "kindledash: no curl/wget found"
        exit 1
    fi
    if http_get "${IMAGE_URL}?token=${TOKEN}" "${RUN_DIR}/once.png" && is_png "${RUN_DIR}/once.png"; then
        draw_image "${RUN_DIR}/once.png" 1
        check_geometry "${RUN_DIR}/once.png"
        log "Fetch once OK"
    else
        log "Fetch once failed"
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
log "Starting: url=${IMAGE_URL} interval=${INTERVAL}s mode=${UI_MODE} http=${HTTP_CLIENT:-none} fbink=${FBINK_SRC:-eips}"
if [ -z "${HTTP_CLIENT}" ]; then
    say "kindledash: no curl/wget found"
    cleanup
fi
if [ -z "${TOKEN}" ] || [ "${TOKEN}" = "CHANGE-ME" ]; then
    log "TOKEN is not set in config.sh"
    say "kindledash: set TOKEN in config.sh"
fi

ui_enter
say "kindledash starting..."

CUR_PNG="${RUN_DIR}/current.png"
TMP_PNG="${RUN_DIR}/next.png"
frame=0
failures=0
checked=0
started_at="$(date +%s)"
last_report=0

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
    if http_get "${IMAGE_URL}?token=${TOKEN}" "${TMP_PNG}" && is_png "${TMP_PNG}"; then
        mv -f "${TMP_PNG}" "${CUR_PNG}"
        full=0
        if [ "${failures}" -gt 0 ] || [ "${frame}" -ge "${FULL_REFRESH_EVERY}" ]; then
            full=1
            frame=0
        fi
        failures=0
        draw_image "${CUR_PNG}" "${full}"
        if [ "${checked}" = "0" ]; then
            check_geometry "${CUR_PNG}"
            checked=1
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
    if [ "${bat}" -le "${LOW_BATTERY_PERCENT}" ] 2>/dev/null; then
        say " battery ${bat}% "
    fi
    if [ "${BATTERY_REPORT_EVERY}" -gt 0 ] && [ -n "${STATUS_URL}" ] && [ $((now - last_report)) -ge "${BATTERY_REPORT_EVERY}" ]; then
        json="{\"battery\":${bat:-0},\"charging\":$(is_charging),\"uptime\":$((now - started_at)),\"firmware\":\"$(firmware_version)\",\"failures\":${failures},\"mode\":\"${UI_MODE}\"}"
        if http_post_json "${STATUS_URL}?token=${TOKEN}" "${json}"; then
            last_report="${now}"
        else
            log "Status report failed"
            # retry in a minute instead of waiting the full interval
            last_report=$((now - BATTERY_REPORT_EVERY + 60))
        fi
    fi

    rotate_log
    sleep "${INTERVAL}" &
    wait $!
done
cleanup

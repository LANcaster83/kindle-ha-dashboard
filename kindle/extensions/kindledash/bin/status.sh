#!/bin/sh
# Print daemon state and the log tail on screen (from the KUAL menu).
EXT_DIR="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)"
[ -d "${EXT_DIR}" ] || EXT_DIR="/mnt/us/extensions/kindledash"
PIDFILE="/var/tmp/kindledash/pid"
FBINK="/var/tmp/kindledash/fbink"
[ -x "${FBINK}" ] || FBINK="/mnt/us/koreader/fbink"

if [ -f "${PIDFILE}" ] && kill -0 "$(cat "${PIDFILE}")" 2>/dev/null; then
    state="running (pid $(cat "${PIDFILE}"))"
else
    state="stopped"
fi
bat="$(lipc-get-prop com.lab126.power batteryLevel 2>/dev/null)"

if [ -x "${FBINK}" ]; then
    "${FBINK}" -q -y -12 -m "kindledash: ${state}, battery ${bat:-?}%" >/dev/null 2>&1
    row=-11
    tail -n 9 "${EXT_DIR}/log/kindledash.log" 2>/dev/null | while IFS= read -r line; do
        "${FBINK}" -q -y "${row}" -S 1 "${line}" >/dev/null 2>&1
        row=$((row + 1))
    done
else
    eips 0 38 "kindledash: ${state}, battery ${bat:-?}%" >/dev/null 2>&1
    eips 0 39 "$(tail -n 1 "${EXT_DIR}/log/kindledash.log" 2>/dev/null)" >/dev/null 2>&1
fi
exit 0

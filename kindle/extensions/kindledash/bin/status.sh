#!/bin/sh
# Print daemon state and the log tail on screen (from the KUAL menu).
PATH="${PATH}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH
EXT_DIR="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)"
[ -d "${EXT_DIR}" ] || EXT_DIR="/mnt/us/extensions/kindledash"
RUN_DIR="${KINDLEDASH_RUN_DIR:-/var/tmp/kindledash}"
PIDFILE="${RUN_DIR}/pid"
# The daemon's tmpfs copy is the fbink it really uses; otherwise the hotfix's full build,
# then KOReader's (text only, fine for status lines).
FBINK=""
for candidate in "${RUN_DIR}/fbink" /mnt/us/libkh/bin/fbink /mnt/us/koreader/fbink; do
    if [ -x "${candidate}" ]; then
        FBINK="${candidate}"
        break
    fi
done

if [ -f "${PIDFILE}" ] && kill -0 "$(cat "${PIDFILE}")" 2>/dev/null; then
    state="running (pid $(cat "${PIDFILE}"))"
else
    state="stopped"
fi
bat="$(lipc-get-prop com.lab126.powerd battLevel 2>/dev/null)"
[ -n "${bat}" ] || bat="$(gasgauge-info -c 2>/dev/null | tr -d '% ')"

if [ -n "${FBINK}" ]; then
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

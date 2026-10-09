#!/bin/sh
# Launch the dashboard daemon in the background. $1 = keep | freeze | stop_framework
EXT_DIR="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)"
[ -d "${EXT_DIR}" ] || EXT_DIR="/mnt/us/extensions/kindledash"
export KINDLEDASH_DIR="${EXT_DIR}"
mkdir -p "${EXT_DIR}/log"
# Give KUAL a moment to close its menu before we start drawing.
sleep 1
"${EXT_DIR}/bin/kindledash.sh" "$@" >>"${EXT_DIR}/log/start.log" 2>&1 &
exit 0

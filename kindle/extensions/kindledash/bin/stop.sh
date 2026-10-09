#!/bin/sh
# Stop the dashboard daemon; it restores the UI itself on SIGTERM.
PATH="${PATH}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH
RUN_DIR="${KINDLEDASH_RUN_DIR:-/var/tmp/kindledash}"
PIDFILE="${RUN_DIR}/pid"
if [ -f "${PIDFILE}" ] && kill -0 "$(cat "${PIDFILE}")" 2>/dev/null; then
    kill -TERM "$(cat "${PIDFILE}")"
    sleep 2
fi
# Fallback for a stale pidfile or a daemon stuck in sleep.
pkill -f "${RUN_DIR}/kindledash.sh" 2>/dev/null || killall kindledash.sh 2>/dev/null
rm -f "${PIDFILE}"
# Make sure the screensaver lock is released even if the daemon died hard.
lipc-set-prop com.lab126.powerd preventScreenSaver 0 >/dev/null 2>&1
# Bring the Kindle GUI back if a stop_framework run left it down (SSH use).
if [ -d /etc/upstart ] && status lab126_gui 2>/dev/null | grep -q 'stop/waiting'; then
    start lab126_gui >/dev/null 2>&1
fi
exit 0

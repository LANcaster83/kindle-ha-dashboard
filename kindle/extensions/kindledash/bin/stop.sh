#!/bin/sh
# Stop the dashboard daemon; it restores the UI itself on SIGTERM.
PIDFILE="/var/tmp/kindledash/pid"
if [ -f "${PIDFILE}" ] && kill -0 "$(cat "${PIDFILE}")" 2>/dev/null; then
    kill -TERM "$(cat "${PIDFILE}")"
    sleep 2
fi
# Fallback for a stale pidfile or a daemon stuck in sleep.
pkill -f /var/tmp/kindledash.sh 2>/dev/null || killall kindledash.sh 2>/dev/null
rm -f "${PIDFILE}"
# Make sure the screensaver lock is released even if the daemon died hard.
lipc-set-prop com.lab126.powerd preventScreenSaver 0 >/dev/null 2>&1
exit 0

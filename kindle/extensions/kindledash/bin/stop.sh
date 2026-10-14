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
# Fallback for a stale pidfile or a daemon stuck in sleep (also kills the button listener,
# a subshell of the same script).
pkill -f "${RUN_DIR}/kindledash.sh" 2>/dev/null || killall kindledash.sh 2>/dev/null
# The listener's blocking dd on /dev/input and its timers are separate processes.
for f in buttons.dd buttons.timer buttons.redraw; do
    p="$(cat "${RUN_DIR}/${f}" 2>/dev/null)"
    [ -n "${p}" ] && kill "${p}" 2>/dev/null
    rm -f "${RUN_DIR}/${f}"
done
pkill -f '^dd if=/dev/input/' 2>/dev/null
rm -f "${PIDFILE}" "${RUN_DIR}/buttons.exit"
# Make sure the screensaver lock is released even if the daemon died hard.
lipc-set-prop com.lab126.powerd preventScreenSaver 0 >/dev/null 2>&1
# Bring the Kindle GUI back if a stop_framework run left it down (SSH use).
if [ -d /etc/upstart ] && status lab126_gui 2>/dev/null | grep -q 'stop/waiting'; then
    start lab126_gui >/dev/null 2>&1
fi
exit 0

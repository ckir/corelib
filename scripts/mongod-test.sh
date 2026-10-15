#!/usr/bin/env bash
# =============================================
# FILE: scripts/mongod-test.sh
# PURPOSE: Start/stop a throwaway local mongod for the ts-markets real-MongoDB tests.
# Usage: bash scripts/mongod-test.sh start|stop|env
# Safety: only ever signals the PID recorded in its own pidfile; never touches
# the system mongod service or any other mongod. Binds 127.0.0.1 only.
# =============================================
set -euo pipefail

PORT="${MONGOD_TEST_PORT:-27099}"
BASE="${TMPDIR:-/tmp}/corelib-mongod"
DBPATH="$BASE/db"
LOGFILE="$BASE/mongod.log"
PIDFILE="$BASE/mongod.pid"
URI="mongodb://127.0.0.1:${PORT}"

print_env() { echo "export CORELIB_TEST_MONGODB_URI=${URI}"; }

pid_alive() {
	local pid
	[ -f "$PIDFILE" ] || return 1
	pid="$(cat "$PIDFILE" 2>/dev/null || true)"
	[[ "$pid" =~ ^[0-9]+$ ]] || return 1
	kill -0 "$pid" 2>/dev/null
}

ping_ok() {
	[ "$(mongosh --quiet --port "$PORT" --eval 'db.runCommand({ping:1}).ok' 2>/dev/null || true)" = "1" ]
}

cmd_start() {
	if pid_alive; then
		echo "test mongod already running (pid $(cat "$PIDFILE")) on port $PORT" >&2
		print_env
		return 0
	fi
	if ping_ok; then
		echo "port $PORT already answers and is not ours; refusing to start" >&2
		return 1
	fi
	rm -rf "$BASE"
	mkdir -p "$DBPATH"
	mongod --dbpath "$DBPATH" --port "$PORT" --bind_ip 127.0.0.1 --fork \
		--logpath "$LOGFILE" --pidfilepath "$PIDFILE" >/dev/null
	local i
	for ((i = 0; i < 30; i++)); do
		if ping_ok; then
			print_env
			return 0
		fi
		sleep 1
	done
	echo "mongod did not become ready within 30 s; see $LOGFILE" >&2
	cmd_stop || true
	return 1
}

cmd_stop() {
	if pid_alive; then
		local pid i
		pid="$(cat "$PIDFILE")"
		kill -TERM "$pid" 2>/dev/null || true
		for ((i = 0; i < 30; i++)); do
			kill -0 "$pid" 2>/dev/null || break
			sleep 1
		done
		if kill -0 "$pid" 2>/dev/null; then
			echo "pid $pid did not exit within 30 s; leaving $BASE in place" >&2
			return 1
		fi
	fi
	rm -rf "$BASE"
}

case "${1:-}" in
start) cmd_start ;;
stop) cmd_stop ;;
env) print_env ;;
*)
	echo "usage: $0 start|stop|env" >&2
	exit 2
	;;
esac

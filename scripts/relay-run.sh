#!/usr/bin/env bash
#
# relay-run.sh — launcher wrapper for the relay, run by launchd.
#
# Wraps `bun run src/socket.ts` so every start and (especially) every death is
# recorded with a timestamp and exit code:
#   .relay/relay.log  — full output (startup banners, the relay's own stdout/
#                        stderr incl. stack traces, and an "exited code=N" line)
#   .relay/crash.log  — ONLY abnormal exits, one line each, easy to scan later
#                        to see how often / when / why it keeps crashing.
#
# A clean stop or restart (launchctl sends SIGTERM → exit 143/0) is NOT counted
# as a crash. Anything else (uncaught exception → 1, SIGKILL → 137, etc.) is.
#
set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

LOG_DIR="$PROJECT_DIR/.relay"
LOG="$LOG_DIR/relay.log"
CRASH_LOG="$LOG_DIR/crash.log"
FIFO="$LOG_DIR/relay.out.fifo"
# Rotate relay.log past this size WHILE the relay runs, keeping KEEP older
# generations (relay.log.1 newest). Rotation used to happen only at startup, so
# a relay that stayed up ten days wrote a single 116MB file.
MAX_BYTES=${RELAY_LOG_MAX_BYTES:-$((10 * 1024 * 1024))}
KEEP=${RELAY_LOG_KEEP:-3}
BUN="${BUN_BIN:-bun}"

mkdir -p "$LOG_DIR"
ts() { date '+%Y-%m-%d %H:%M:%S'; }
size_of() { stat -f%z "$1" 2>/dev/null || echo 0; }

rotate_logs() {
  rm -f "$LOG.$KEEP"
  local i=$KEEP
  while [ "$i" -gt 1 ]; do
    [ -f "$LOG.$((i - 1))" ] && mv -f "$LOG.$((i - 1))" "$LOG.$i"
    i=$((i - 1))
  done
  [ -f "$LOG" ] && mv -f "$LOG" "$LOG.1"
}

# The relay writes into a FIFO and this pump copies it into relay.log, checking
# the size every few hundred lines. A plain `>> relay.log` cannot rotate: the
# relay would keep writing into the renamed file. bash 3.2 compatible (macOS).
pump() {
  # Only EOF (or the wrapper's bounded kill below) ends the pump. A stop signal
  # reaching the process group would otherwise kill it while the relay is still
  # printing its shutdown, and the relay's next write would hit a closed pipe.
  trap '' TERM INT
  exec 3>>"$LOG"
  local n=0 line
  while IFS= read -r line || [ -n "$line" ]; do
    printf '%s\n' "$line" >&3
    n=$((n + 1))
    if [ $((n % 200)) -eq 0 ] && [ "$(size_of "$LOG")" -gt "$MAX_BYTES" ]; then
      exec 3>&-
      rotate_logs
      exec 3>>"$LOG"
    fi
  done
  exec 3>&-
}

[ "$(size_of "$LOG")" -gt "$MAX_BYTES" ] && rotate_logs

echo "=== [$(ts)] relay starting (wrapper pid $$, bun=$BUN) ===" >> "$LOG"

rm -f "$FIFO"
mkfifo "$FIFO"
pump < "$FIFO" &
pumper=$!
"$BUN" run src/socket.ts > "$FIFO" 2>&1 &
child=$!

# Forward launchd's stop signal to the relay so it shuts down cleanly.
trap 'kill -TERM "$child" 2>/dev/null' TERM INT

# wait may be interrupted by the trap before the child is fully reaped;
# loop until the child is genuinely gone so $code is its real exit status.
code=0
while :; do
  wait "$child"; code=$?
  kill -0 "$child" 2>/dev/null || break
done

# Let the pump drain before writing the exit marker. What the relay printed
# last is a crash's stack trace, and the crash-window diagnosis reads the lines
# just above "relay exited" — they have to land in that order.
#
# Bounded, though. The pump only sees EOF once EVERY holder of the FIFO's
# write end is gone, and the relay's children inherit its stderr: `caffeinate
# -d`, started while a preview is watched, has no timeout. Waiting for EOF after
# a crash mid-preview (the 09-14 crash was one) would block the wrapper forever
# — no exit marker, no crash.log, and launchd never restarting the relay
# (reproduced: a Bun.spawn'd `sleep 20` held the wrapper for exactly 20s).
# The relay's own output is already in the pipe and drains in milliseconds.
i=0
while kill -0 "$pumper" 2>/dev/null && [ "$i" -lt 50 ]; do
  sleep 0.1
  i=$((i + 1))
done
kill -KILL "$pumper" 2>/dev/null
wait "$pumper" 2>/dev/null
rm -f "$FIFO"

line="[$(ts)] relay exited code=$code"
echo "$line" >> "$LOG"

# 0 = normal, 143 = SIGTERM (clean stop/restart). Everything else = a crash.
if [ "$code" -ne 0 ] && [ "$code" -ne 143 ]; then
  case "$code" in
    1)   reason='error/uncaught-exception' ;;
    134) reason='SIGABRT' ;;
    137) reason='SIGKILL (OOM or kill -9)' ;;
    139) reason='SIGSEGV' ;;
    *)   reason='abnormal' ;;
  esac
  echo "$line  reason=$reason  (see relay.log around this time for the stack trace)" >> "$CRASH_LOG"
fi

exit "$code"

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
MAX_BYTES=$((5 * 1024 * 1024))   # rotate relay.log past 5 MB
BUN="${BUN_BIN:-bun}"

mkdir -p "$LOG_DIR"
ts() { date '+%Y-%m-%d %H:%M:%S'; }

# Rotate at startup. The wrapper owns this fd (opened fresh per spawn via >>),
# so there's no shared-fd race with launchd.
if [ -f "$LOG" ]; then
  sz=$(stat -f%z "$LOG" 2>/dev/null || echo 0)
  [ "$sz" -gt "$MAX_BYTES" ] && mv -f "$LOG" "$LOG.1"
fi

echo "=== [$(ts)] relay starting (wrapper pid $$, bun=$BUN) ===" >> "$LOG"

"$BUN" run src/socket.ts >> "$LOG" 2>&1 &
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

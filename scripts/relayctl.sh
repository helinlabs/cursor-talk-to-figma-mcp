#!/usr/bin/env bash
#
# relayctl — manage the Talk-to-Figma relay server as a macOS launchd agent.
#
# The relay runs `bun run src/socket.ts` (straight from source, no build step),
# so after editing the source you just `relayctl restart` to pick up changes.
#
# Usage:
#   ./scripts/relayctl.sh install    # install + start, and enable start-at-login
#   ./scripts/relayctl.sh uninstall  # stop + remove the launchd agent
#   ./scripts/relayctl.sh start      # start now
#   ./scripts/relayctl.sh stop       # stop now (stays installed; won't auto-restart)
#   ./scripts/relayctl.sh restart    # restart (use after editing source)
#   ./scripts/relayctl.sh update     # git pull (if clean) + restart
#   ./scripts/relayctl.sh status     # show whether it's running + recent log tail
#   ./scripts/relayctl.sh logs       # follow the log (Ctrl-C to stop)
#   ./scripts/relayctl.sh crashes    # show the crash history (abnormal exits)
#
set -euo pipefail

# nexus 터널 supervision(MANAGED) 전환(2026-08-27) 후의 라벨 — 구 라벨은 제거됨.
LABEL="${RELAY_LABEL:-com.helinlabs.tunnel.figma-relay}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST_SRC="$PROJECT_DIR/scripts/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$PROJECT_DIR/.relay"
LOG_FILE="$LOG_DIR/relay.log"
CRASH_FILE="$LOG_DIR/crash.log"
GUI_DOMAIN="gui/$(id -u)"
SERVICE_TARGET="$GUI_DOMAIN/$LABEL"

bun_bin() {
  command -v bun || echo "$HOME/.bun/bin/bun"
}

is_loaded() {
  launchctl print "$SERVICE_TARGET" >/dev/null 2>&1
}

render_plist() {
  local bun_path bun_dir
  bun_path="$(bun_bin)"
  bun_dir="$(dirname "$bun_path")"
  mkdir -p "$LOG_DIR"
  sed \
    -e "s#__BUN__#$bun_path#g" \
    -e "s#__BUN_DIR__#$bun_dir#g" \
    -e "s#__PROJECT_DIR__#$PROJECT_DIR#g" \
    "$PLIST_SRC" > "$PLIST_DST"
}

wait_unloaded() {
  # bootout is async; bootstrap fails with EIO if the old job is still around.
  local i
  for i in $(seq 1 20); do
    is_loaded || return 0
    sleep 0.2
  done
}

cmd_install() {
  render_plist
  # Reload if already loaded so a re-install picks up plist changes.
  launchctl bootout "$SERVICE_TARGET" >/dev/null 2>&1 || true
  wait_unloaded
  launchctl bootstrap "$GUI_DOMAIN" "$PLIST_DST"
  launchctl enable "$SERVICE_TARGET"
  launchctl kickstart -k "$SERVICE_TARGET"
  echo "✅ installed & started ($LABEL) — http://localhost:${PORT:-3055}/console"
  echo "   will auto-start at login and auto-restart on crash."
}

cmd_uninstall() {
  launchctl bootout "$SERVICE_TARGET" >/dev/null 2>&1 || true
  rm -f "$PLIST_DST"
  echo "🗑  uninstalled ($LABEL). Source code is untouched."
}

cmd_start() {
  is_loaded || { render_plist; launchctl bootstrap "$GUI_DOMAIN" "$PLIST_DST"; }
  launchctl enable "$SERVICE_TARGET"
  launchctl kickstart "$SERVICE_TARGET"
  echo "▶️  started"
}

cmd_stop() {
  # bootout fully unloads so KeepAlive won't resurrect it until next start/login.
  launchctl bootout "$SERVICE_TARGET" >/dev/null 2>&1 || true
  echo "⏹  stopped (won't auto-restart until you start it or log in again)"
}

cmd_restart() {
  if is_loaded; then
    launchctl kickstart -k "$SERVICE_TARGET"
  else
    cmd_start
  fi
  echo "🔁 restarted (latest source loaded)"
}

cmd_update() {
  if [ -n "$(git -C "$PROJECT_DIR" status --porcelain)" ]; then
    echo "⚠️  working tree has local changes — skipping git pull, just restarting."
  else
    echo "⬇️  git pull…"
    git -C "$PROJECT_DIR" pull --ff-only
  fi
  cmd_restart
}

cmd_status() {
  if is_loaded; then
    local pid
    pid="$(launchctl print "$SERVICE_TARGET" 2>/dev/null | awk '/pid =/{print $3; exit}')"
    if [ -n "${pid:-}" ]; then
      echo "🟢 running (pid $pid) — http://localhost:3055/console"
    else
      echo "🟡 loaded but not running (check log below)"
    fi
  else
    echo "🔴 not installed/loaded"
  fi
  if [ -f "$CRASH_FILE" ]; then
    local n
    n="$(grep -c 'relay exited' "$CRASH_FILE" 2>/dev/null || echo 0)"
    if [ "$n" -gt 0 ]; then
      echo "💥 $n crash(es) recorded — \`relayctl crashes\` for details. Last:"
      tail -n 1 "$CRASH_FILE"
    fi
  fi
  if [ -f "$LOG_FILE" ]; then
    echo "--- last 15 log lines ---"
    tail -n 15 "$LOG_FILE"
  fi
}

cmd_crashes() {
  if [ -f "$CRASH_FILE" ] && [ -s "$CRASH_FILE" ]; then
    local n; n="$(grep -c 'relay exited' "$CRASH_FILE" 2>/dev/null || echo 0)"
    echo "💥 $n abnormal exit(s) recorded in $CRASH_FILE:"
    echo
    cat "$CRASH_FILE"
    echo
    echo "→ For the stack trace of any crash, open $LOG_FILE near that timestamp."
  else
    echo "✨ no crashes recorded — $CRASH_FILE is empty."
  fi
}

cmd_logs() {
  mkdir -p "$LOG_DIR"; touch "$LOG_FILE"
  echo "tailing $LOG_FILE (Ctrl-C to stop)…"
  tail -f "$LOG_FILE"
}

case "${1:-}" in
  install)   cmd_install ;;
  uninstall) cmd_uninstall ;;
  start)     cmd_start ;;
  stop)      cmd_stop ;;
  restart)   cmd_restart ;;
  update)    cmd_update ;;
  status)    cmd_status ;;
  logs)      cmd_logs ;;
  crashes)   cmd_crashes ;;
  *)
    echo "usage: $0 {install|uninstall|start|stop|restart|update|status|logs|crashes}" >&2
    exit 1 ;;
esac

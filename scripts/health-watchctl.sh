#!/bin/zsh
# Install / manage the Figma health watch as a launchd agent.
#
# The Slack token is deliberately NOT put in the plist: launchd plists are
# world-readable and get dumped by routine diagnostics. It lives in a 0600 file
# that only this service reads.
#
#   ./scripts/health-watchctl.sh install     # write plist + load + start
#   ./scripts/health-watchctl.sh restart|stop|start|status|logs|uninstall
set -u

label="com.helinlabs.tunnel.figma-health"
project_dir="${0:A:h:h}"
plist="$HOME/Library/LaunchAgents/$label.plist"
log_dir="$project_dir/.health"
token_file="$HOME/.talk-to-figma/slack-bot-token"
bun_bin="$(command -v bun || echo "$HOME/.bun/bin/bun")"
domain="gui/$(id -u)"

case "${1:-status}" in
  install)
    mkdir -p "$log_dir" "$(dirname "$plist")" "$(dirname "$token_file")"
    cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$bun_bin</string>
    <string>run</string>
    <string>$project_dir/src/health_watch/watch.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$project_dir</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$bun_bin"):/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HEALTH_PORT</key><string>3057</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$log_dir/health.log</string>
  <key>StandardErrorPath</key><string>$log_dir/health.log</string>
</dict>
</plist>
PLIST
    launchctl bootout "$domain/$label" 2>/dev/null
    launchctl bootstrap "$domain" "$plist" && launchctl kickstart -k "$domain/$label"
    echo "installed $label"
    [[ -s "$token_file" ]] || echo "⚠️  no Slack token at $token_file — checks will run but nothing will be reported"
    ;;
  restart) launchctl kickstart -k "$domain/$label" && echo restarted ;;
  stop)    launchctl bootout "$domain/$label" 2>/dev/null && echo stopped ;;
  start)   launchctl bootstrap "$domain" "$plist" && echo started ;;
  uninstall)
    launchctl bootout "$domain/$label" 2>/dev/null
    rm -f "$plist" && echo "uninstalled $label (token file left alone)"
    ;;
  logs)    tail -f "$log_dir/health.log" ;;
  status)
    launchctl print "$domain/$label" 2>/dev/null | grep -E "state|pid|last exit" | sed 's/^/  /' || echo "not loaded"
    curl -fsS "http://127.0.0.1:3057/status" 2>/dev/null || echo "  (status endpoint not answering)"
    ;;
  *) echo "usage: $0 {install|restart|stop|start|uninstall|logs|status}"; exit 2 ;;
esac

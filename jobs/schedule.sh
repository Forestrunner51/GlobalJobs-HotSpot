#!/bin/sh
# Turn the automatic job refresh on or off (macOS launchd).
#
#   jobs/schedule.sh install     refresh at 7:00 and 19:00 every day
#   jobs/schedule.sh uninstall   stop refreshing
#   jobs/schedule.sh run         refresh now, in the background (check jobs/logs/update.log)
#   jobs/schedule.sh status      show whether it's installed and the last log lines
#
# launchd rather than cron: cron skips runs while the Mac is asleep, launchd runs them on wake.
set -eu
LABEL=com.jobglobal.fetch-jobs
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO=$(cd "$(dirname "$0")/.." && pwd)
DOMAIN="gui/$(id -u)"
PYTHON_DIR=$(dirname "$(command -v python3)")

case "${1:-status}" in
  install)
    mkdir -p "$HOME/Library/LaunchAgents" "$REPO/jobs/logs"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>$REPO/jobs/update.sh</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$PYTHON_DIR:/usr/bin:/bin</string></dict>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>19</integer><key>Minute</key><integer>0</integer></dict>
  </array>
  <key>StandardErrorPath</key><string>$REPO/jobs/logs/launchd.err</string>
</dict>
</plist>
EOF
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "Installed. Job postings refresh at 7:00 and 19:00 (missed runs happen when the Mac wakes)."
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Uninstalled. Postings will no longer refresh automatically."
    ;;
  run)
    launchctl kickstart "$DOMAIN/$LABEL"
    echo "Refresh started (about 3 minutes). Follow it with: tail -f $REPO/jobs/logs/update.log"
    ;;
  status)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      echo "Installed: refreshes at 7:00 and 19:00."
    else
      echo "Not installed. Run: jobs/schedule.sh install"
    fi
    if [ -f "$REPO/jobs/logs/update.log" ]; then
      echo "Last log lines:"
      tail -n 6 "$REPO/jobs/logs/update.log"
    fi
    ;;
  *)
    echo "usage: $0 install|uninstall|run|status" >&2
    exit 2
    ;;
esac

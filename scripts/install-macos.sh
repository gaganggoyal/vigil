#!/usr/bin/env bash
# Install Vigil as a macOS Login/background service via launchd.
# It will start automatically at login and restart if it ever crashes.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node || true)"
LABEL="com.vigil.recorder"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ -z "$NODE" ]; then echo "Node.js not found on PATH. Install it, then re-run."; exit 1; fi

mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$DIR/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/vigil.log</string>
  <key>StandardErrorPath</key><string>$DIR/vigil.log</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "✓ Vigil installed and running in the background."
echo "  Dashboard:  http://localhost:8080"
echo "  Logs:       $DIR/vigil.log"
echo "  Stop:       launchctl unload $PLIST"
echo
echo "Tip: to keep recording with the lid closed, run:"
echo "  sudo pmset -c disablesleep 1     (revert with: sudo pmset -c disablesleep 0)"

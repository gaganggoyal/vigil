#!/usr/bin/env bash
# Install Vigil as a systemd service so it runs 24/7 and starts on boot.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node || true)"
USER_NAME="$(whoami)"
UNIT="/etc/systemd/system/vigil.service"

if [ -z "$NODE" ]; then echo "Node.js not found on PATH. Install it, then re-run."; exit 1; fi

echo "Installing systemd unit (needs sudo)…"
sudo tee "$UNIT" >/dev/null <<EOF
[Unit]
Description=Vigil 24/7 camera recorder
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$DIR
ExecStart=$NODE $DIR/server.js
Restart=always
RestartSec=5
# Allow writing to external drives etc.
Environment=PATH=/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now vigil
echo "✓ Vigil is running and will start on boot."
echo "  Dashboard:  http://localhost:8080"
echo "  Status:     sudo systemctl status vigil"
echo "  Logs:       journalctl -u vigil -f"
echo "  Stop:       sudo systemctl disable --now vigil"

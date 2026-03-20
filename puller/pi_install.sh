#!/usr/bin/env bash
#
# Install LotLogic puller on a Raspberry Pi
#
# Usage:
#   curl -sSL <raw-github-url>/puller/pi_install.sh | bash
#   — or —
#   scp puller/pi_install.sh puller/pi_puller.py pi@<pi-ip>:~/
#   ssh pi@<pi-ip> 'bash pi_install.sh'
#
set -euo pipefail

INSTALL_DIR="/opt/lotlogic"
SERVICE_NAME="lotlogic-puller"
ENV_FILE="/opt/lotlogic/.env"

echo "=== LotLogic Pi Puller Installer ==="
echo ""

# ── Install Python deps ──────────────────────────────────────────────────
if ! python3 -c "import requests" 2>/dev/null; then
    echo "[+] Installing requests..."
    pip3 install --break-system-packages requests 2>/dev/null || pip3 install requests
fi

# ── Copy files ────────────────────────────────────────────────────────────
sudo mkdir -p "$INSTALL_DIR"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
sudo cp "$SCRIPT_DIR/pi_puller.py" "$INSTALL_DIR/pi_puller.py"
sudo chmod +x "$INSTALL_DIR/pi_puller.py"

# ── Create .env if it doesn't exist ──────────────────────────────────────
if [[ ! -f "$ENV_FILE" ]]; then
    echo "[!] Creating $ENV_FILE — you MUST fill in the values"
    sudo tee "$ENV_FILE" > /dev/null <<'ENVFILE'
# LotLogic Pi Puller Configuration
# Fill in ALL values below, then run: sudo systemctl restart lotlogic-puller

LOTLOGIC_API_URL=https://lotlogic-backend-production.up.railway.app
LOTLOGIC_API_KEY=

# Camera credentials (Reolink)
CAMERA_IP=192.168.1.134
CAMERA_USER=
CAMERA_PASS=

# From Supabase — camera and lot UUIDs
# For multiple cameras on the same IP (different channels), comma-separate the IDs
CAMERA_IDS=945a9c59-0fca-4e89-8f74-e4dfa956f876,1aab9a15-a31a-43f8-b69a-48a7efbfc891
LOT_ID=

# Poll interval in seconds
POLL_INTERVAL=30
ENVFILE
    sudo chmod 600 "$ENV_FILE"
    echo ""
    echo ">>> EDIT THIS FILE: sudo nano $ENV_FILE"
    echo ""
else
    echo "[+] $ENV_FILE already exists, keeping it"
fi

# ── Systemd service ───────────────────────────────────────────────────────
sudo tee /etc/systemd/system/${SERVICE_NAME}.service > /dev/null <<EOF
[Unit]
Description=LotLogic Camera Puller
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/python3 ${INSTALL_DIR}/pi_puller.py
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

# Watchdog: systemd restarts if the process dies
WatchdogSec=120
StartLimitIntervalSec=300
StartLimitBurst=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"

echo ""
echo "=== Installed ==="
echo ""
echo "  Config:   $ENV_FILE"
echo "  Script:   $INSTALL_DIR/pi_puller.py"
echo "  Service:  $SERVICE_NAME"
echo ""
echo "  Next steps:"
echo "    1. Edit config:    sudo nano $ENV_FILE"
echo "    2. Start service:  sudo systemctl start $SERVICE_NAME"
echo "    3. Check logs:     journalctl -u $SERVICE_NAME -f"
echo "    4. Check status:   sudo systemctl status $SERVICE_NAME"
echo ""

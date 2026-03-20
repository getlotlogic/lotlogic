#!/usr/bin/env bash
#
# LotLogic Cloudflare Tunnel Setup
#
# Sets up a PERSISTENT named Cloudflare Tunnel that:
#   - Survives reboots (systemd service)
#   - Auto-reconnects on network drops
#   - Has a stable hostname (no more random trycloudflare.com URLs)
#
# Prerequisites:
#   - cloudflared installed: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
#   - A Cloudflare account (free tier works)
#   - The camera accessible on the local network (default: 192.168.1.134)
#
# Usage:
#   chmod +x setup.sh
#   sudo ./setup.sh              # interactive — prompts for login
#   sudo ./setup.sh --token XXX  # non-interactive — use a pre-created tunnel token
#
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────
TUNNEL_NAME="${TUNNEL_NAME:-lotlogic-cameras}"
CAMERA_LOCAL_IP="${CAMERA_LOCAL_IP:-192.168.1.134}"
CAMERA_LOCAL_PORT="${CAMERA_LOCAL_PORT:-80}"
SERVICE_NAME="cloudflared-${TUNNEL_NAME}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[+]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
error() { echo -e "${RED}[✗]${NC} $*" >&2; }

# ── Preflight checks ─────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
    error "Run as root: sudo ./setup.sh"
    exit 1
fi

if ! command -v cloudflared &>/dev/null; then
    info "Installing cloudflared..."
    if command -v apt-get &>/dev/null; then
        curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
            | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
        echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" \
            | tee /etc/apt/sources.list.d/cloudflared.list
        apt-get update && apt-get install -y cloudflared
    elif command -v yum &>/dev/null; then
        yum install -y cloudflared
    elif command -v brew &>/dev/null; then
        brew install cloudflared
    else
        error "Cannot auto-install cloudflared. Install manually:"
        error "  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
        exit 1
    fi
fi

info "cloudflared version: $(cloudflared --version)"

# ── Token-based setup (for pre-created tunnels via Cloudflare dashboard) ──
if [[ "${1:-}" == "--token" && -n "${2:-}" ]]; then
    TOKEN="$2"
    info "Installing tunnel service with provided token..."
    cloudflared service install "$TOKEN"
    systemctl enable cloudflared
    systemctl start cloudflared
    info "Tunnel running! Check status: systemctl status cloudflared"
    info ""
    info "IMPORTANT: Update your camera records in Supabase with the tunnel hostname."
    info "  The hostname is configured in the Cloudflare Zero Trust dashboard."
    exit 0
fi

# ── Interactive setup ─────────────────────────────────────────────────────
info "Authenticating with Cloudflare (opens browser)..."
cloudflared tunnel login

# Create tunnel (idempotent — fails gracefully if exists)
if cloudflared tunnel list | grep -q "$TUNNEL_NAME"; then
    warn "Tunnel '$TUNNEL_NAME' already exists, reusing it"
    TUNNEL_ID=$(cloudflared tunnel list -o json | python3 -c "
import json,sys
for t in json.load(sys.stdin):
    if t['name'] == '$TUNNEL_NAME':
        print(t['id']); break
")
else
    info "Creating tunnel '$TUNNEL_NAME'..."
    TUNNEL_ID=$(cloudflared tunnel create "$TUNNEL_NAME" 2>&1 | grep -oP '[0-9a-f-]{36}')
fi

info "Tunnel ID: $TUNNEL_ID"

# ── Write config ──────────────────────────────────────────────────────────
CONFIG_DIR="/etc/cloudflared"
mkdir -p "$CONFIG_DIR"

# Copy credentials if they're in user home
CRED_SRC="$HOME/.cloudflared/${TUNNEL_ID}.json"
CRED_DST="${CONFIG_DIR}/${TUNNEL_ID}.json"
if [[ -f "$CRED_SRC" && ! -f "$CRED_DST" ]]; then
    cp "$CRED_SRC" "$CRED_DST"
fi

cat > "${CONFIG_DIR}/config.yml" <<YAML
tunnel: ${TUNNEL_ID}
credentials-file: ${CRED_DST}

# Route camera HTTP API through the tunnel
ingress:
  # Camera API — proxied to local network
  - service: http://${CAMERA_LOCAL_IP}:${CAMERA_LOCAL_PORT}
    originRequest:
      connectTimeout: 10s
      noTLSVerify: true
YAML

info "Config written to ${CONFIG_DIR}/config.yml"

# ── DNS route ─────────────────────────────────────────────────────────────
HOSTNAME="${TUNNEL_NAME}.lotlogic.com"
warn "You need a DNS CNAME record pointing to this tunnel."
warn "  Option A (if you own lotlogic.com on Cloudflare):"
warn "    cloudflared tunnel route dns ${TUNNEL_NAME} ${HOSTNAME}"
warn ""
warn "  Option B (use any domain you have on Cloudflare):"
warn "    cloudflared tunnel route dns ${TUNNEL_NAME} cameras.yourdomain.com"
warn ""
read -rp "Enter the hostname to use (or press Enter to skip DNS setup): " USER_HOSTNAME

if [[ -n "$USER_HOSTNAME" ]]; then
    info "Creating DNS route: $USER_HOSTNAME -> tunnel $TUNNEL_NAME"
    cloudflared tunnel route dns "$TUNNEL_NAME" "$USER_HOSTNAME" || warn "DNS route failed — you may need to set this up manually"
    FINAL_HOSTNAME="$USER_HOSTNAME"
else
    FINAL_HOSTNAME="<your-tunnel-hostname>"
    warn "Skipped DNS — set it up later with: cloudflared tunnel route dns ${TUNNEL_NAME} <hostname>"
fi

# ── Systemd service ───────────────────────────────────────────────────────
info "Installing systemd service..."
cloudflared service install 2>/dev/null || true
systemctl daemon-reload
systemctl enable cloudflared
systemctl start cloudflared

info "Tunnel service started!"
echo ""

# ── Summary ───────────────────────────────────────────────────────────────
cat <<SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  LotLogic Tunnel Setup Complete

  Tunnel:    ${TUNNEL_NAME}
  Tunnel ID: ${TUNNEL_ID}
  Hostname:  ${FINAL_HOSTNAME}
  Camera:    ${CAMERA_LOCAL_IP}:${CAMERA_LOCAL_PORT}
  Config:    ${CONFIG_DIR}/config.yml

  Commands:
    systemctl status cloudflared   # check status
    systemctl restart cloudflared  # restart
    journalctl -u cloudflared -f   # view logs

  NEXT STEP — Update cameras in Supabase:
    UPDATE cameras
    SET ip_address = '${FINAL_HOSTNAME}'
    WHERE ip_address LIKE '%trycloudflare.com';
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SUMMARY

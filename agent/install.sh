#!/usr/bin/env bash
set -euo pipefail

API_URL="${GPUBNB_API_URL:-https://gpubnb.netlify.app/api}"
LINK_CODE="${1:-}"

echo ""
echo "=== GPUbnb Agent installer (Linux) ==="
echo ""

# 1. Check Python
PYTHON=""
for cmd in python3 python; do
    if command -v "$cmd" &>/dev/null; then
        ver=$("$cmd" --version 2>&1 | grep -oP 'Python \K3\.(1[1-9]|[2-9][0-9])' || true)
        if [[ -n "$ver" ]]; then
            PYTHON="$cmd"
            echo "  [OK] Python $ver detected ($cmd)"
            break
        fi
    fi
done
if [[ -z "$PYTHON" ]]; then
    echo "  [ERR] Python 3.11+ is required. Install it first."
    exit 1
fi

# 2. Install agent
echo ""
echo "=== Installing GPUbnb Agent ==="
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
$PYTHON -m pip install --upgrade pip --quiet
$PYTHON -m pip install -e . --quiet
echo "  [OK] Agent installed"

# 3. Configure
echo ""
echo "=== Configuration ==="
CONFIG_DIR="$HOME/.gpubnb"
mkdir -p "$CONFIG_DIR"
echo "{\"apiUrl\": \"$API_URL\"}" > "$CONFIG_DIR/config.json"
echo "  [OK] Config created: $CONFIG_DIR/config.json"

# 4. Hardware scan
echo ""
echo "=== Initial hardware scan ==="
$PYTHON -m gpubnb_agent diagnose || echo "  [WARN] Scan had warnings (non-blocking)"
echo "  [OK] Scan complete"

# 5. Link (optional)
if [[ -n "$LINK_CODE" ]]; then
    echo ""
    echo "=== Linking machine with code: $LINK_CODE ==="
    $PYTHON -m gpubnb_agent link "$LINK_CODE" || echo "  [ERR] Link failed"
fi

# 6. Systemd service (optional)
if command -v systemctl &>/dev/null; then
    echo ""
    echo "=== Setting up systemd service ==="
    SERVICE_FILE="$HOME/.config/systemd/user/gpubnb-agent.service"
    mkdir -p "$(dirname "$SERVICE_FILE")"
    cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=GPUbnb Agent
After=network-online.target

[Service]
ExecStart=$PYTHON -m gpubnb_agent start
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable gpubnb-agent.service
    echo "  [OK] Service created and enabled (start with: systemctl --user start gpubnb-agent)"
fi

echo ""
echo "=== Installation complete ==="
echo "  Start agent:  $PYTHON -m gpubnb_agent start"
echo "  Scan hardware: $PYTHON -m gpubnb_agent diagnose"
echo "  Link machine:  $PYTHON -m gpubnb_agent link CODE"
echo ""

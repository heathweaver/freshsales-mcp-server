#!/bin/sh
# Start cloudflared if cert files exist, otherwise skip
# Update the tunnel ID and credentials file path after creating a Cloudflare tunnel
if [ -f /root/.cloudflared/cert.pem ] && ls /root/.cloudflared/*.json 1>/dev/null 2>&1; then
  /usr/local/bin/cloudflared tunnel --config /etc/cloudflared/config.yml run &
else
  echo "Warning: Cloudflared certificate files not found. Skipping cloudflared startup."
fi

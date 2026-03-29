#!/bin/sh
# Start cloudflared if cert files exist, otherwise skip
if [ -f /root/.cloudflared/cert.pem ] && [ -f /root/.cloudflared/fc8bde66-8fb2-40ad-92bb-da5a644f9e1a.json ]; then
  /usr/local/bin/cloudflared tunnel --config /etc/cloudflared/config.yml run fc8bde66-8fb2-40ad-92bb-da5a644f9e1a &
else
  echo "Warning: Cloudflared certificate files not found. Skipping cloudflared startup."
fi

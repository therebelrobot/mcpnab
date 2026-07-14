#!/bin/sh
set -e
mkdir -p "$(dirname "$MCPNAB_CONFIG")" /downloads "$NPM_CONFIG_CACHE" "$UV_CACHE_DIR"
[ -f "$MCPNAB_CONFIG" ] || cp /app/default-config.json "$MCPNAB_CONFIG"
if [ "$(id -u)" = "0" ]; then
  chown -R node:node /app/data /downloads 2>/dev/null || true
  exec su -s /bin/sh node -c 'exec node dist/src/index.js "$MCPNAB_CONFIG"'
fi
exec node dist/src/index.js "$MCPNAB_CONFIG"

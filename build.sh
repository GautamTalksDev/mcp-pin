#!/usr/bin/env bash
set -euo pipefail
export SITE_URL="${SITE_URL:-https://mcp-pin.gautamkhosla.com}"
node site/build.js --data data --out public
echo "built with SITE_URL=$SITE_URL"

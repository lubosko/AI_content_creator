#!/bin/sh
# Starts the app and opens it. Run with: ./start.sh
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js was not found on this computer."
  echo
  echo "  This app needs Node 18 or newer. Install it from https://nodejs.org/"
  echo "  or with your package manager, then run this again."
  echo
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo
  echo "  Node $NODE_MAJOR is too old. This app needs Node 18 or newer."
  echo
  exit 1
fi

# Prefer 3000, but do not fail if something already holds it.
APP_PORT=$(node scripts/free-port.js)
export PORT="$APP_PORT"

echo
echo "  AI Social Content Agent"
echo "  http://localhost:$APP_PORT"
echo
echo "  Press Ctrl+C to stop."
echo

# Open the browser where a desktop opener exists; never block on it.
URL="http://localhost:$APP_PORT"
if command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 &
elif command -v open >/dev/null 2>&1; then open "$URL" >/dev/null 2>&1 &
fi

exec node src/server.js
#!/usr/bin/env bash
set -uo pipefail

cd "$(dirname "$0")"

PORT="${1:-8080}"

if command -v python3 >/dev/null 2>&1; then
  PYTHON_CMD=(python3)
elif command -v python >/dev/null 2>&1 && python -c 'import sys; raise SystemExit(0 if sys.version_info[0] >= 3 else 1)' >/dev/null 2>&1; then
  PYTHON_CMD=(python)
else
  echo "Python 3 was not found."
  echo "Install Python 3 from https://www.python.org/downloads/macos/ or through Homebrew."
  echo
  if [ -t 0 ]; then
    read -r -p "Press Enter to close..." _
  fi
  exit 1
fi

echo
echo "TenderBomb server"
echo "================="
echo
echo "Open on this Mac:"
echo "  http://localhost:${PORT}/"
echo
echo "Share one of these LAN links with colleagues:"
if command -v ifconfig >/dev/null 2>&1; then
  LAN_LINKS="$(ifconfig | awk -v port="$PORT" '/inet / && $2 != "127.0.0.1" {print "  http://"$2":"port"/"}')"
  if [ -n "$LAN_LINKS" ]; then
    echo "$LAN_LINKS"
  else
    echo "  No LAN IPv4 address found."
  fi
else
  echo "  ifconfig is not available on this Mac."
fi
echo
echo "This launch serves the game and permanent leaderboards."
echo "Keep this window open while colleagues are playing."
echo "Commands in this window:"
echo "  god <nick>   - toggle tank god mode for this nick"
echo "  ungod <nick> - disable tank god mode for this nick"
echo "  restart      - restart server and warn users"
echo "  exit / quit / stop - stop server"
echo "Press Ctrl+C to stop the server."
echo

if command -v open >/dev/null 2>&1; then
  (sleep 1; open "http://localhost:${PORT}/" >/dev/null 2>&1) &
fi

"${PYTHON_CMD[@]}" -u server.py "$PORT"
SERVER_EXIT=$?

if [ "$SERVER_EXIT" -eq 77 ]; then
  exit 0
fi

echo
echo "TenderBomb server stopped with code ${SERVER_EXIT}."
if [ -t 0 ]; then
  read -r -p "Press Enter to close..." _
fi
exit "$SERVER_EXIT"

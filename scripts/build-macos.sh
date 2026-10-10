#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
DIST_DIR="${ROOT_DIR}/dist"

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  if command -v git >/dev/null 2>&1 && git -C "$ROOT_DIR" describe --tags --abbrev=0 >/dev/null 2>&1; then
    VERSION="$(git -C "$ROOT_DIR" describe --tags --abbrev=0)"
  else
    VERSION="dev"
  fi
fi

SAFE_VERSION="${VERSION//[^A-Za-z0-9._-]/-}"
PACKAGE_NAME="TenderBomb-${SAFE_VERSION}-macOS"
PACKAGE_DIR="${DIST_DIR}/${PACKAGE_NAME}"
ARCHIVE_NAME="${PACKAGE_NAME}.zip"
ARCHIVE_PATH="${DIST_DIR}/${ARCHIVE_NAME}"

for required in index.html styles.css server.py start-server-macos.command; do
  if [ ! -f "${ROOT_DIR}/${required}" ]; then
    echo "Missing required file: ${required}" >&2
    exit 1
  fi
done

if ! command -v rsync >/dev/null 2>&1; then
  echo "rsync is required to build the macOS archive." >&2
  exit 1
fi

if ! command -v zip >/dev/null 2>&1; then
  echo "zip is required to build the macOS archive." >&2
  exit 1
fi

mkdir -p "$DIST_DIR"
rm -rf "$PACKAGE_DIR"
rm -f "$ARCHIVE_PATH"
mkdir -p "$PACKAGE_DIR"

rsync -a \
  --exclude '.git/' \
  --exclude '.github/' \
  --exclude 'dist/' \
  --exclude '__pycache__/' \
  --exclude '.chrome-test-profile/' \
  --exclude '.DS_Store' \
  --exclude 'leaderboard-records.json' \
  --exclude 'leaderboard-cache.js' \
  --exclude '.server-notice.json' \
  --exclude '.online-state.json' \
  --exclude '*.log' \
  --exclude '*.tmp' \
  --exclude '*.bak' \
  --exclude '*.pid' \
  "$ROOT_DIR/" "$PACKAGE_DIR/"

chmod +x "$PACKAGE_DIR/start-server-macos.command"
chmod +x "$PACKAGE_DIR/scripts/build-macos.sh" 2>/dev/null || true

cat > "$PACKAGE_DIR/README-macOS.txt" <<'README'
TenderBomb macOS build
======================

1. Install Python 3 if it is not installed yet.
2. Double-click start-server-macos.command.
3. Open http://localhost:8080/ on this Mac, or share one of the LAN links printed in the terminal.

If macOS blocks the first launch, right-click start-server-macos.command and choose Open.
You can also start it from Terminal:

  ./start-server-macos.command

To use another port:

  ./start-server-macos.command 8090
README

(
  cd "$DIST_DIR"
  zip -r "$ARCHIVE_NAME" "$PACKAGE_NAME" >/dev/null
)

echo "Built ${ARCHIVE_PATH}"
echo "Package folder: ${PACKAGE_DIR}"

#!/usr/bin/env bash
# Opens Full Disk Access settings and prints the Electron.app path this repo uses.
# macOS cannot grant Full Disk Access from the terminal (no public API); you must
# toggle the app ON in System Settings. This script removes quarantine flags that
# sometimes block access after download, and reveals the exact path to add.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$DESKTOP_DIR/.." && pwd)"
cd "$DESKTOP_DIR"

ELECTRON_BIN="$(node -e "process.stdout.write(require('electron'))")"
# .../Electron.app/Contents/MacOS/Electron → bundle root
ELECTRON_APP="$(cd "$(dirname "$ELECTRON_BIN")/../.." && pwd)"

echo "── Constellagent (this checkout only) ──"
echo "Run the app from the terminal (do NOT double-click Electron.app — that shows the empty"
echo "Electron window with “To run a local app…”):"
echo "  cd \"$REPO_ROOT\" && bun run dev"
echo ""
echo "Electron executable (must match Full Disk Access entry):"
echo "  $ELECTRON_BIN"
echo ""
echo "Add this bundle in System Settings → Privacy & Security → Full Disk Access (toggle ON):"
echo "  $ELECTRON_APP"
echo ""
echo "If you use another git clone/worktree, run this script there too — each has its own"
echo "node_modules/electron path and needs its own FDA entry."
echo ""

if command -v xattr >/dev/null 2>&1; then
  echo "Clearing quarantine extended attributes on Electron.app (safe no-op if none)..."
  xattr -cr "$ELECTRON_APP" 2>/dev/null || true
fi

echo "Opening Full Disk Access…"
open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles" 2>/dev/null || true
sleep 0.4
open "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?path=Privacy/Full%20Disk%20Access" 2>/dev/null || true

echo ""
echo "Next: enable the toggle for Electron, quit Constellagent (⌘Q), then:"
echo "  cd \"$REPO_ROOT\" && bun run dev"
echo "Then toggle Phone Control off/on in Settings."

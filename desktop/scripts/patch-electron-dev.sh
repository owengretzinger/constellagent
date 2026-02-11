#!/bin/bash
# Patches Electron.app for dev mode: replaces icon + sets app name in plist.
# Also fixes node-pty permissions (bun install strips execute bits from prebuilds).
# Run after `bun install` or manually. Requires full app restart (Cmd+Q) to take effect.

# ── Fix node-pty spawn-helper permissions ──
# bun install extracts prebuilt binaries without the execute bit, causing
# "posix_spawnp failed" when node-pty tries to fork a PTY process.
SPAWN_HELPER="node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"
if [ -f "$SPAWN_HELPER" ] && [ ! -x "$SPAWN_HELPER" ]; then
  chmod +x "$SPAWN_HELPER"
  echo "Fixed node-pty spawn-helper permissions"
fi

PLIST="node_modules/electron/dist/Electron.app/Contents/Info.plist"
ICNS_SRC="build/icon.icns"
ICNS_DST="node_modules/electron/dist/Electron.app/Contents/Resources/electron.icns"

if [ ! -f "$PLIST" ]; then
  echo "Electron not installed yet, skipping patch"
  exit 0
fi

# Replace default icon with our icon
if [ -f "$ICNS_SRC" ]; then
  cp "$ICNS_SRC" "$ICNS_DST"
  echo "Replaced electron.icns with custom icon"
fi

# Set app name in plist (affects dock tooltip + About dialog)
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName 'Constellagent'" "$PLIST" 2>/dev/null
/usr/libexec/PlistBuddy -c "Set :CFBundleName 'Constellagent'" "$PLIST" 2>/dev/null

# Re-register bundle with Launch Services
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "node_modules/electron/dist/Electron.app" 2>/dev/null

echo "Patched Electron.app for dev mode. Restart the app (Cmd+Q then bun run dev)."

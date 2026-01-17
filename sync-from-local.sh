#!/bin/bash
# Sync local plugin development to npm package

LOCAL_PLUGIN="$HOME/.config/opencode/plugin/rate-limit-fallback.ts"
PKG_DIR="$HOME/personal/projects/opencode-rate-limit-fallback"

if [ ! -f "$LOCAL_PLUGIN" ]; then
  echo "Local plugin not found at $LOCAL_PLUGIN"
  exit 1
fi

# The local file is a single file, package has split structure
# This just reminds you to manually update if needed
echo "Local plugin: $LOCAL_PLUGIN"
echo "Package dir:  $PKG_DIR"
echo ""
echo "Remember to manually sync changes from local to src/plugin.ts and src/config.ts"
echo ""
echo "To publish:"
echo "  1. Update version in package.json"
echo "  2. git add -A && git commit -m 'release: vX.X.X'"
echo "  3. git push"
echo "  4. npm publish --otp=XXXXXX"

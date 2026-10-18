#!/bin/zsh
# Build (and optionally install) DeepChat.app from src/main.swift.
set -euo pipefail
cd "$(dirname "$0")"

APP=build/DeepChat.app
CACHE=build/module-cache

if [[ "${1:-}" == "--icons" ]]; then
  python3 make-icon.py
  rm -rf assets/DeepChat.iconset
  mkdir -p assets/DeepChat.iconset
  SOURCE=assets/DeepChat-1024.png
  for spec in "16 icon_16x16" "32 icon_16x16@2x" "32 icon_32x32" "64 icon_32x32@2x" \
              "128 icon_128x128" "256 icon_128x128@2x" "256 icon_256x256" \
              "512 icon_256x256@2x" "512 icon_512x512" "1024 icon_512x512@2x"; do
    set -- $spec
    sips -z "$1" "$1" "$SOURCE" --out "assets/DeepChat.iconset/$2.png" >/dev/null
  done
  iconutil -c icns assets/DeepChat.iconset -o assets/DeepChat.icns
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$CACHE"
cp assets/Info.plist "$APP/Contents/Info.plist"
cp assets/DeepChat.icns "$APP/Contents/Resources/DeepChat.icns"
printf 'APPL????' > "$APP/Contents/PkgInfo"

swiftc -O -swift-version 5 \
  -module-cache-path "$PWD/$CACHE" \
  -Xcc -fmodules-cache-path="$PWD/$CACHE" \
  -framework Cocoa -framework WebKit -lsqlite3 \
  src/main.swift -o "$APP/Contents/MacOS/DeepChat"

codesign --force --deep --sign - "$APP" >/dev/null
codesign --verify --deep --strict "$APP"
echo "built $(du -sh "$APP" | cut -f1)  $APP"

if [[ "${1:-}" == "--install" || "${2:-}" == "--install" ]]; then
  ditto "$APP" /Applications/DeepChat.app
  xattr -dr com.apple.quarantine /Applications/DeepChat.app 2>/dev/null || true
  echo "installed /Applications/DeepChat.app"
fi

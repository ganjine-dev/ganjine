#!/bin/sh
# Builds the unlock helper and ~/Applications/Ganjine.app.
set -eu
root="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$root/.ganjine/bin"
# Set explicitly: left alone, swiftc can stamp a macOS newer than this one, and Finder then refuses the app.
target="$(uname -m)-apple-macos14.0"
# The Keychain releases the key to this exact binary, so it is built once. Rebuilding it means a Keychain prompt.
[ -x "$root/.ganjine/bin/ganjine-unlock" ] || swiftc -O -target "$target" "$root/deploy/macos/ganjine-unlock.swift" -o "$root/.ganjine/bin/ganjine-unlock"
"$root/.ganjine/bin/ganjine-unlock" check >/dev/null

version="$(node -p "require('$root/framework/package.json').version")"
app="$HOME/Applications/Ganjine.app"
mkdir -p "$app/Contents/MacOS"
cat > "$app/Contents/Info.plist" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Ganjine</string>
<key>CFBundleIdentifier</key><string>local.ganjine.app</string>
<key>CFBundleExecutable</key><string>Ganjine</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>$version</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>GanjineRoot</key><string>$root</string>
</dict></plist>
P
swiftc -O -target "$target" -parse-as-library "$root/deploy/macos/GanjineApp.swift" -o "$app/Contents/MacOS/Ganjine"
codesign --force --sign - "$app"
echo "Built $app"

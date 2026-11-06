#!/usr/bin/env bash
# Install or remove the scheduled WeChat capture (LaunchAgents, no sudo).
#   ./install_launchd.sh                 build the launcher app, install the snapshot agent (every 15 min)
#   ./install_launchd.sh --auto-read     also install the twice-a-day auto-read agent (needs a non-empty allowlist)
#   ./install_launchd.sh --uninstall     boot out and remove both agents and the launcher app
# Env: PYTHON (default /usr/bin/python3, stdlib only), HOUR_1 / HOUR_2 (auto-read hours, default 10 and 20),
#      PREFIX (agents label prefix, default dev.mingz.wechat-ocr).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PY="${PYTHON:-/usr/bin/python3}"
HOUR_1="${HOUR_1:-10}"
HOUR_2="${HOUR_2:-20}"
APP="$HOME/Applications/WeChatOCR.app"
AGENTS="$HOME/Library/LaunchAgents"
DATA="$HOME/.wechat-export/ocr"
LOG="$DATA/launchd.log"
UID_="$(id -u)"
LABELS=(dev.mingz.wechat-ocr.snapshot dev.mingz.wechat-ocr.autoread)

boot_out() {
  for l in "${LABELS[@]}"; do
    launchctl bootout "gui/$UID_/$l" 2>/dev/null || true
  done
}

if [[ "${1:-}" == "--uninstall" ]]; then
  boot_out
  for l in "${LABELS[@]}"; do rm -f "$AGENTS/$l.plist"; done
  rm -rf "$APP"
  echo "removed both agents and $APP. Remove WeChatOCR from Screen Recording and Accessibility in System Settings by hand."
  exit 0
fi

WITH_AUTO=0
[[ "${1:-}" == "--auto-read" ]] && WITH_AUTO=1
if [[ $WITH_AUTO -eq 1 ]] && ! grep -qvE '^\s*(#|$)' "$DATA/allowlist.txt" 2>/dev/null; then
  echo "ERROR: $DATA/allowlist.txt is empty or missing. Add one chat name per line first." >&2
  exit 1
fi
[[ -x "$PY" ]] || { echo "ERROR: $PY not found" >&2; exit 1; }
[[ "$HOUR_1" =~ ^[0-9]+$ && "$HOUR_2" =~ ^[0-9]+$ && "$HOUR_1" -lt 24 && "$HOUR_2" -lt 24 ]] || { echo "ERROR: HOUR_1/HOUR_2 must be 0-23" >&2; exit 1; }

mkdir -p "$DATA" "$AGENTS" "$HOME/Applications" && chmod 700 "$DATA"

# 1. Launcher app: python and script paths are compiled in.
BUILD="$(mktemp -d)"; trap 'rm -rf "$BUILD"' EXIT
sed -e "s|{{PYTHON}}|$PY|g" -e "s|{{SCRIPT}}|$HERE/wechat_scheduled.py|g" "$HERE/launchd/WeChatOCR.swift" > "$BUILD/main.swift"
boot_out
rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS"
swiftc -O "$BUILD/main.swift" -o "$APP/Contents/MacOS/WeChatOCR"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.mingz.wechat-ocr</string>
<key>CFBundleName</key><string>WeChatOCR</string>
<key>CFBundleExecutable</key><string>WeChatOCR</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
</dict></plist>
PLIST
codesign --force --sign - "$APP"   # ad-hoc: the grant is tied to this build, so a rebuild asks again

# 2. Agents.
fill() {  # template label out
  sed -e "s|{{LAUNCHER}}|$APP/Contents/MacOS/WeChatOCR|g" -e "s|{{LOG}}|$LOG|g" \
      -e "s|{{HOUR_1}}|$HOUR_1|g" -e "s|{{HOUR_2}}|$HOUR_2|g" "$1" > "$3"
  plutil -lint "$3" >/dev/null
  launchctl bootstrap "gui/$UID_" "$3"
}
fill "$HERE/launchd/dev.mingz.wechat-ocr.snapshot.plist.template" snapshot "$AGENTS/dev.mingz.wechat-ocr.snapshot.plist"
[[ $WITH_AUTO -eq 1 ]] && fill "$HERE/launchd/dev.mingz.wechat-ocr.autoread.plist.template" autoread "$AGENTS/dev.mingz.wechat-ocr.autoread.plist"

echo "Installed. Log: $LOG"
echo "Next, by hand: System Settings > Privacy & Security > Screen Recording, add and enable $APP"
[[ $WITH_AUTO -eq 1 ]] && echo "Auto-read also needs Accessibility for the same app."
echo "Test: launchctl kickstart -k gui/$UID_/dev.mingz.wechat-ocr.snapshot; tail -3 $LOG"

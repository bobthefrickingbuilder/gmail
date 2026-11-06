#!/usr/bin/env bash
# Builds a SIGNED release APK and publishes it to the private download page.
#   API_BASE=https://mail.example.com ./scripts/build-apk.sh
# Needs: Java 21, Android SDK (ANDROID_HOME), android/keystore.properties (scripts/make-keystore.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
: "${API_BASE:?Set API_BASE to your backend URL, e.g. API_BASE=https://mail.example.com}"
case "$API_BASE" in https://*) ;; *) echo "API_BASE must start with https:// (Android blocks plain http, so the app could not reach the server)"; exit 1;; esac
: "${ANDROID_HOME:=${ANDROID_SDK_ROOT:-}}"
[ -n "$ANDROID_HOME" ] || { echo "ANDROID_HOME is not set (install Android Studio or the command-line tools)"; exit 1; }
[ -f android/keystore.properties ] || { echo "No android/keystore.properties — run scripts/make-keystore.sh first"; exit 1; }
VERSION=$(node -p "require('./package.json').version")
RELEASES_DIR=${RELEASES_DIR:-backend/data/releases}

echo "==> Building web app for $API_BASE (v$VERSION)"
FCM_ENABLED=false; [ -f android/app/google-services.json ] && FCM_ENABLED=true
echo "Android push (Firebase): $FCM_ENABLED"
VITE_API_BASE="$API_BASE" VITE_FCM_ENABLED="$FCM_ENABLED" npm run build -w web
echo "==> Syncing into Android project"
npx cap sync android
echo "==> Gradle assembleRelease"
(cd android && ./gradlew --no-daemon assembleRelease)
APK=android/app/build/outputs/apk/release/app-release.apk
[ -f "$APK" ] || { echo "APK not found at $APK"; exit 1; }
"$ANDROID_HOME"/build-tools/*/apksigner verify "$APK" >/dev/null && echo "==> Signature verified"

mkdir -p "$RELEASES_DIR"
OUT="email-assistant-v$VERSION.apk"
cp "$APK" "$RELEASES_DIR/$OUT"
NOTES=$(node scripts/changelog-notes.mjs "$VERSION")
node -e '
const fs=require("fs"); const f=process.argv[1]; let r=[]; try{r=JSON.parse(fs.readFileSync(f))}catch{}
r=r.filter(x=>x.version!==process.argv[2]); r.unshift({version:process.argv[2],file:process.argv[3],date:new Date().toISOString().slice(0,10),notes:process.argv[4]});
fs.writeFileSync(f, JSON.stringify(r,null,2));' "$RELEASES_DIR/releases.json" "$VERSION" "$OUT" "$NOTES"
echo "==> Published $RELEASES_DIR/$OUT (download page: $API_BASE/download)"

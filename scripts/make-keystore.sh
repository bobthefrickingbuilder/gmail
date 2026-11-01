#!/usr/bin/env bash
# Creates the Android signing key (ONE TIME). Keep the .jks file and passwords safe:
# losing them means future updates cannot install over the existing app.
# Output: android/keystore/release.jks + android/keystore.properties (both git-ignored).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p android/keystore
if [ -f android/keystore/release.jks ]; then echo "android/keystore/release.jks already exists — not overwriting."; exit 1; fi
read -r -s -p "Choose a keystore password (16+ chars): " PW; echo
[ ${#PW} -ge 16 ] || { echo "Too short"; exit 1; }
keytool -genkeypair -v -keystore android/keystore/release.jks -alias assistant -keyalg RSA -keysize 4096 -validity 10000 \
  -storepass "$PW" -keypass "$PW" -dname "CN=Email Assistant, O=Matthew Menard, L=Ottawa, C=CA"
cat > android/keystore.properties <<PROPS
storeFile=../keystore/release.jks
storePassword=$PW
keyAlias=assistant
keyPassword=$PW
PROPS
chmod 600 android/keystore.properties android/keystore/release.jks
echo "Done. Back up android/keystore/release.jks and the password to a password manager NOW (see docs/INSTALL.md)."

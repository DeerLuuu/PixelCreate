#!/data/data/com.dsharnessmobile.shell/files/usr/bin/bash
# PixelCraft APK build (no gradle): aapt2 + javac + d8 + apksigner
set -e
ROOT="/storage/emulated/0/Download/ds文件夹/pixelcraft"
source "$ROOT/toolchain/env.sh"
ANDROID_JAR="$HOME/android-sdk/platforms/android-34/android.jar"
AAPT2="$P/bin/aapt2"
D8="$P/bin/d8"
KS="$ROOT/toolchain/debug.keystore"

echo "== clean =="
rm -rf "$ROOT/build"
mkdir -p "$ROOT/build/classes" "$ROOT/build/rescomp" "$ROOT/build/assets-stage"

echo "== stage assets =="
cp -r "$ROOT/app2/www" "$ROOT/build/assets-stage/www"   # React/PWA web build

echo "== aapt2 compile =="
"$AAPT2" compile --dir "$ROOT/android/res" -o "$ROOT/build/rescomp/res.zip"

echo "== aapt2 link =="
LD_LIBRARY_PATH=$P/lib "$AAPT2" link \
  -o "$ROOT/build/base.apk" \
  -I "$ANDROID_JAR" \
  --manifest "$ROOT/android/AndroidManifest.xml" \
  -A "$ROOT/build/assets-stage" \
  --min-sdk-version 24 --target-sdk-version 34 \
  --auto-add-overlay \
  "$ROOT/build/rescomp/res.zip"

echo "== javac =="
cd "$ROOT"
find android/java -name "*.java" > build/sources.txt
LD_LIBRARY_PATH=$P/lib "$JAVA_HOME/bin/javac" -source 8 -target 8 -bootclasspath "$ANDROID_JAR" \
  -classpath "$ANDROID_JAR" -d build/classes @build/sources.txt 2>&1 | grep -v "bootstrap class path" || true

echo "== d8 =="
cd "$ROOT"
mkdir -p build/dex
find "$ROOT/build/classes" -name "*.class" > build/classes.txt
LD_LIBRARY_PATH=$P/lib "$D8" --min-api 24 --lib "$ANDROID_JAR" --output "$ROOT/build/dex" @build/classes.txt
ls -la build/dex/

echo "== add classes.dex to apk =="
cd "$ROOT/build/dex"
"$JAVA_HOME/bin/jar" uf "$ROOT/build/base.apk" classes.dex

echo "== keystore =="
if [ ! -f "$KS" ]; then
  mkdir -p "$(dirname "$KS")"
  LD_LIBRARY_PATH=$P/lib "$JAVA_HOME/bin/keytool" -genkeypair -keystore "$KS" -alias pixelcraft \
    -storepass pixelcraft -keypass pixelcraft -dname "CN=PixelCraft,O=PixelCraft,C=CN" \
    -keyalg RSA -keysize 2048 -validity 10000
fi

echo "== sign =="
LD_LIBRARY_PATH=$P/lib "$JAVA_HOME/bin/java" -jar "$P/share/java/apksigner.jar" sign \
  --ks "$KS" --ks-key-alias pixelcraft --ks-pass pass:pixelcraft --key-pass pass:pixelcraft \
  --out "$ROOT/build/PixelCraft.apk" "$ROOT/build/base.apk"

echo "== verify =="
LD_LIBRARY_PATH=$P/lib "$JAVA_HOME/bin/java" -jar "$P/share/java/apksigner.jar" verify --print-certs "$ROOT/build/PixelCraft.apk" | head -5
ls -la "$ROOT/build/PixelCraft.apk"
echo "BUILD OK"

#!/data/data/com.dsharnessmobile.shell/files/usr/bin/bash
# Shared environment for the PixelCraft Android build toolchain
export P=/data/data/com.dsharnessmobile.shell/files/usr
export JAVA_HOME=$P/usr/lib/jvm/java-17-openjdk
export LD_LIBRARY_PATH=$P/lib
export PATH=$JAVA_HOME/bin:$P/bin:/system/bin:/system/xbin
export ANDROID_HOME=$HOME/android-sdk
export ANDROID_SDK_ROOT=$ANDROID_HOME
export TOOLCHAIN=/storage/emulated/0/Download/ds文件夹/pixelcraft/toolchain
alias java='$JAVA_HOME/bin/java'

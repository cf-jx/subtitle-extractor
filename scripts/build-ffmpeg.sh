#!/usr/bin/env bash
set -euo pipefail

FFMPEG_VERSION="8.1.2"
FFMPEG_SHA256="464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-}"
HOST_SYSTEM="$(uname -s)"
HOST_ARCH="$(uname -m)"
CONFIGURE_TARGET=()

case "$TARGET" in
  aarch64-apple-darwin)
    if [[ "$HOST_SYSTEM" != "Darwin" ]]; then
      echo "The macOS arm64 runtime must be built on macOS." >&2
      exit 1
    fi
    EXECUTABLE_SUFFIX=""
    TARGET_ARCH="arm64"
    SDK_ROOT="$(xcrun --sdk macosx --show-sdk-path)"
    export MACOSX_DEPLOYMENT_TARGET=13.0
    CONFIGURE_TARGET=(
      --target-os=darwin
      --arch=arm64
      --cc=clang
      "--sysroot=$SDK_ROOT"
      "--extra-cflags=-arch arm64 -mmacosx-version-min=13.0"
      "--extra-ldflags=-arch arm64 -mmacosx-version-min=13.0"
    )
    if [[ "$HOST_ARCH" != "arm64" ]]; then
      CONFIGURE_TARGET+=(--enable-cross-compile)
    fi
    ;;
  x86_64-apple-darwin)
    if [[ "$HOST_SYSTEM" != "Darwin" ]]; then
      echo "The macOS x86_64 runtime must be built on macOS." >&2
      exit 1
    fi
    EXECUTABLE_SUFFIX=""
    TARGET_ARCH="x86_64"
    SDK_ROOT="$(xcrun --sdk macosx --show-sdk-path)"
    export MACOSX_DEPLOYMENT_TARGET=13.0
    CONFIGURE_TARGET=(
      --target-os=darwin
      --arch=x86_64
      --cc=clang
      --disable-x86asm
      "--sysroot=$SDK_ROOT"
      "--extra-cflags=-arch x86_64 -mmacosx-version-min=13.0"
      "--extra-ldflags=-arch x86_64 -mmacosx-version-min=13.0"
    )
    if [[ "$HOST_ARCH" != "x86_64" ]]; then
      CONFIGURE_TARGET+=(--enable-cross-compile)
    fi
    ;;
  x86_64-pc-windows-msvc)
    EXECUTABLE_SUFFIX=".exe"
    TARGET_ARCH="x86_64"
    if ! command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1; then
      echo "Windows FFmpeg requires MSYS2 UCRT64 with x86_64-w64-mingw32-gcc." >&2
      exit 1
    fi
    CONFIGURE_TARGET=(
      --target-os=mingw32
      --arch=x86_64
      --enable-cross-compile
      --cross-prefix=x86_64-w64-mingw32-
      --cc=x86_64-w64-mingw32-gcc
      --disable-x86asm
      --extra-cflags=-static
      --extra-ldflags=-static
    )
    ;;
  *)
    echo "Usage: $0 <aarch64-apple-darwin|x86_64-apple-darwin|x86_64-pc-windows-msvc>" >&2
    exit 2
    ;;
esac

BUILD_ROOT="$(mktemp -d)"
trap 'rm -rf "$BUILD_ROOT"' EXIT

curl --proto '=https' --tlsv1.2 -fL --retry 3 \
  "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
  -o "$BUILD_ROOT/ffmpeg.tar.xz"
if command -v shasum >/dev/null 2>&1; then
  printf '%s  %s\n' "$FFMPEG_SHA256" "$BUILD_ROOT/ffmpeg.tar.xz" | shasum -a 256 -c -
else
  printf '%s  %s\n' "$FFMPEG_SHA256" "$BUILD_ROOT/ffmpeg.tar.xz" | sha256sum -c -
fi
tar -xf "$BUILD_ROOT/ffmpeg.tar.xz" -C "$BUILD_ROOT"

cd "$BUILD_ROOT/ffmpeg-${FFMPEG_VERSION}"
./configure \
  "${CONFIGURE_TARGET[@]}" \
  --disable-autodetect \
  --disable-gpl \
  --disable-nonfree \
  --disable-doc \
  --disable-debug \
  --disable-ffplay \
  --disable-network \
  --disable-avdevice \
  --disable-encoders \
  --enable-encoder=pcm_s16le \
  --disable-muxers \
  --enable-muxer=wav \
  --enable-static \
  --disable-shared

make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu)" ffmpeg ffprobe

case "$TARGET" in
  *-apple-darwin)
    for program in ffmpeg ffprobe; do
      if [[ "$(xcrun lipo -archs "$program")" != "$TARGET_ARCH" ]]; then
        echo "$program architecture verification failed for $TARGET." >&2
        exit 1
      fi
      if ! xcrun vtool -show-build "$program" | grep -Eq 'minos +13\.0'; then
        echo "$program minimum macOS version verification failed." >&2
        exit 1
      fi
    done
    ;;
  x86_64-pc-windows-msvc)
    for program in ffmpeg.exe ffprobe.exe; do
      if ! x86_64-w64-mingw32-objdump -f "$program" | grep -q 'pei-x86-64'; then
        echo "$program architecture verification failed for Windows x64." >&2
        exit 1
      fi
    done
    ;;
esac

mkdir -p "$PROJECT_ROOT/src-tauri/binaries"
install -m 0755 "ffmpeg${EXECUTABLE_SUFFIX}" \
  "$PROJECT_ROOT/src-tauri/binaries/ffmpeg-${TARGET}${EXECUTABLE_SUFFIX}"
install -m 0755 "ffprobe${EXECUTABLE_SUFFIX}" \
  "$PROJECT_ROOT/src-tauri/binaries/ffprobe-${TARGET}${EXECUTABLE_SUFFIX}"

#!/usr/bin/env bash
set -euo pipefail

FFMPEG_VERSION="8.1.2"
FFMPEG_SHA256="464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c"
TARGET_TRIPLE="${1:-x86_64-pc-windows-msvc}"
EXPECTED_TARGET="x86_64-pc-windows-msvc"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$TARGET_TRIPLE" != "$EXPECTED_TARGET" ]]; then
  echo "Windows FFmpeg build only supports ${EXPECTED_TARGET}" >&2
  exit 2
fi

if [[ "${MSYSTEM:-}" != "UCRT64" ]]; then
  echo "Run this script from an MSYS2 UCRT64 shell" >&2
  exit 2
fi

for tool in ar curl file gcc make nm objdump ranlib sha256sum strip tar; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Missing required MSYS2 build tool: ${tool}" >&2
    exit 2
  fi
done

case "$(gcc -dumpmachine)" in
  x86_64-w64-mingw32*)
    ;;
  *)
    echo "Expected an x86_64 MinGW-w64 compiler, got: $(gcc -dumpmachine)" >&2
    exit 2
    ;;
esac

BUILD_ROOT="$(mktemp -d)"
trap 'rm -rf "$BUILD_ROOT"' EXIT

curl --proto '=https' --tlsv1.2 -fL --retry 3 \
  "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
  -o "$BUILD_ROOT/ffmpeg.tar.xz"
printf '%s  %s\n' "$FFMPEG_SHA256" "$BUILD_ROOT/ffmpeg.tar.xz" \
  | sha256sum --check --strict
tar -xf "$BUILD_ROOT/ffmpeg.tar.xz" -C "$BUILD_ROOT"

cd "$BUILD_ROOT/ffmpeg-${FFMPEG_VERSION}"
./configure \
  --target-os=mingw32 \
  --arch=x86_64 \
  --cc=gcc \
  --ld=gcc \
  --ar=ar \
  --nm=nm \
  --ranlib=ranlib \
  --strip=strip \
  --pkg-config=false \
  --disable-autodetect \
  --disable-gpl \
  --disable-nonfree \
  --disable-doc \
  --disable-debug \
  --disable-ffplay \
  --disable-network \
  --disable-avdevice \
  --disable-postproc \
  --disable-encoders \
  --enable-encoder=pcm_s16le \
  --disable-muxers \
  --enable-muxer=wav \
  --enable-w32threads \
  --disable-pthreads \
  --enable-static \
  --disable-shared \
  --extra-cflags="-O2 -pipe" \
  --extra-ldflags="-static -static-libgcc"

make -j"${NUMBER_OF_PROCESSORS:-2}" ffmpeg ffprobe
strip ffmpeg.exe ffprobe.exe

BINARY_DIRECTORY="$PROJECT_ROOT/src-tauri/binaries"
mkdir -p "$BINARY_DIRECTORY"
install -m 0755 ffmpeg.exe \
  "$BINARY_DIRECTORY/ffmpeg-${TARGET_TRIPLE}.exe"
install -m 0755 ffprobe.exe \
  "$BINARY_DIRECTORY/ffprobe-${TARGET_TRIPLE}.exe"

for executable in \
  "$BINARY_DIRECTORY/ffmpeg-${TARGET_TRIPLE}.exe" \
  "$BINARY_DIRECTORY/ffprobe-${TARGET_TRIPLE}.exe"; do
  description="$(file "$executable")"
  if ! grep -Eq 'PE32\+ executable .*x86-64' <<<"$description"; then
    echo "Expected an x86-64 PE32+ executable: ${description}" >&2
    exit 1
  fi

  if objdump -p "$executable" \
    | grep -Eiq 'DLL Name: (libgcc|libstdc\+\+|libwinpthread)[^ ]*\.dll'; then
    echo "Unexpected MinGW runtime DLL dependency in ${executable}" >&2
    objdump -p "$executable" | grep -i 'DLL Name:' >&2
    exit 1
  fi
done

"$BINARY_DIRECTORY/ffmpeg-${TARGET_TRIPLE}.exe" -hide_banner -version \
  | grep -F "ffmpeg version ${FFMPEG_VERSION}"
"$BINARY_DIRECTORY/ffprobe-${TARGET_TRIPLE}.exe" -hide_banner -version \
  | grep -F "ffprobe version ${FFMPEG_VERSION}"

echo "Built and verified Windows x64 FFmpeg sidecars"

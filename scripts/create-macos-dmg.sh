#!/usr/bin/env bash
set -euo pipefail

export LANG="en_US.UTF-8"
export LC_ALL="en_US.UTF-8"
umask 077

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [[ "${1:-}" == "--" ]]; then
  shift
fi
TARGET="${1:-}"
APP_ARGUMENT="${2:-}"

usage() {
  echo "Usage: $0 <aarch64-apple-darwin|x86_64-apple-darwin> [path-to-repaired-app]" >&2
}

fail() {
  echo "macOS DMG creation failed: $*" >&2
  exit 1
}

canonical_path() {
  local input_path="$1"
  local input_directory
  local input_name
  input_directory="$(cd "$(dirname "$input_path")" && pwd -P)"
  input_name="$(basename "$input_path")"
  printf '%s/%s\n' "$input_directory" "$input_name"
}

case "$TARGET" in
  aarch64-apple-darwin)
    EXPECTED_ARCH="arm64"
    ARTIFACT_ARCH="arm64"
    ;;
  x86_64-apple-darwin)
    EXPECTED_ARCH="x86_64"
    ARTIFACT_ARCH="x64"
    ;;
  *)
    usage
    exit 2
    ;;
esac

[[ "$(uname -s)" == "Darwin" ]] || fail "this script must run on macOS"

for required_tool in codesign diskutil ditto hdiutil plutil xcrun; do
  command -v "$required_tool" >/dev/null 2>&1 ||
    fail "missing required tool: $required_tool"
done

BUNDLE_ROOT="$PROJECT_ROOT/src-tauri/target/$TARGET/release/bundle"
APP_DIRECTORY="$BUNDLE_ROOT/macos"
if [[ -n "$APP_ARGUMENT" ]]; then
  [[ -d "$APP_ARGUMENT" ]] || fail "app bundle does not exist: $APP_ARGUMENT"
  APP_PATH="$(canonical_path "$APP_ARGUMENT")"
else
  shopt -s nullglob
  APP_CANDIDATES=("$APP_DIRECTORY"/*.app)
  shopt -u nullglob
  [[ "${#APP_CANDIDATES[@]}" -eq 1 ]] ||
    fail "expected exactly one app bundle in $APP_DIRECTORY"
  APP_PATH="$(canonical_path "${APP_CANDIDATES[0]}")"
fi

EXPECTED_APP_DIRECTORY="$(canonical_path "$APP_DIRECTORY")"
case "$APP_PATH" in
  "$EXPECTED_APP_DIRECTORY"/*.app)
    ;;
  *)
    fail "app bundle must be inside $EXPECTED_APP_DIRECTORY"
    ;;
esac

[[ ! -L "$APP_PATH" ]] || fail "app bundle must not be a symbolic link"
codesign --verify --deep --strict --verbose=4 "$APP_PATH"

APP_SIGNATURE="$(codesign -dvv "$APP_PATH" 2>&1)"
grep -q "Signature=adhoc" <<<"$APP_SIGNATURE" ||
  fail "expected a repaired ad-hoc signed app"

INFO_PLIST="$APP_PATH/Contents/Info.plist"
[[ -f "$INFO_PLIST" ]] || fail "missing Info.plist"
MAIN_EXECUTABLE="$(plutil -extract CFBundleExecutable raw -o - "$INFO_PLIST")"
APP_VERSION="$(plutil -extract CFBundleShortVersionString raw -o - "$INFO_PLIST")"
MAIN_PATH="$APP_PATH/Contents/MacOS/$MAIN_EXECUTABLE"
[[ -f "$MAIN_PATH" ]] || fail "missing main executable"

MAIN_ARCHES="$(xcrun lipo -archs "$MAIN_PATH")"
[[ " $MAIN_ARCHES " == *" $EXPECTED_ARCH "* ]] ||
  fail "main executable does not contain $EXPECTED_ARCH: $MAIN_ARCHES"

APP_NAME="$(basename "$APP_PATH")"
PRODUCT_NAME="${APP_NAME%.app}"
OUTPUT_DIRECTORY="$BUNDLE_ROOT/dmg"
OUTPUT_DMG="$OUTPUT_DIRECTORY/${PRODUCT_NAME}_${APP_VERSION}_${ARTIFACT_ARCH}.dmg"

TEMP_ROOT="$(mktemp -d -t subtitle-extractor-dmg)"
STAGING_DIRECTORY="$TEMP_ROOT/staging"
MOUNT_DIRECTORY="$TEMP_ROOT/mount"
TEMP_DMG="$TEMP_ROOT/output.dmg"
MOUNTED=0

cleanup() {
  local cleanup_status=$?
  set +e
  if [[ "${MOUNTED:-0}" -eq 1 && -d "${MOUNT_DIRECTORY:-}" ]]; then
    hdiutil detach "$MOUNT_DIRECTORY" -force >/dev/null 2>&1
  fi
  if [[ -n "${TEMP_ROOT:-}" && -d "$TEMP_ROOT" ]]; then
    case "$TEMP_ROOT" in
      */subtitle-extractor-dmg.*)
        /bin/rm -rf -- "$TEMP_ROOT"
        ;;
    esac
  fi
  exit "$cleanup_status"
}
trap cleanup EXIT

/bin/mkdir -p "$STAGING_DIRECTORY" "$MOUNT_DIRECTORY"
ditto --noqtn "$APP_PATH" "$STAGING_DIRECTORY/$APP_NAME"
/bin/ln -s /Applications "$STAGING_DIRECTORY/Applications"

hdiutil create \
  -quiet \
  -fs HFS+ \
  -format UDZO \
  -imagekey zlib-level=9 \
  -srcfolder "$STAGING_DIRECTORY" \
  -volname "$PRODUCT_NAME" \
  "$TEMP_DMG"

hdiutil attach \
  -quiet \
  -readonly \
  -nobrowse \
  -noautoopen \
  -mountpoint "$MOUNT_DIRECTORY" \
  "$TEMP_DMG"
MOUNTED=1

MOUNT_WRITABLE="$(
  /usr/sbin/diskutil info -plist "$MOUNT_DIRECTORY" |
    plutil -extract Writable raw -o - -
)"
[[ "$MOUNT_WRITABLE" == "false" ]] ||
  fail "DMG was not mounted read-only"

[[ -L "$MOUNT_DIRECTORY/Applications" ]] ||
  fail "DMG is missing the Applications symbolic link"
[[ "$(readlink "$MOUNT_DIRECTORY/Applications")" == "/Applications" ]] ||
  fail "Applications symbolic link has the wrong target"

MOUNTED_APP="$MOUNT_DIRECTORY/$APP_NAME"
[[ -d "$MOUNTED_APP" ]] || fail "DMG is missing $APP_NAME"
codesign --verify --deep --strict --verbose=4 "$MOUNTED_APP"

MOUNTED_YT_DLP="$MOUNTED_APP/Contents/MacOS/yt-dlp"
[[ -x "$MOUNTED_YT_DLP" ]] || fail "DMG app is missing executable yt-dlp"
YT_DLP_VERSION="$("$MOUNTED_YT_DLP" --version)"
grep -Eq '^[0-9]{4}\.[0-9]{2}\.[0-9]{2}$' <<<"$YT_DLP_VERSION" ||
  fail "unexpected yt-dlp version output: $YT_DLP_VERSION"

hdiutil detach -quiet "$MOUNT_DIRECTORY"
MOUNTED=0

/bin/mkdir -p "$OUTPUT_DIRECTORY"
/bin/mv -f "$TEMP_DMG" "$OUTPUT_DMG"

printf 'Target: %s\n' "$TARGET"
printf 'App: %s\n' "$APP_PATH"
printf 'DMG: %s\n' "$OUTPUT_DMG"
printf 'Applications link: /Applications\n'
printf 'Mounted read-only: passed\n'
printf 'yt-dlp: %s\n' "$YT_DLP_VERSION"
printf 'Signature verification: passed\n'

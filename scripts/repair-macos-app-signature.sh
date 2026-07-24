#!/usr/bin/env bash
set -euo pipefail

export LANG="en_US.UTF-8"
export LC_ALL="en_US.UTF-8"

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [[ "${1:-}" == "--" ]]; then
  shift
fi
TARGET="${1:-}"
APP_ARGUMENT="${2:-}"

usage() {
  echo "Usage: $0 <aarch64-apple-darwin|x86_64-apple-darwin> [path-to-app]" >&2
}

fail() {
  echo "macOS signature repair failed: $*" >&2
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
    ;;
  x86_64-apple-darwin)
    EXPECTED_ARCH="x86_64"
    ;;
  *)
    usage
    exit 2
    ;;
esac

[[ "$(uname -s)" == "Darwin" ]] || fail "this script must run on macOS"

for required_tool in codesign plutil shasum xcrun; do
  command -v "$required_tool" >/dev/null 2>&1 ||
    fail "missing required tool: $required_tool"
done

BUNDLE_DIRECTORY="$PROJECT_ROOT/src-tauri/target/$TARGET/release/bundle/macos"
if [[ -n "$APP_ARGUMENT" ]]; then
  [[ -d "$APP_ARGUMENT" ]] || fail "app bundle does not exist: $APP_ARGUMENT"
  APP_PATH="$(canonical_path "$APP_ARGUMENT")"
else
  shopt -s nullglob
  APP_CANDIDATES=("$BUNDLE_DIRECTORY"/*.app)
  shopt -u nullglob
  [[ "${#APP_CANDIDATES[@]}" -eq 1 ]] ||
    fail "expected exactly one app bundle in $BUNDLE_DIRECTORY"
  APP_PATH="$(canonical_path "${APP_CANDIDATES[0]}")"
fi

EXPECTED_BUNDLE_DIRECTORY="$(canonical_path "$BUNDLE_DIRECTORY")"
case "$APP_PATH" in
  "$EXPECTED_BUNDLE_DIRECTORY"/*.app)
    ;;
  *)
    fail "app bundle must be inside $EXPECTED_BUNDLE_DIRECTORY"
    ;;
esac

[[ ! -L "$APP_PATH" ]] || fail "app bundle must not be a symbolic link"

INFO_PLIST="$APP_PATH/Contents/Info.plist"
[[ -f "$INFO_PLIST" ]] || fail "missing Info.plist"
MAIN_EXECUTABLE="$(plutil -extract CFBundleExecutable raw -o - "$INFO_PLIST")"
MAIN_PATH="$APP_PATH/Contents/MacOS/$MAIN_EXECUTABLE"
[[ -f "$MAIN_PATH" ]] || fail "missing main executable: $MAIN_PATH"

MAIN_ARCHES="$(xcrun lipo -archs "$MAIN_PATH")"
[[ " $MAIN_ARCHES " == *" $EXPECTED_ARCH "* ]] ||
  fail "main executable does not contain $EXPECTED_ARCH: $MAIN_ARCHES"

APP_SIGNATURE="$(codesign -dvv "$APP_PATH" 2>&1)"
grep -q "Signature=adhoc" <<<"$APP_SIGNATURE" ||
  fail "refusing to replace a bundle that is not ad-hoc signed"

SOURCE_YT_DLP="$PROJECT_ROOT/src-tauri/binaries/yt-dlp-$TARGET"
BUNDLED_YT_DLP="$APP_PATH/Contents/MacOS/yt-dlp"
[[ -f "$SOURCE_YT_DLP" ]] || fail "missing pinned yt-dlp: $SOURCE_YT_DLP"
[[ ! -L "$SOURCE_YT_DLP" ]] || fail "pinned yt-dlp must not be a symbolic link"
[[ -f "$BUNDLED_YT_DLP" ]] || fail "bundle is missing yt-dlp"
[[ ! -L "$BUNDLED_YT_DLP" ]] || fail "bundled yt-dlp must not be a symbolic link"

SOURCE_ARCHES="$(xcrun lipo -archs "$SOURCE_YT_DLP")"
[[ " $SOURCE_ARCHES " == *" $EXPECTED_ARCH "* ]] ||
  fail "pinned yt-dlp does not contain $EXPECTED_ARCH: $SOURCE_ARCHES"
codesign --verify --strict --verbose=2 "$SOURCE_YT_DLP"

TEMP_YT_DLP="$(mktemp "$APP_PATH/Contents/MacOS/.yt-dlp.replacement.XXXXXX")"
cleanup() {
  if [[ -n "${TEMP_YT_DLP:-}" && -e "$TEMP_YT_DLP" ]]; then
    /bin/rm -f -- "$TEMP_YT_DLP"
  fi
}
trap cleanup EXIT

/bin/cp -p "$SOURCE_YT_DLP" "$TEMP_YT_DLP"
/bin/chmod 0755 "$TEMP_YT_DLP"
codesign --verify --strict --verbose=2 "$TEMP_YT_DLP"
/bin/mv -f "$TEMP_YT_DLP" "$BUNDLED_YT_DLP"
TEMP_YT_DLP=""

SOURCE_HASH="$(shasum -a 256 "$SOURCE_YT_DLP" | awk '{print $1}')"
BUNDLED_HASH="$(shasum -a 256 "$BUNDLED_YT_DLP" | awk '{print $1}')"
[[ "$SOURCE_HASH" == "$BUNDLED_HASH" ]] ||
  fail "bundled yt-dlp does not match the pinned artifact"

# Do not use --deep while signing. It would rewrite the PyInstaller executable
# that was restored above. The final deep verification still validates every
# nested executable and the outer resource seal.
codesign \
  --force \
  --sign - \
  --options runtime \
  --preserve-metadata=identifier,entitlements,requirements \
  --timestamp=none \
  "$APP_PATH"

codesign --verify --strict --verbose=2 "$BUNDLED_YT_DLP"
YT_DLP_VERSION="$("$BUNDLED_YT_DLP" --version)"
grep -Eq '^[0-9]{4}\.[0-9]{2}\.[0-9]{2}$' <<<"$YT_DLP_VERSION" ||
  fail "unexpected yt-dlp version output: $YT_DLP_VERSION"

codesign --verify --deep --strict --verbose=4 "$APP_PATH"
FINAL_SIGNATURE="$(codesign -dvv "$APP_PATH" 2>&1)"
grep -q "Signature=adhoc" <<<"$FINAL_SIGNATURE" ||
  fail "outer app is not ad-hoc signed after repair"

printf 'Target: %s\n' "$TARGET"
printf 'App: %s\n' "$APP_PATH"
printf 'yt-dlp: %s\n' "$YT_DLP_VERSION"
printf 'yt-dlp SHA-256: %s\n' "$BUNDLED_HASH"
printf 'Signature verification: passed\n'

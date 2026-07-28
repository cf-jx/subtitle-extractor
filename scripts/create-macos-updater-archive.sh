#!/usr/bin/env bash
set -euo pipefail

export LANG="en_US.UTF-8"
export LC_ALL="en_US.UTF-8"
umask 077

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TARGET="${1:-}"

fail() {
  echo "macOS updater archive creation failed: $*" >&2
  exit 1
}

case "$TARGET" in
  aarch64-apple-darwin|x86_64-apple-darwin)
    ;;
  *)
    fail "expected a macOS Rust target"
    ;;
esac

[[ "$(uname -s)" == "Darwin" ]] || fail "this script must run on macOS"

BUNDLE_ROOT="$PROJECT_ROOT/src-tauri/target/$TARGET/release/bundle"
APP_DIRECTORY="$BUNDLE_ROOT/macos"

shopt -s nullglob
APP_CANDIDATES=("$APP_DIRECTORY"/*.app)
shopt -u nullglob

[[ "${#APP_CANDIDATES[@]}" -eq 1 ]] ||
  fail "expected exactly one repaired app bundle"

APP_PATH="${APP_CANDIDATES[0]}"
UPDATER_PATH="${APP_PATH}.tar.gz"
TEMP_ARCHIVE="${UPDATER_PATH}.tmp"

codesign --verify --deep --strict --verbose=4 "$APP_PATH"
/usr/bin/tar -czf "$TEMP_ARCHIVE" -C "$APP_DIRECTORY" "$(basename "$APP_PATH")"
/bin/mv -f "$TEMP_ARCHIVE" "$UPDATER_PATH"

[[ -s "$UPDATER_PATH" ]] || fail "updater archive was not created"

printf 'Updater archive: %s\n' "$UPDATER_PATH"
printf 'Repaired app signature verification: passed\n'

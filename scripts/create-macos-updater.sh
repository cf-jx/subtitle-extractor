#!/usr/bin/env bash
set -euo pipefail

export LANG="en_US.UTF-8"
export LC_ALL="en_US.UTF-8"
umask 077

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TARGET="${1:-}"

fail() {
  echo "macOS updater creation failed: $*" >&2
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
[[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]] ||
  fail "TAURI_SIGNING_PRIVATE_KEY is required"

BUNDLE_ROOT="$PROJECT_ROOT/src-tauri/target/$TARGET/release/bundle"
APP_DIRECTORY="$BUNDLE_ROOT/macos"

cd "$PROJECT_ROOT"
bash scripts/create-macos-updater-archive.sh "$TARGET"

shopt -s nullglob
UPDATER_CANDIDATES=("$APP_DIRECTORY"/*.app.tar.gz)
shopt -u nullglob

[[ "${#UPDATER_CANDIDATES[@]}" -eq 1 ]] ||
  fail "expected exactly one updater archive"

UPDATER_PATH="${UPDATER_CANDIDATES[0]}"

/bin/rm -f "${UPDATER_PATH}.sig"

pnpm exec tauri signer sign "$UPDATER_PATH"

[[ -s "${UPDATER_PATH}.sig" ]] || fail "updater signature was not created"

printf 'Updater: %s\n' "$UPDATER_PATH"
printf 'Signature: %s\n' "${UPDATER_PATH}.sig"

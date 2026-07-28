#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAURI_CONFIG="$PROJECT_ROOT/src-tauri/tauri.conf.json"
VERIFIER_MANIFEST="$PROJECT_ROOT/tools/updater-signature-verifier/Cargo.toml"

fail() {
  echo "Updater signature verification failed: $*" >&2
  exit 1
}

[[ $# -eq 2 ]] ||
  fail "usage: scripts/verify-updater-signature.sh <artifact> <signature>"

ARTIFACT_PATH="$1"
SIGNATURE_PATH="$2"

[[ -s "$ARTIFACT_PATH" ]] || fail "artifact is missing or empty: $ARTIFACT_PATH"
[[ -s "$SIGNATURE_PATH" ]] || fail "signature is missing or empty: $SIGNATURE_PATH"
[[ -s "$TAURI_CONFIG" ]] || fail "Tauri configuration is missing"

ENCODED_PUBLIC_KEY="$(
  node - "$TAURI_CONFIG" <<'NODE'
const { readFileSync } = require('node:fs')

const [, , configPath] = process.argv
const config = JSON.parse(readFileSync(configPath, 'utf8'))
const encodedPublicKey = config?.plugins?.updater?.pubkey

if (typeof encodedPublicKey !== 'string' || encodedPublicKey.length === 0) {
  throw new Error('Updater public key is missing from the Tauri configuration')
}

process.stdout.write(encodedPublicKey)
NODE
)"

cargo run \
  --quiet \
  --locked \
  --manifest-path "$VERIFIER_MANIFEST" \
  -- \
  "$ENCODED_PUBLIC_KEY" \
  "$ARTIFACT_PATH" \
  "$SIGNATURE_PATH"

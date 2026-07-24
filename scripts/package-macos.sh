#!/usr/bin/env bash
set -euo pipefail

export LANG="en_US.UTF-8"
export LC_ALL="en_US.UTF-8"

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [[ "${1:-}" == "--" ]]; then
  shift
fi
TARGET="${1:-}"

case "$TARGET" in
  aarch64-apple-darwin|x86_64-apple-darwin)
    ;;
  *)
    echo "Usage: $0 <aarch64-apple-darwin|x86_64-apple-darwin>" >&2
    exit 2
    ;;
esac

[[ "$(uname -s)" == "Darwin" ]] || {
  echo "macOS packaging must run on macOS." >&2
  exit 1
}

cd "$PROJECT_ROOT"

node scripts/fetch-runtime.mjs --target "$TARGET"

for program in ffmpeg ffprobe yt-dlp; do
  runtime_path="$PROJECT_ROOT/src-tauri/binaries/$program-$TARGET"
  [[ -f "$runtime_path" ]] || {
    echo "Missing runtime: $runtime_path" >&2
    exit 1
  }
  [[ ! -L "$runtime_path" ]] || {
    echo "Runtime must not be a symbolic link: $runtime_path" >&2
    exit 1
  }
done

pnpm exec tauri build --target "$TARGET" --bundles app
bash scripts/repair-macos-app-signature.sh "$TARGET"
bash scripts/create-macos-dmg.sh "$TARGET"

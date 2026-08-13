#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
OUT="${1:-$ROOT/deepseek_responses_provider-v$VERSION.toolpkg}"
node --check "$ROOT/dist/main.js"
node -e "JSON.parse(require('fs').readFileSync('$ROOT/manifest.json','utf8'))"
[ "$(node -p "require('$ROOT/package.json').version")" = "$(node -p "require('$ROOT/manifest.json').version")" ]
rm -f "$OUT"
(cd "$ROOT" && zip -q "$OUT" dist/main.js manifest.json package.json)
unzip -l "$OUT"
printf 'Built %s\n' "$OUT"

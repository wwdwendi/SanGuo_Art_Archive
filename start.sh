#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$repo_root"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm was not found. Please install Node.js, then run this file again." >&2
  exit 1
fi

"$repo_root/scripts/start-stable-services.sh" --open-browser

echo
echo "SanGuo Costume Archive is starting:"
echo "http://127.0.0.1:5190/"
echo
echo "Logs are in: .archive-data/logs"

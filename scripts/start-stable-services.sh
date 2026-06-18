#!/usr/bin/env bash
set -euo pipefail

open_browser=false
if [[ "${1:-}" == "--open-browser" ]]; then
  open_browser=true
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
shared_root_file="$repo_root/.archive-data/shared-root.txt"
if [[ -z "${ARCHIVE_SHARED_DATA_ROOT:-}" && -f "$shared_root_file" ]]; then
  configured_shared_root="$(tr -d '\r' < "$shared_root_file" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [[ -n "$configured_shared_root" ]]; then
    export ARCHIVE_SHARED_DATA_ROOT="$configured_shared_root"
  fi
fi

archive_data_root="${ARCHIVE_SHARED_DATA_ROOT:-$repo_root/.archive-data}"
log_dir="$archive_data_root/logs"
svn_root_file="$repo_root/.archive-data/svn-root.txt"
mkdir -p "$log_dir"

if [[ -n "${ARCHIVE_SHARED_DATA_ROOT:-}" ]]; then
  echo "Archive shared data root: $ARCHIVE_SHARED_DATA_ROOT"
else
  echo "Warning: ARCHIVE_SHARED_DATA_ROOT is not configured. Records will stay local. Put the shared path in $shared_root_file or set the environment variable before starting." >&2
fi

if [[ -z "${SVN_WORKING_COPY_ROOT:-}" && -f "$svn_root_file" ]]; then
  configured_svn_root="$(tr -d '\r' < "$svn_root_file" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [[ -n "$configured_svn_root" ]]; then
    export SVN_WORKING_COPY_ROOT="$configured_svn_root"
  fi
fi

if [[ -n "${SVN_WORKING_COPY_ROOT:-}" ]]; then
  echo "SVN working copy root: $SVN_WORKING_COPY_ROOT"
else
  echo "Warning: SVN_WORKING_COPY_ROOT is not configured. Put the local SVN checkout path in $svn_root_file or set the environment variable before starting." >&2
fi

export VITE_APP_BASE="${VITE_APP_BASE:-/art_archive/}"
echo "Vite app base: $VITE_APP_BASE"

is_port_listening() {
  local port="$1"

  if command -v ss >/dev/null 2>&1; then
    ss -ltn "sport = :$port" | tail -n +2 | grep -q .
    return
  fi

  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
    return
  fi

  (echo >/dev/tcp/127.0.0.1/"$port") >/dev/null 2>&1
}

start_stable_process() {
  local name="$1"
  local port="$2"
  local command="$3"
  local log_file="$log_dir/$4"

  if is_port_listening "$port"; then
    echo "$name already listening on port $port"
    return
  fi

  (
    cd "$repo_root"
    nohup bash -lc "$command" >> "$log_file" 2>&1 &
    echo $! > "$log_file.pid"
  )

  local deadline=$((SECONDS + 20))
  while (( SECONDS < deadline )); do
    if is_port_listening "$port"; then
      echo "$name started on port $port"
      return
    fi
    sleep 0.5
  done

  echo "Warning: $name did not start on port $port within 20 seconds. Check $log_file" >&2
}

start_stable_process "Archive API" 8791 "npm run api" "archive-api.log"
start_stable_process "Vite app" 5190 "npm run dev:stable" "vite-5190.log"

if [[ "$open_browser" == true ]]; then
  if command -v wslview >/dev/null 2>&1; then
    wslview "http://127.0.0.1:5190/" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "http://127.0.0.1:5190/" >/dev/null 2>&1 || true
  fi
fi

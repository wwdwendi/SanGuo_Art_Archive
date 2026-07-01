#!/usr/bin/env bash
set -euo pipefail

open_browser=false
restart=false
for arg in "$@"; do
  case "$arg" in
    --open-browser) open_browser=true ;;
    --restart) restart=true ;;
  esac
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=scripts/load-node-env.sh
. "$repo_root/scripts/load-node-env.sh"

shared_root_file="$repo_root/.archive-data/shared-root.txt"
if [[ -z "${ARCHIVE_SHARED_DATA_ROOT:-}" && -f "$shared_root_file" ]]; then
  configured_shared_root="$(tr -d '\r' < "$shared_root_file" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [[ -n "$configured_shared_root" ]]; then
    export ARCHIVE_SHARED_DATA_ROOT="$configured_shared_root"
  fi
fi
if [[ -z "${ARCHIVE_SHARED_DATA_ROOT:-}" ]]; then
  for candidate_shared_root in \
    "/mnt/d/svnRepo/X28Ref/ArtArchive/data" \
    "/mnt/d/svnRepo/X28Ref/ArtArchive/.archive-data" \
    "$repo_root/../X28Ref/ArtArchive/data"
  do
    if [[ -d "$candidate_shared_root" ]]; then
      export ARCHIVE_SHARED_DATA_ROOT="$candidate_shared_root"
      break
    fi
  done
fi

archive_data_root="${ARCHIVE_SHARED_DATA_ROOT:-$repo_root/.archive-data}"
log_dir="$archive_data_root/logs"
svn_root_file="$repo_root/.archive-data/svn-root.txt"
mkdir -p "$log_dir"

paddle_python_file="$repo_root/.archive-data/paddle-ocr-python.txt"
if [[ -z "${PADDLE_OCR_PYTHON:-}" && -f "$paddle_python_file" ]]; then
  configured_paddle_python="$(tr -d '\r' < "$paddle_python_file" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [[ -n "$configured_paddle_python" && -x "$configured_paddle_python" ]]; then
    export PADDLE_OCR_PYTHON="$configured_paddle_python"
  fi
fi
if [[ -z "${PADDLE_OCR_PYTHON:-}" ]]; then
  for candidate_paddle_python in \
    "$repo_root/.archive-data/paddle-ocr-venv/bin/python" \
    "$archive_data_root/paddle-ocr-venv/bin/python"
  do
    if [[ -x "$candidate_paddle_python" ]]; then
      export PADDLE_OCR_PYTHON="$candidate_paddle_python"
      break
    fi
  done
fi

if [[ -n "${ARCHIVE_SHARED_DATA_ROOT:-}" ]]; then
  export ARCHIVE_REQUIRE_CENTER_API="${ARCHIVE_REQUIRE_CENTER_API:-true}"
  export ARCHIVE_REQUIRED_SHARED_DATA_ROOT="${ARCHIVE_REQUIRED_SHARED_DATA_ROOT:-$archive_data_root}"
  export ARCHIVE_REQUIRED_DATA_FILE="${ARCHIVE_REQUIRED_DATA_FILE:-$archive_data_root/archive-db.json}"
  export VITE_ARCHIVE_REQUIRE_CENTER_API="${VITE_ARCHIVE_REQUIRE_CENTER_API:-true}"
  export VITE_ARCHIVE_REQUIRED_SHARED_ROOT="${VITE_ARCHIVE_REQUIRED_SHARED_ROOT:-$archive_data_root}"
  export VITE_ARCHIVE_REQUIRED_DATA_FILE="${VITE_ARCHIVE_REQUIRED_DATA_FILE:-$archive_data_root/archive-db.json}"
fi

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
if [[ -n "${PADDLE_OCR_PYTHON:-}" ]]; then
  echo "PaddleOCR Python: $PADDLE_OCR_PYTHON"
else
  echo "Warning: PADDLE_OCR_PYTHON is not configured. OCR will try python/python3 from PATH." >&2
fi

export VITE_APP_BASE="${VITE_APP_BASE:-/art_archive/}"
echo "Vite app base: $VITE_APP_BASE"
vite_protocol="http"
if [[ -n "${ARCHIVE_VITE_HTTPS_CERT:-}${VITE_HTTPS_CERT:-}" && -n "${ARCHIVE_VITE_HTTPS_KEY:-}${VITE_HTTPS_KEY:-}" ]]; then
  vite_protocol="https"
fi
echo "Vite app protocol: $vite_protocol"

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

stop_listening_port() {
  local port="$1"

  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | xargs -r kill -TERM || true
    sleep 0.5
    lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | xargs -r kill -KILL || true
    return
  fi

  local pid_file
  for pid_file in "$log_dir"/*.log.pid; do
    [[ -f "$pid_file" ]] || continue
    if [[ -s "$pid_file" ]]; then
      kill -TERM "$(cat "$pid_file")" >/dev/null 2>&1 || true
    fi
  done
  sleep 0.5
}

start_stable_process() {
  local name="$1"
  local port="$2"
  local command="$3"
  local log_file="$log_dir/$4"

  if is_port_listening "$port"; then
    if [[ "$restart" == true ]]; then
      echo "Restarting $name on port $port"
      stop_listening_port "$port"
    else
      echo "$name already listening on port $port"
      return
    fi
  fi

  (
    cd "$repo_root"
    if command -v setsid >/dev/null 2>&1; then
      setsid bash -lc "$command" >> "$log_file" 2>&1 < /dev/null &
    else
      nohup bash -lc "$command" >> "$log_file" 2>&1 < /dev/null &
    fi
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

npm_bin="$(command -v npm)"
start_stable_process "Archive API" 8791 "\"$npm_bin\" run api" "archive-api.log"
rm -rf "$repo_root/node_modules/.vite"
start_stable_process "Vite app" 5190 "\"$npm_bin\" run dev:stable" "vite-5190.log"

if [[ "$open_browser" == true ]]; then
  if command -v wslview >/dev/null 2>&1; then
    wslview "$vite_protocol://127.0.0.1:5190/" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$vite_protocol://127.0.0.1:5190/" >/dev/null 2>&1 || true
  fi
fi

#!/usr/bin/env bash
set -euo pipefail

deploy_root="${ART_ARCHIVE_DEPLOY_ROOT:-/home/x28admin/workspace/X28_Art_Archive}"
branch="${ART_ARCHIVE_DEPLOY_BRANCH:-main}"
remote="${ART_ARCHIVE_DEPLOY_REMOTE:-origin}"

if [[ "${CI_RUNNER_EXECUTOR:-}" == "docker" || -f /.dockerenv ]]; then
  echo "Local deploy must run on a host shell runner, not inside Docker." >&2
  echo "Use the host runner tag: x28db-gitlab-runner" >&2
  exit 1
fi

if [[ ! -d "$deploy_root/.git" ]]; then
  echo "Deploy root is not a git repository: $deploy_root" >&2
  echo "This job must run on the machine that hosts the running service." >&2
  exit 1
fi

cd "$deploy_root"
repo_root="$deploy_root"

# shellcheck source=scripts/load-node-env.sh
. "$deploy_root/scripts/load-node-env.sh"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Deploy root has uncommitted changes; refusing to overwrite:" >&2
  git status --short >&2
  exit 1
fi

git fetch "$remote" "$branch"
target_ref="${CI_COMMIT_SHA:-$remote/$branch}"

current_branch="$(git branch --show-current)"
if [[ "$current_branch" != "$branch" ]]; then
  git checkout "$branch"
fi

git reset --hard "$target_ref"

npm ci --cache .npm --prefer-offline
npx playwright install chromium

setup_paddle_ocr_python() {
  local python_bin="${PADDLE_OCR_PYTHON:-}"
  if [[ -z "$python_bin" ]]; then
    if command -v python3 >/dev/null 2>&1; then
      python_bin="$(command -v python3)"
    elif command -v python >/dev/null 2>&1; then
      python_bin="$(command -v python)"
    else
      echo "Python was not found on the deploy host; PaddleOCR cannot run." >&2
      return 1
    fi
  fi

  if "$python_bin" -c "import paddleocr" >/dev/null 2>&1; then
    export PADDLE_OCR_PYTHON="$python_bin"
    echo "PaddleOCR Python: $PADDLE_OCR_PYTHON"
    return 0
  fi

  mkdir -p "$deploy_root/.archive-data"
  local venv_dir="$deploy_root/.archive-data/paddle-ocr-venv"
  "$python_bin" -m venv "$venv_dir"
  "$venv_dir/bin/python" -m pip install --upgrade pip
  "$venv_dir/bin/python" -m pip install paddlepaddle paddleocr
  "$venv_dir/bin/python" -c "import paddleocr"
  export PADDLE_OCR_PYTHON="$venv_dir/bin/python"
  echo "PaddleOCR Python: $PADDLE_OCR_PYTHON"
}

setup_paddle_ocr_python
VITE_APP_BASE="${VITE_APP_BASE:-/art_archive/}" npm run build

"$deploy_root/scripts/start-stable-services.sh" --restart

echo "Deployed $target_ref at $(git rev-parse --short HEAD)"

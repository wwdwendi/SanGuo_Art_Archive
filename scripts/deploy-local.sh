#!/usr/bin/env bash
set -euo pipefail

deploy_root="${ART_ARCHIVE_DEPLOY_ROOT:-/home/x28admin/workspace/X28_Art_Archive}"
branch="${ART_ARCHIVE_DEPLOY_BRANCH:-main}"
remote="${ART_ARCHIVE_DEPLOY_REMOTE:-origin}"

if [[ "${CI_RUNNER_EXECUTOR:-}" == "docker" || -f /.dockerenv ]]; then
  echo "Local deploy must run on a host shell runner, not inside Docker." >&2
  echo "Register a shell executor runner with tag: x28-art-archive-shell" >&2
  exit 1
fi

if [[ ! -d "$deploy_root/.git" ]]; then
  echo "Deploy root is not a git repository: $deploy_root" >&2
  echo "This job must run on the machine that hosts the running service." >&2
  exit 1
fi

cd "$deploy_root"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Deploy root has uncommitted changes; refusing to overwrite:" >&2
  git status --short >&2
  exit 1
fi

git fetch "$remote" "$branch"

current_branch="$(git branch --show-current)"
if [[ "$current_branch" != "$branch" ]]; then
  git checkout "$branch"
fi

git reset --hard "$remote/$branch"

npm ci --cache .npm --prefer-offline
VITE_APP_BASE="${VITE_APP_BASE:-/art_archive/}" npm run build

"$deploy_root/scripts/start-stable-services.sh" --restart

echo "Deployed $remote/$branch at $(git rev-parse --short HEAD)"

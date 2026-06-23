#!/usr/bin/env bash

if command -v npm >/dev/null 2>&1; then
  return 0
fi

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
  if [[ -f "${repo_root:-.}/.nvmrc" ]]; then
    nvm use --silent >/dev/null
  else
    nvm use --silent default >/dev/null 2>&1 || true
  fi
fi

if ! command -v npm >/dev/null 2>&1; then
  for node_bin in "$NVM_DIR"/versions/node/*/bin; do
    if [[ -x "$node_bin/npm" ]]; then
      export PATH="$node_bin:$PATH"
    fi
  done
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm was not found. Install Node.js or configure nvm for the gitlab-runner user." >&2
  return 1
fi

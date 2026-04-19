#!/usr/bin/env bash
set -euo pipefail

workspace_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for env_file in "$workspace_root/.env" "$workspace_root/.env.local"; do
  if [ -f "$env_file" ]; then
    set -a
    # Load shared defaults first, then local operator secrets.
    # shellcheck disable=SC1090
    . "$env_file"
    set +a
  fi
done

: "${COOLIFY_BASE_URL:=https://app.coolify.io}"
: "${COOLIFY_ACCESS_TOKEN:?COOLIFY_ACCESS_TOKEN must be set in .env.local or the environment}"

exec npx -y @masonator/coolify-mcp

#!/usr/bin/env bash
set -euo pipefail

workspace_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -f "$workspace_root/.env.local" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$workspace_root/.env.local"
  set +a
fi

: "${COOLIFY_BASE_URL:?COOLIFY_BASE_URL must be set in .env.local or the environment}"
: "${COOLIFY_ACCESS_TOKEN:?COOLIFY_ACCESS_TOKEN must be set in .env.local or the environment}"

exec npx -y @masonator/coolify-mcp

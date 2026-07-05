#!/bin/sh
#
# 10-create-app-role.sh — create the least-privilege application role.
#
# Runs once at PostgreSQL first-cluster-init (mounted into
# /docker-entrypoint-initdb.d/ by docker-compose.yml), as the POSTGRES
# superuser, BEFORE any migration. It creates the `awcms_mini_app` role the
# application connects as — a non-superuser, non-owner role for which FORCE'd
# RLS is actually enforced (a superuser/owner connection would bypass RLS, which
# was the original defense-in-depth gap; see sql/013).
#
# This script only creates the role and sets its LOGIN password (from
# AWCMS_MINI_APP_DB_PASSWORD). The table GRANTs, `FORCE ROW LEVEL SECURITY`, and
# the fail-closed default tenant GUC are applied by migration 013
# (`bun run db:migrate`), which runs afterwards as the superuser and is
# idempotent about the role already existing.
#
# Bun-only note (AGENTS.md rule 14): this is an OS-level Postgres init hook
# invoked by the postgres image's entrypoint, wrapping the `psql` client — the
# Bun-only rule governs application code/tooling, not standard ops scripts.
set -eu

if [ -z "${AWCMS_MINI_APP_DB_PASSWORD:-}" ]; then
  echo "10-create-app-role.sh: AWCMS_MINI_APP_DB_PASSWORD is not set — refusing to create the app role without a password." >&2
  exit 1
fi

# `:'approle_password'` binds and safely quotes the password (no SQL injection
# even if it contains special characters). The heredoc is single-quoted so the
# shell leaves the `$$` PL/pgSQL delimiters untouched.
psql -v ON_ERROR_STOP=1 \
  -v approle_password="$AWCMS_MINI_APP_DB_PASSWORD" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'awcms_mini_app') THEN
    CREATE ROLE awcms_mini_app LOGIN;
  END IF;
END
$$;
ALTER ROLE awcms_mini_app WITH LOGIN PASSWORD :'approle_password';
SQL

echo "10-create-app-role.sh: least-privilege role awcms_mini_app is ready."

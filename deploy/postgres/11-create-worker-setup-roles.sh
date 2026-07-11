#!/bin/sh
#
# 11-create-worker-setup-roles.sh — create the two LOGIN roles that back
# `WORKER_DATABASE_URL`/`SETUP_DATABASE_URL` (Issue #683, epic #679).
#
# Runs once at PostgreSQL first-cluster-init, right after
# 10-create-app-role.sh, as the POSTGRES superuser, BEFORE any migration.
# Mirrors that script's pattern exactly: LOGIN role, idempotent creation,
# password set separately from creation. The table GRANTs and the
# fail-closed default tenant GUC are applied by migration 045
# (`bun run db:migrate`), which runs afterwards as the superuser and is
# idempotent about the roles already existing (they're created there too, as
# NOLOGIN, for deployments that don't run this init script — e.g. a shared
# Postgres instance provisioned by other means. `ALTER ROLE ... WITH LOGIN
# PASSWORD` here upgrades them to LOGIN roles for the docker-compose flow).
#
# Both `AWCMS_MINI_WORKER_DB_PASSWORD`/`AWCMS_MINI_SETUP_DB_PASSWORD` are
# OPTIONAL — unlike the app role's password, which is required. Deployments
# that don't set `WORKER_DATABASE_URL`/`SETUP_DATABASE_URL` at all (see
# `src/lib/database/client.ts`'s fallback-to-`DATABASE_URL` behavior) don't
# need these roles to have LOGIN capability — the script skips creating a
# password (leaving the role NOLOGIN, as migration 045 creates it) when its
# password env var is unset, rather than failing the whole init like the app
# role does.
#
# Bun-only note (AGENTS.md rule 14): this is an OS-level Postgres init hook
# invoked by the postgres image's entrypoint, wrapping the `psql` client — the
# Bun-only rule governs application code/tooling, not standard ops scripts.
set -eu

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'awcms_mini_worker') THEN
    CREATE ROLE awcms_mini_worker NOLOGIN;
  END IF;
END
$$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'awcms_mini_setup') THEN
    CREATE ROLE awcms_mini_setup NOLOGIN;
  END IF;
END
$$;
SQL

if [ -n "${AWCMS_MINI_WORKER_DB_PASSWORD:-}" ]; then
  psql -v ON_ERROR_STOP=1 \
    -v worker_password="$AWCMS_MINI_WORKER_DB_PASSWORD" \
    --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
ALTER ROLE awcms_mini_worker WITH LOGIN PASSWORD :'worker_password';
SQL
  echo "11-create-worker-setup-roles.sh: awcms_mini_worker granted LOGIN."
else
  echo "11-create-worker-setup-roles.sh: AWCMS_MINI_WORKER_DB_PASSWORD not set — awcms_mini_worker stays NOLOGIN (WORKER_DATABASE_URL will fall back to DATABASE_URL)."
fi

if [ -n "${AWCMS_MINI_SETUP_DB_PASSWORD:-}" ]; then
  psql -v ON_ERROR_STOP=1 \
    -v setup_password="$AWCMS_MINI_SETUP_DB_PASSWORD" \
    --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
ALTER ROLE awcms_mini_setup WITH LOGIN PASSWORD :'setup_password';
SQL
  echo "11-create-worker-setup-roles.sh: awcms_mini_setup granted LOGIN."
else
  echo "11-create-worker-setup-roles.sh: AWCMS_MINI_SETUP_DB_PASSWORD not set — awcms_mini_setup stays NOLOGIN (SETUP_DATABASE_URL will fall back to DATABASE_URL)."
fi

echo "11-create-worker-setup-roles.sh: done."

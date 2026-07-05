#!/usr/bin/env bash
#
# restore-postgres.sh — PostgreSQL restore (Issue 12.2, doc 07 §"Restore SOP
# ringkas", skill `awcms-mini-production-preflight` §"Backup & restore").
#
# This is an OS-level shell script wrapping Postgres's own client binaries
# (`psql`, `pg_restore`). See the Bun-only note at the top of
# backup-postgres.sh — the same reasoning applies here.
#
# Usage:
#   DATABASE_URL=postgres://user:pass@host:5432/dbname \
#   ./deploy/backup/restore-postgres.sh <dump-file> [--target=<dbname>] [--yes]
#
# Safety model:
#   - By default (no --target), this NEVER touches the live database. It
#     restores into a disposable test database named
#     "awcms_mini_restore_test" (matching doc 07's own example), which this
#     script drops and recreates itself every run.
#   - Passing --target=<dbname> is an explicit override that lets the caller
#     point the restore at any other database (e.g. a real recovery
#     target). In override mode this script does NOT create/drop the
#     database itself (it must already exist) and requires interactive
#     confirmation (type the database name back) before running
#     `pg_restore --clean --if-exists`, which drops every object currently
#     in that database before recreating it from the dump. Pass --yes to
#     skip the interactive confirmation for non-interactive/automated use
#     — only do this once you are certain of the target.
#
# Environment:
#   DATABASE_URL  required. Used both to read connection parameters
#                 (host/port/user/password) and to identify the source
#                 database name (so this script can refuse to restore onto
#                 the same database the dump was taken from).

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: restore-postgres.sh <dump-file> [--target=<dbname>] [--yes]

  <dump-file>          Path to a custom-format pg_dump file
                        (e.g. produced by backup-postgres.sh).
  --target=<dbname>    Restore into an existing database instead of the
                        default disposable "awcms_mini_restore_test".
                        Never use this to point at a live/production
                        database unless you intend to overwrite it.
  --yes                Skip the interactive confirmation prompt required
                        when --target is used.

Environment:
  DATABASE_URL   required. Connection string providing host/port/user
                 and identifying the source database.
EOF
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

DUMP_FILE="$1"
shift

TARGET_DB=""
SKIP_CONFIRM=false

for arg in "$@"; do
  case "$arg" in
    --target=*)
      TARGET_DB="${arg#--target=}"
      ;;
    --yes)
      SKIP_CONFIRM=true
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "restore-postgres.sh: unknown option: ${arg}" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "restore-postgres.sh: DATABASE_URL is not set — refusing to run." >&2
  exit 1
fi

if [[ ! -f "$DUMP_FILE" ]]; then
  echo "restore-postgres.sh: dump file not found: ${DUMP_FILE}" >&2
  exit 1
fi

# --- Parse DATABASE_URL into (base_url without dbname) + source dbname + ---
# --- optional query string, so we can rebuild a connection URL pointing ---
# --- at a different database name while keeping host/port/user/pass.   ---
url="$DATABASE_URL"
query=""
if [[ "$url" == *\?* ]]; then
  query="?${url#*\?}"
  url="${url%%\?*}"
fi
base_url="${url%/*}"
source_db="${url##*/}"

DEFAULT_TARGET_DB="awcms_mini_restore_test"
override_mode=false

if [[ -n "$TARGET_DB" ]]; then
  override_mode=true
else
  TARGET_DB="$DEFAULT_TARGET_DB"
fi

if [[ "$TARGET_DB" == "$source_db" ]]; then
  echo "restore-postgres.sh: refusing to restore onto '${TARGET_DB}' — that is the same database DATABASE_URL points at (the live/source db). Use a different --target." >&2
  exit 1
fi

target_url="${base_url}/${TARGET_DB}${query}"

if [[ "$override_mode" == true ]]; then
  echo "restore-postgres.sh: WARNING — --target=${TARGET_DB} explicitly overrides the safe default (${DEFAULT_TARGET_DB})."
  echo "restore-postgres.sh: this database must already exist; it will NOT be created/dropped automatically."
  echo "restore-postgres.sh: pg_restore --clean --if-exists will DROP AND RECREATE every object currently in '${TARGET_DB}'."

  if [[ "$SKIP_CONFIRM" != true ]]; then
    read -r -p "Type the database name (${TARGET_DB}) to confirm: " confirmation
    if [[ "$confirmation" != "$TARGET_DB" ]]; then
      echo "restore-postgres.sh: confirmation did not match — aborting." >&2
      exit 1
    fi
  fi
else
  # Disposable test database — safe to drop/recreate every run. We use
  # `psql ... CREATE DATABASE` (equivalent to doc 07's `createdb` example)
  # because it reliably accepts the full DATABASE_URL connection string
  # (host/port/user/credentials); `createdb`'s positional argument is
  # documented as a plain database name, not a connection URI.
  echo "restore-postgres.sh: (re)creating disposable test database '${TARGET_DB}' ..."
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"${TARGET_DB}\";"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${TARGET_DB}\";"
fi

echo "restore-postgres.sh: restoring ${DUMP_FILE} into '${TARGET_DB}' ..."
pg_restore --dbname="$target_url" --clean --if-exists "$DUMP_FILE"

echo "restore-postgres.sh: done. Verify with, e.g.:"
echo "  psql \"${target_url}\" -c 'SELECT count(*) FROM awcms_mini_tenants;'"

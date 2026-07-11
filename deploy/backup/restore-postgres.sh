#!/usr/bin/env bash
#
# restore-postgres.sh — PostgreSQL restore (Issue 12.2; hardened by
# Issue #691, epic #679 platform-hardening: manifest verification before any
# mutation, credential-safe invocation, stronger target guard, lock). Doc 07
# §"Restore SOP ringkas", skill `awcms-mini-production-preflight` §"Backup &
# restore".
#
# This is an OS-level shell script wrapping Postgres's own client binaries
# (`psql`, `pg_restore`) plus `openssl`. See the Bun-only note at the top of
# backup-postgres.sh — the same reasoning applies here.
#
# Usage:
#   DATABASE_URL=postgres://user:pass@host:5432/dbname \
#   ./deploy/backup/restore-postgres.sh <dump.enc-file> \
#     [--target=<dbname>] [--acknowledge-target=<dbname>] [--yes]
#
# Safety model:
#   - By default (no --target), this NEVER touches the live database. It
#     restores into a disposable test database named
#     "awcms_mini_restore_test" (matching doc 07's own example), which this
#     script drops and recreates itself every run.
#   - Passing --target=<dbname> is an explicit override that lets the caller
#     point the restore at any other database (e.g. a real recovery
#     target). In override mode this script does NOT create/drop the
#     database itself (it must already exist), requires the database name to
#     be a plain identifier (no quote/semicolon/whitespace injection),
#     requires --acknowledge-target=<dbname> to match --target exactly (a
#     typo-catcher, mirroring scripts/production-preflight.ts's
#     --acknowledge-target=<APP_ENV> check), and requires interactive
#     confirmation (type the database name back) before running
#     `pg_restore --clean --if-exists`, which drops every object currently
#     in that database before recreating it from the dump. Pass --yes to
#     skip the interactive confirmation for non-interactive/automated use
#     (--acknowledge-target is still required) — only do this once you are
#     certain of the target.
#   - Before ANY of the above, this script verifies the backup itself: the
#     manifest's own HMAC signature (rejects a tampered/incomplete manifest
#     before even reading its claims), then the encrypted dump file's actual
#     sha256 against the manifest (rejects a tampered/incomplete dump file),
#     then decrypts to a private mktemp file (removed on exit) and runs
#     `pg_restore --list` against it to validate archive structure — all
#     BEFORE any target validation or mutation happens.
#
# Environment:
#   DATABASE_URL                required. Used both to read connection
#                               parameters (host/port/user/password) and to
#                               identify the source database name (so this
#                               script can refuse to restore onto the same
#                               database the dump was taken from). Parsed
#                               into PGHOST/PGPORT/PGUSER/PGPASSWORD/
#                               PGDATABASE — never passed as a positional
#                               argument to psql/pg_restore, so it never
#                               appears in `ps`/`/proc/<pid>/cmdline`.
#   BACKUP_ENCRYPTION_KEY_FILE  required. Must be the SAME key file used to
#                               produce the dump being restored.
#   BACKUP_HMAC_KEY_FILE        required. Must be the SAME key file used to
#                               sign the dump's manifest.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./backup-common.sh
source "$SCRIPT_DIR/backup-common.sh"

usage() {
  cat >&2 <<'EOF'
Usage: restore-postgres.sh <dump.enc-file> [--target=<dbname>] [--acknowledge-target=<dbname>] [--yes]

  <dump.enc-file>            Path to an encrypted, manifest-signed dump
                              produced by backup-postgres.sh. The manifest
                              is expected alongside it as
                              <name>.manifest.json (backup-postgres.sh's own
                              naming convention).
  --target=<dbname>          Restore into an existing database instead of
                              the default disposable "awcms_mini_restore_test".
                              Must be a plain identifier (letters/digits/
                              underscore, starting with a letter or
                              underscore, max 63 chars). Never use this to
                              point at a live/production database unless you
                              intend to overwrite it.
  --acknowledge-target=<dbname>
                              Required whenever --target is used; must equal
                              --target's value exactly. Typo-catcher, same
                              idea as scripts/production-preflight.ts's
                              --acknowledge-target=<APP_ENV>.
  --yes                       Skip the interactive confirmation prompt
                              required when --target is used (does NOT
                              remove the --acknowledge-target requirement).

Environment:
  DATABASE_URL                required. Connection string providing
                              host/port/user and identifying the source
                              database.
  BACKUP_ENCRYPTION_KEY_FILE  required. Path to the file with the key used
                              to encrypt the dump being restored.
  BACKUP_HMAC_KEY_FILE        required. Path to the file with the key used
                              to sign the dump's manifest.
EOF
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

DUMP_FILE="$1"
shift

TARGET_DB=""
ACKNOWLEDGE_TARGET=""
SKIP_CONFIRM=false

for arg in "$@"; do
  case "$arg" in
    --target=*)
      TARGET_DB="${arg#--target=}"
      ;;
    --acknowledge-target=*)
      ACKNOWLEDGE_TARGET="${arg#--acknowledge-target=}"
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

require_secret_file BACKUP_ENCRYPTION_KEY_FILE
require_secret_file BACKUP_HMAC_KEY_FILE

if [[ ! -f "$DUMP_FILE" ]]; then
  echo "restore-postgres.sh: dump file not found: ${DUMP_FILE}" >&2
  exit 1
fi

BACKUP_DIR_FOR_LOCK="$(cd "$(dirname "$DUMP_FILE")" && pwd)"
acquire_lock "${BACKUP_DIR_FOR_LOCK}/.awcms-mini-backup-restore.lock"

# ---------------------------------------------------------------------------
# Step (a): verify the manifest's own HMAC signature BEFORE trusting any of
# its claims (tampered/incomplete manifest -> refuse before touching the
# dump file's content at all).
# ---------------------------------------------------------------------------

MANIFEST_FILE="${DUMP_FILE%.dump.enc}.manifest.json"

if [[ ! -f "$MANIFEST_FILE" ]]; then
  echo "restore-postgres.sh: manifest not found: ${MANIFEST_FILE} — refusing to restore an unverifiable dump." >&2
  exit 1
fi

manifest_get() {
  local field="$1"
  grep -o "\"${field}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$MANIFEST_FILE" | head -n1 | sed -E 's/.*: *"([^"]*)"/\1/'
}

manifest_get_number() {
  local field="$1"
  grep -o "\"${field}\"[[:space:]]*:[[:space:]]*[0-9]*" "$MANIFEST_FILE" | head -n1 | sed -E 's/.*: *([0-9]*)/\1/'
}

manifest_file_field="$(manifest_get file)"
manifest_size_field="$(manifest_get_number size)"
manifest_sha256_field="$(manifest_get sha256)"
manifest_created_at_field="$(manifest_get created_at)"
manifest_hmac_field="$(manifest_get hmac_sha256)"

if [[ -z "$manifest_file_field" || -z "$manifest_size_field" || -z "$manifest_sha256_field" || -z "$manifest_created_at_field" || -z "$manifest_hmac_field" ]]; then
  echo "restore-postgres.sh: manifest ${MANIFEST_FILE} is missing required fields — refusing to restore." >&2
  exit 1
fi

expected_signature_input="${manifest_created_at_field}.${manifest_file_field}.${manifest_size_field}.${manifest_sha256_field}"
recomputed_hmac="$(hmac_sha256_string "$BACKUP_HMAC_KEY_FILE" "$expected_signature_input")"

if [[ "$recomputed_hmac" != "$manifest_hmac_field" ]]; then
  echo "restore-postgres.sh: manifest HMAC verification FAILED for ${MANIFEST_FILE} — the manifest does not match the HMAC key, or has been tampered with. Refusing to restore." >&2
  exit 1
fi

echo "restore-postgres.sh: manifest HMAC verified OK."

# ---------------------------------------------------------------------------
# Step (a continued): the manifest is now trusted — cross-check the dump
# file actually on disk against what the (now-verified) manifest claims,
# before decrypting anything (tampered/incomplete dump file -> refuse).
# ---------------------------------------------------------------------------

if [[ "$(basename "$DUMP_FILE")" != "$manifest_file_field" ]]; then
  echo "restore-postgres.sh: dump filename mismatch — manifest names '${manifest_file_field}', got '$(basename "$DUMP_FILE")'. Refusing to restore." >&2
  exit 1
fi

actual_size="$(stat -c%s "$DUMP_FILE")"
if [[ "$actual_size" != "$manifest_size_field" ]]; then
  echo "restore-postgres.sh: dump file size mismatch (incomplete/truncated backup?) — manifest says ${manifest_size_field} bytes, file is ${actual_size} bytes. Refusing to restore." >&2
  exit 1
fi

actual_sha256="$(sha256_file "$DUMP_FILE")"
if [[ "$actual_sha256" != "$manifest_sha256_field" ]]; then
  echo "restore-postgres.sh: dump file sha256 mismatch (tampered or corrupted backup) — refusing to restore." >&2
  exit 1
fi

echo "restore-postgres.sh: dump file integrity verified against manifest OK."

# ---------------------------------------------------------------------------
# Step (b)/(c): decrypt to a private temp file (removed on exit, regardless
# of success/failure), then validate archive structure with
# `pg_restore --list` — BEFORE any restore-target validation or mutation.
# AES-CBC has no built-in authentication, so a wrong key or corrupted
# ciphertext will not necessarily error on decrypt — `pg_restore --list`
# parsing the custom-format archive's own internal TOC/checksums is what
# actually proves decryption produced a structurally valid dump.
# ---------------------------------------------------------------------------

TMP_PLAIN_FILE="$(mktemp)"
cleanup() {
  rm -f "$TMP_PLAIN_FILE"
}
trap cleanup EXIT

echo "restore-postgres.sh: decrypting to a private temporary file ..."
if ! openssl enc -d -aes-256-cbc -pbkdf2 -pass file:"$BACKUP_ENCRYPTION_KEY_FILE" -in "$DUMP_FILE" -out "$TMP_PLAIN_FILE"; then
  echo "restore-postgres.sh: decryption failed (wrong BACKUP_ENCRYPTION_KEY_FILE, or corrupted dump). Refusing to restore." >&2
  exit 1
fi

echo "restore-postgres.sh: validating archive structure with pg_restore --list ..."
if ! pg_restore --list "$TMP_PLAIN_FILE" > /dev/null; then
  echo "restore-postgres.sh: decrypted file failed archive structure validation (wrong key, or corrupted dump). Refusing to restore." >&2
  exit 1
fi

echo "restore-postgres.sh: archive structure verified OK."

# ---------------------------------------------------------------------------
# Only now — after every verification step above has passed — parse the
# connection, validate the restore target, and (if all checks pass) mutate.
# ---------------------------------------------------------------------------

parse_database_url "$DATABASE_URL"
source_db="$PGDATABASE"

DEFAULT_TARGET_DB="awcms_mini_restore_test"
override_mode=false

if [[ -n "$TARGET_DB" ]]; then
  override_mode=true
else
  TARGET_DB="$DEFAULT_TARGET_DB"
fi

if ! validate_db_identifier "$TARGET_DB"; then
  echo "restore-postgres.sh: invalid --target value '${TARGET_DB}' — must be a plain identifier (letters/digits/underscore, starting with a letter or underscore, max 63 chars). Refusing to restore." >&2
  exit 1
fi

if [[ "$TARGET_DB" == "$source_db" ]]; then
  echo "restore-postgres.sh: refusing to restore onto '${TARGET_DB}' — that is the same database DATABASE_URL points at (the live/source db). Use a different --target." >&2
  exit 1
fi

if [[ "$override_mode" == true ]]; then
  echo "restore-postgres.sh: WARNING — --target=${TARGET_DB} explicitly overrides the safe default (${DEFAULT_TARGET_DB})."
  echo "restore-postgres.sh: this database must already exist; it will NOT be created/dropped automatically."
  echo "restore-postgres.sh: pg_restore --clean --if-exists will DROP AND RECREATE every object currently in '${TARGET_DB}'."

  if [[ -z "$ACKNOWLEDGE_TARGET" ]]; then
    echo "restore-postgres.sh: --target=${TARGET_DB} requires --acknowledge-target=${TARGET_DB} to confirm the operator knows which database is being overwritten. Refusing to restore." >&2
    exit 1
  fi
  if [[ "$ACKNOWLEDGE_TARGET" != "$TARGET_DB" ]]; then
    echo "restore-postgres.sh: --acknowledge-target=\"${ACKNOWLEDGE_TARGET}\" does not match --target=\"${TARGET_DB}\". Refusing to restore." >&2
    exit 1
  fi

  if [[ "$SKIP_CONFIRM" != true ]]; then
    read -r -p "Type the database name (${TARGET_DB}) to confirm: " confirmation
    if [[ "$confirmation" != "$TARGET_DB" ]]; then
      echo "restore-postgres.sh: confirmation did not match — aborting." >&2
      exit 1
    fi
  fi
else
  # Disposable test database — safe to drop/recreate every run. Connects
  # using the source db as the maintenance connection (PG* env vars from
  # parse_database_url above); DROP/CREATE DATABASE target a different name,
  # which Postgres allows from any third connection.
  echo "restore-postgres.sh: (re)creating disposable test database '${TARGET_DB}' ..."
  psql -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"${TARGET_DB}\";"
  psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${TARGET_DB}\";"
fi

echo "restore-postgres.sh: restoring into '${TARGET_DB}' ..."
pg_restore --dbname="$TARGET_DB" --clean --if-exists "$TMP_PLAIN_FILE"

unset PGPASSWORD

echo "restore-postgres.sh: done. Verify with, e.g.:"
echo "  PGDATABASE=${TARGET_DB} psql -c 'SELECT count(*) FROM awcms_mini_tenants;'"

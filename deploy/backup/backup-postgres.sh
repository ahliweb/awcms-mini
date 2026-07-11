#!/usr/bin/env bash
#
# backup-postgres.sh — PostgreSQL backup (Issue 12.2; hardened by Issue #691,
# epic #679 platform-hardening: encryption, signed manifest, credential-safe
# invocation, lock). Doc 07 §"Backup SOP ringkas", skill
# `awcms-mini-production-preflight` §"Backup & restore".
#
# This is an OS-level, cron-invoked shell script wrapping Postgres's own
# client binaries (`pg_dump`) plus `openssl` and coreutils. AGENTS.md rule 14
# ("Backend Bun-only") governs application code, scripts, tests, migration,
# build, and repository tooling — it does not apply to standard OS backup
# scripts that only orchestrate `pg_dump`/`openssl`/coreutils. There is no Bun
# equivalent of `pg_dump`'s custom-format dump, so this is not a Bun
# exception requiring the AGENTS.md rule-14 sign-off/audit-entry process
# either — it was never in Bun's scope to begin with.
#
# Usage (see deploy/backup/README.md for the full cron example):
#   DATABASE_URL=postgres://user:pass@host:5432/dbname \
#   BACKUP_DIR=/var/backups/awcms-mini \
#   BACKUP_ENCRYPTION_KEY_FILE=/etc/awcms-mini/backup-encryption.key \
#   BACKUP_HMAC_KEY_FILE=/etc/awcms-mini/backup-hmac.key \
#   BACKUP_RETENTION_DAYS=14 \
#   ./deploy/backup/backup-postgres.sh
#
# Environment:
#   DATABASE_URL               required. PostgreSQL connection string to
#                               dump. Parsed into PGHOST/PGPORT/PGUSER/
#                               PGPASSWORD/PGDATABASE — never passed as a
#                               positional argument to pg_dump, so it never
#                               appears in `ps`/`/proc/<pid>/cmdline`.
#   BACKUP_ENCRYPTION_KEY_FILE  required. Path to a file containing the
#                               symmetric key used to encrypt the dump
#                               (openssl enc -aes-256-cbc -pbkdf2). Not a CLI
#                               arg, not an env var holding the key content —
#                               a file path, so the key never sits in argv or
#                               in this process's own environment block.
#   BACKUP_HMAC_KEY_FILE        required. Path to a file containing a SEPARATE
#                               key (never reuse the encryption key) used to
#                               sign the backup manifest with HMAC-SHA256.
#   BACKUP_DIR                  optional. Default: /var/backups/awcms-mini
#   BACKUP_RETENTION_DAYS        optional. Default: 14. Dumps (and their
#                               manifests) older than this many days are
#                               deleted after a successful backup.
#
# Output per run: one AES-256-CBC encrypted custom-format dump
# (awcms_mini_<UTC timestamp>.dump.enc) — the plaintext dump is never
# written to disk, `pg_dump` streams directly into `openssl enc` via a pipe —
# plus a signed JSON manifest (awcms_mini_<UTC timestamp>.manifest.json)
# recording the encrypted file's name, size, sha256, an HMAC-SHA256 over
# those fields (see backup-common.sh), and the backup timestamp.
#
# See deploy/backup/README.md for key rotation, lost-key, off-site copy
# (deploy/backup/offsite-copy.sh), restore drill (deploy/backup/
# restore-drill.sh), and PITR-prerequisites documentation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./backup-common.sh
source "$SCRIPT_DIR/backup-common.sh"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "backup-postgres.sh: DATABASE_URL is not set — refusing to run." >&2
  exit 1
fi

require_secret_file BACKUP_ENCRYPTION_KEY_FILE
require_secret_file BACKUP_HMAC_KEY_FILE

BACKUP_DIR="${BACKUP_DIR:-/var/backups/awcms-mini}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"

acquire_lock "$BACKUP_DIR/.awcms-mini-backup-restore.lock"

parse_database_url "$DATABASE_URL"
unset DATABASE_URL

timestamp="$(date -u +%Y%m%d_%H%M%S)"
dump_file="${BACKUP_DIR}/awcms_mini_${timestamp}.dump.enc"
manifest_file="${BACKUP_DIR}/awcms_mini_${timestamp}.manifest.json"

echo "backup-postgres.sh: dumping database and encrypting to ${dump_file} ..."
# Plaintext never touches disk: pg_dump streams the custom-format dump
# directly into openssl enc via this pipe. `set -o pipefail` (part of
# `set -euo pipefail` above) makes a pg_dump failure fail this whole
# pipeline even though openssl (its consumer) exits 0 on the truncated
# input it receives.
pg_dump --format=custom \
  | openssl enc -aes-256-cbc -pbkdf2 -salt -pass file:"$BACKUP_ENCRYPTION_KEY_FILE" -out "$dump_file"

unset PGPASSWORD

dump_size="$(stat -c%s "$dump_file")"
dump_sha256="$(sha256_file "$dump_file")"
created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
dump_basename="$(basename "$dump_file")"

# HMAC over the manifest's own canonical fields (same
# `HMAC(secret, "<timestamp>.<body>")` shape as skill `awcms-mini-sync-hmac`),
# so restore-postgres.sh can detect a tampered manifest (e.g. someone editing
# the recorded sha256 to match a swapped-in malicious dump) before trusting
# anything it says.
signature_input="${created_at}.${dump_basename}.${dump_size}.${dump_sha256}"
manifest_hmac="$(hmac_sha256_string "$BACKUP_HMAC_KEY_FILE" "$signature_input")"

echo "backup-postgres.sh: writing signed manifest to ${manifest_file} ..."
cat > "$manifest_file" <<JSON
{
  "file": "${dump_basename}",
  "size": ${dump_size},
  "sha256": "${dump_sha256}",
  "created_at": "${created_at}",
  "hmac_sha256": "${manifest_hmac}"
}
JSON

dump_size_human="$(du -h "$dump_file" | cut -f1)"
echo "backup-postgres.sh: backup complete — ${dump_file} (${dump_size_human})."

echo "backup-postgres.sh: pruning dumps older than ${BACKUP_RETENTION_DAYS} day(s) in ${BACKUP_DIR} ..."
find "$BACKUP_DIR" -maxdepth 1 -name 'awcms_mini_*.dump.enc' -mtime "+${BACKUP_RETENTION_DAYS}" -print -delete
find "$BACKUP_DIR" -maxdepth 1 -name 'awcms_mini_*.manifest.json' -mtime "+${BACKUP_RETENTION_DAYS}" -print -delete

echo "backup-postgres.sh: done."

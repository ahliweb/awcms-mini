#!/usr/bin/env bash
#
# backup-postgres.sh — PostgreSQL backup (Issue 12.2, doc 07 §"Backup SOP
# ringkas", skill `awcms-mini-production-preflight` §"Backup & restore").
#
# This is an OS-level, cron-invoked shell script wrapping Postgres's own
# client binaries (`pg_dump`, `sha256sum`, `find`). AGENTS.md rule 14
# ("Backend Bun-only") governs application code, scripts, tests, migration,
# build, and repository tooling — it does not apply to standard OS backup
# scripts that only orchestrate `pg_dump`/coreutils. There is no Bun
# equivalent of `pg_dump`'s custom-format dump, so this is not a Bun
# exception requiring the AGENTS.md rule-14 sign-off/audit-entry process
# either — it was never in Bun's scope to begin with.
#
# Usage (see deploy/backup/README.md for the full cron example):
#   DATABASE_URL=postgres://user:pass@host:5432/dbname \
#   BACKUP_DIR=/var/backups/awcms-mini \
#   BACKUP_RETENTION_DAYS=14 \
#   ./deploy/backup/backup-postgres.sh
#
# Environment:
#   DATABASE_URL          required. PostgreSQL connection string to dump.
#   BACKUP_DIR             optional. Default: /var/backups/awcms-mini
#   BACKUP_RETENTION_DAYS  optional. Default: 14. Dumps (and their .sha256
#                          checksum files) older than this many days are
#                          deleted after a successful backup.
#
# Output: one custom-format dump file plus a sha256 checksum file alongside
# it, named awcms_mini_<UTC timestamp>.dump / .dump.sha256.

set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "backup-postgres.sh: DATABASE_URL is not set — refusing to run." >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-/var/backups/awcms-mini}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"

timestamp="$(date -u +%Y%m%d_%H%M%S)"
dump_file="${BACKUP_DIR}/awcms_mini_${timestamp}.dump"
checksum_file="${dump_file}.sha256"

echo "backup-postgres.sh: dumping database to ${dump_file} ..."
pg_dump --format=custom --file="${dump_file}" "$DATABASE_URL"

echo "backup-postgres.sh: writing checksum to ${checksum_file} ..."
# sha256sum prints "<hash>  <path>"; run from BACKUP_DIR so the recorded path
# is relative and the checksum file stays portable if the directory moves.
(cd "$BACKUP_DIR" && sha256sum "$(basename "$dump_file")" > "$(basename "$checksum_file")")

dump_size="$(du -h "$dump_file" | cut -f1)"
echo "backup-postgres.sh: backup complete — ${dump_file} (${dump_size})."

echo "backup-postgres.sh: pruning dumps older than ${BACKUP_RETENTION_DAYS} day(s) in ${BACKUP_DIR} ..."
find "$BACKUP_DIR" -maxdepth 1 -name 'awcms_mini_*.dump' -mtime "+${BACKUP_RETENTION_DAYS}" -print -delete
find "$BACKUP_DIR" -maxdepth 1 -name 'awcms_mini_*.dump.sha256' -mtime "+${BACKUP_RETENTION_DAYS}" -print -delete

echo "backup-postgres.sh: done."

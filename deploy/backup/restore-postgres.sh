#!/usr/bin/env bash
# Restore backup PostgreSQL AWCMS-Mini ke database target.
# Pemakaian: DATABASE_URL=postgres://... ./restore-postgres.sh <file.dump>
# PERINGATAN: --clean menimpa objek yang ada di database target.
set -euo pipefail

DATABASE_URL="${DATABASE_URL:?DATABASE_URL wajib di-set}"
DUMP_FILE="${1:?path file dump wajib diberikan}"

[ -f "${DUMP_FILE}" ] || { echo "File tidak ditemukan: ${DUMP_FILE}" >&2; exit 1; }

pg_restore --clean --if-exists --no-owner --dbname="${DATABASE_URL}" "${DUMP_FILE}"
echo "Restore selesai dari: ${DUMP_FILE}"
echo "Validasi: bun run db:migrate:status && bun run db:pool:health"

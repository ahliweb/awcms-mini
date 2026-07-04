#!/usr/bin/env bash
# Backup PostgreSQL AWCMS-Mini (custom format, timestamped).
# Pemakaian: DATABASE_URL=postgres://... ./backup-postgres.sh [dir-output]
set -euo pipefail

DATABASE_URL="${DATABASE_URL:?DATABASE_URL wajib di-set}"
OUTPUT_DIR="${1:-./backups}"
STAMP="$(date +%Y%m%d_%H%M%S)"
FILE="${OUTPUT_DIR}/awcms_mini_${STAMP}.dump"

mkdir -p "${OUTPUT_DIR}"
pg_dump --format=custom --no-owner --file="${FILE}" "${DATABASE_URL}"
echo "Backup selesai: ${FILE}"
echo "Ingat: uji restore berkala (deploy/backup/restore-postgres.sh) — gate G5 doc 07."

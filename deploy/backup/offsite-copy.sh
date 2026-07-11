#!/usr/bin/env bash
#
# offsite-copy.sh — generic off-site backup copy hook (Issue #691, epic #679
# platform-hardening). Doc 18's "3-2-1" backup guidance: 3 copies of data, on
# 2 different media, with 1 copy off-site. backup-postgres.sh already
# produces an encrypted local copy (media #1/#2, e.g. the backup host's disk
# plus whatever the host's own disk backup covers); this script is the
# generic "copy it off-site" step (copy #3) — it has NO built-in cloud/
# provider integration on purpose, so offline/LAN deployments (doc 18) can
# ignore it entirely and stay fully local.
#
# Same Bun-only exemption as backup-postgres.sh's header — this is an
# OS-level shell script, not application/runtime code.
#
# Usage (run after backup-postgres.sh, e.g. chained in the same cron line):
#   OFFSITE_COPY_COMMAND="rclone copy --config /etc/awcms-mini/rclone.conf -" \
#   ./deploy/backup/offsite-copy.sh /var/backups/awcms-mini/awcms_mini_<ts>.dump.enc \
#                                    /var/backups/awcms-mini/awcms_mini_<ts>.manifest.json
#
# Environment:
#   OFFSITE_COPY_COMMAND  optional. A shell command (with any flags/args you
#                         need already baked in); this script appends each
#                         file path as the final argument and runs it once
#                         per file, e.g. with
#                         OFFSITE_COPY_COMMAND="rclone copy --config /etc/rclone.conf - remote:awcms-backups"
#                         this runs (conceptually) `rclone copy ... <file>`.
#                         No specific provider (S3/R2/rsync/rclone/...) is
#                         hardcoded — bring whatever transfer tool your
#                         environment already trusts. If unset, this script
#                         is a documented no-op (exit 0): off-site copy is
#                         OPTIONAL, so offline/LAN deployments (doc 18) never
#                         fail their backup job over it.

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: offsite-copy.sh <file> [<file> ...]

Copies each given file off-site by invoking $OFFSITE_COPY_COMMAND once per
file, with the file path appended as the final argument. Typically called
with the encrypted dump and its manifest produced by backup-postgres.sh.

If OFFSITE_COPY_COMMAND is unset, this is a documented no-op (exit 0) — see
deploy/backup/README.md's "3-2-1" section.
EOF
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

if [[ "$1" == "-h" || "$1" == "--help" ]]; then
  usage
  exit 0
fi

if [[ -z "${OFFSITE_COPY_COMMAND:-}" ]]; then
  echo "offsite-copy.sh: OFFSITE_COPY_COMMAND is not set — off-site copy is optional and is being skipped (offline/LAN deployments can ignore this entirely)."
  exit 0
fi

for file in "$@"; do
  if [[ ! -f "$file" ]]; then
    echo "offsite-copy.sh: file not found: ${file}" >&2
    exit 1
  fi
  echo "offsite-copy.sh: copying ${file} off-site ..."
  # Intentionally unquoted: OFFSITE_COPY_COMMAND is a command (with its own
  # flags/args), not a single token — word-splitting is the point here.
  # shellcheck disable=SC2086
  $OFFSITE_COPY_COMMAND "$file"
done

echo "offsite-copy.sh: done."

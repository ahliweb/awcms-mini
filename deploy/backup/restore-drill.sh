#!/usr/bin/env bash
#
# restore-drill.sh — scheduled restore drill (Issue #691, epic #679
# platform-hardening). Doc 07 §"Restore SOP ringkas" says a backup that was
# never test-restored is not verified evidence; this script automates that
# proof on a schedule (cron/CI, separate from the daily backup job) instead
# of relying on an operator to remember to do it before go-live.
#
# Runs: backup-postgres.sh -> restore-postgres.sh (into a dedicated,
# reusable disposable database, NOT the live one and NOT the manual
# "awcms_mini_restore_test" db an operator might be using by hand) ->
# verifies the schema-migrations ledger, tenant isolation (RLS, via the
# actual least-privilege `awcms_mini_app` role if present — see below), and
# a representative sample record -> measures RTO (wall-clock duration of
# this whole drill, a proxy for how long a real recovery would take) and RPO
# (age of the backup used, a proxy for how much data a real recovery would
# lose) -> writes a timestamped report.
#
# The report's top-level "overall" field is tri-state, not a boolean
# pass/fail (PR #708 review): "pass" requires BOTH schema_migrations AND
# tenant_isolation to have actually run and come back "pass" — "fail" wins
# if either check explicitly failed — anything else (most commonly
# tenant_isolation coming back "skip", e.g. the awcms_mini_app role is
# missing or this backup doesn't have two tenants with cross-tenant data to
# test with) is reported as "incomplete", a third state distinct from both,
# so a report reader (operator or a monitoring/cron wrapper checking only a
# status string) can never mistake "the one check this drill exists to
# prove didn't actually run" for a verified pass. The script exits non-zero
# for both "fail" and "incomplete".
#
# Same Bun-only exemption as backup-postgres.sh's header — this is an
# OS-level shell script orchestrating the other two scripts, psql, and
# coreutils, not application/runtime code.
#
# Usage:
#   DATABASE_URL=postgres://user:pass@host:5432/dbname \
#   BACKUP_DIR=/var/backups/awcms-mini \
#   BACKUP_ENCRYPTION_KEY_FILE=/etc/awcms-mini/backup-encryption.key \
#   BACKUP_HMAC_KEY_FILE=/etc/awcms-mini/backup-hmac.key \
#   ./deploy/backup/restore-drill.sh
#
# Environment (in addition to backup-postgres.sh's / restore-postgres.sh's):
#   DRILL_TARGET_DB    optional. Default: awcms_mini_restore_drill. Created
#                       once if missing, then reused (contents replaced) on
#                       every drill run — deliberately separate from
#                       restore-postgres.sh's own manual-use default
#                       ("awcms_mini_restore_test") so a scheduled drill
#                       never collides with an operator's own manual restore
#                       test running at the same time (the shared lock in
#                       BACKUP_DIR still serializes the underlying
#                       backup/restore steps either way).
#   DRILL_REPORT_DIR   optional. Default: $BACKUP_DIR. Where the timestamped
#                       JSON report is written.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./backup-common.sh
source "$SCRIPT_DIR/backup-common.sh"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "restore-drill.sh: DATABASE_URL is not set — refusing to run." >&2
  exit 1
fi

require_secret_file BACKUP_ENCRYPTION_KEY_FILE
require_secret_file BACKUP_HMAC_KEY_FILE
assert_distinct_keys "$BACKUP_ENCRYPTION_KEY_FILE" "$BACKUP_HMAC_KEY_FILE"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/awcms-mini}"
DRILL_TARGET_DB="${DRILL_TARGET_DB:-awcms_mini_restore_drill}"
DRILL_REPORT_DIR="${DRILL_REPORT_DIR:-$BACKUP_DIR}"

# PR #708 review: unlike restore-postgres.sh's own --target (always run
# through validate_db_identifier before any SQL use), DRILL_TARGET_DB was
# previously interpolated straight into SQL run over the maintenance
# connection (normally the superuser role) below — validate it here too,
# mirroring restore-postgres.sh's pattern exactly, before it is used for
# anything.
if ! validate_db_identifier "$DRILL_TARGET_DB"; then
  echo "restore-drill.sh: invalid DRILL_TARGET_DB value '${DRILL_TARGET_DB}' — must be a plain identifier (letters/digits/underscore/hyphen, starting with a letter or underscore, max 63 chars). Refusing to run." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR" "$DRILL_REPORT_DIR"

# Own lock, distinct from the shared backup/restore lock those two scripts
# acquire and release independently as they run in sequence below — this
# one just stops two whole drills from overlapping.
acquire_lock "$BACKUP_DIR/.awcms-mini-drill.lock"

drill_started_epoch="$(date -u +%s)"
drill_started_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "restore-drill.sh: step 1/4 — running backup-postgres.sh ..."
"$SCRIPT_DIR/backup-postgres.sh"

latest_manifest="$(find "$BACKUP_DIR" -maxdepth 1 -name 'awcms_mini_*.manifest.json' -printf '%T@ %p\n' | sort -rn | head -n1 | cut -d' ' -f2-)"
if [[ -z "$latest_manifest" ]]; then
  echo "restore-drill.sh: no manifest found in ${BACKUP_DIR} after backup — cannot proceed." >&2
  exit 1
fi
latest_dump_enc="${latest_manifest%.manifest.json}.dump.enc"
backup_created_at="$(grep -o '"created_at"[[:space:]]*:[[:space:]]*"[^"]*"' "$latest_manifest" | head -n1 | sed -E 's/.*: *"([^"]*)"/\1/')"

echo "restore-drill.sh: step 2/4 — ensuring disposable drill database '${DRILL_TARGET_DB}' exists ..."
parse_database_url "$DATABASE_URL"
drill_db_exists="$(psql -tAc "SELECT 1 FROM pg_database WHERE datname = '${DRILL_TARGET_DB}'" || true)"
if [[ "$drill_db_exists" != "1" ]]; then
  psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${DRILL_TARGET_DB}\";"
fi
unset PGPASSWORD

echo "restore-drill.sh: step 3/4 — restoring latest backup into '${DRILL_TARGET_DB}' ..."
"$SCRIPT_DIR/restore-postgres.sh" "$latest_dump_enc" \
  --target="$DRILL_TARGET_DB" \
  --acknowledge-target="$DRILL_TARGET_DB" \
  --yes

echo "restore-drill.sh: step 4/4 — verifying restored data ..."
parse_database_url "$DATABASE_URL"
export PGDATABASE="$DRILL_TARGET_DB"

# --- Schema migrations ledger ------------------------------------------------
schema_migrations_status="fail"
schema_migrations_count="0"
schema_migrations_detail="awcms_mini_schema_migrations query failed"
if migrations_count="$(psql -tAc "SELECT count(*) FROM awcms_mini_schema_migrations" 2>/dev/null)"; then
  schema_migrations_count="$(echo "$migrations_count" | tr -d '[:space:]')"
  if [[ "$schema_migrations_count" =~ ^[0-9]+$ ]] && [[ "$schema_migrations_count" -gt 0 ]]; then
    schema_migrations_status="pass"
    schema_migrations_detail="${schema_migrations_count} migration(s) recorded in the restored ledger"
  else
    schema_migrations_detail="restored ledger has zero rows — schema migrations did not come back"
  fi
fi

# --- Sample record ------------------------------------------------------------
sample_record_status="warn"
sample_record_count="0"
sample_record_detail="no tenant rows in this backup to sample"
if tenants_count="$(psql -tAc "SELECT count(*) FROM awcms_mini_tenants" 2>/dev/null)"; then
  sample_record_count="$(echo "$tenants_count" | tr -d '[:space:]')"
  if [[ "$sample_record_count" =~ ^[0-9]+$ ]] && [[ "$sample_record_count" -gt 0 ]]; then
    sample_record_status="pass"
    sample_record_detail="${sample_record_count} tenant row(s) present, sampled awcms_mini_tenants successfully"
  fi
fi

# --- Tenant isolation (RLS), via the real awcms_mini_app role if available ---
tenant_isolation_status="skip"
tenant_isolation_detail="not enough distinct tenant/office data in this backup to test cross-tenant isolation"

tenant_ids_raw="$(psql -tAc "SELECT id FROM awcms_mini_tenants ORDER BY created_at LIMIT 5" 2>/dev/null || true)"
mapfile -t tenant_ids <<< "$tenant_ids_raw"

data_tenant=""
viewer_tenant=""
for candidate in "${tenant_ids[@]}"; do
  [[ -z "$candidate" ]] && continue
  office_count="$(psql -tAc "SELECT count(*) FROM awcms_mini_offices WHERE tenant_id = '${candidate}'" 2>/dev/null || echo 0)"
  office_count="$(echo "$office_count" | tr -d '[:space:]')"
  if [[ -z "$data_tenant" && "$office_count" =~ ^[0-9]+$ && "$office_count" -gt 0 ]]; then
    data_tenant="$candidate"
  elif [[ -z "$viewer_tenant" && "$candidate" != "$data_tenant" ]]; then
    viewer_tenant="$candidate"
  fi
done

if [[ -n "$data_tenant" && -n "$viewer_tenant" ]]; then
  # -q (quiet) is required here, not just -t/-A: without it psql still
  # prints a "SET" status line per SET statement (tuples-only only
  # suppresses SELECT's headers/row-count footer), which would corrupt this
  # single-value capture.
  leaked_count="$(psql -q -v ON_ERROR_STOP=1 -tA <<SQL 2>/dev/null || true
SET ROLE awcms_mini_app;
SET app.current_tenant_id = '${viewer_tenant}';
SELECT count(*) FROM awcms_mini_offices WHERE tenant_id = '${data_tenant}';
SQL
)"
  leaked_count="$(echo "$leaked_count" | tr -d '[:space:]')"

  if [[ ! "$leaked_count" =~ ^[0-9]+$ ]]; then
    tenant_isolation_status="skip"
    tenant_isolation_detail="could not SET ROLE awcms_mini_app in this database (role missing, or connecting role lacks privilege) — skipping RLS check"
  elif [[ "$leaked_count" == "0" ]]; then
    tenant_isolation_status="pass"
    tenant_isolation_detail="viewer tenant could not see another tenant's office rows (RLS enforced)"
  else
    tenant_isolation_status="fail"
    tenant_isolation_detail="viewer tenant saw ${leaked_count} office row(s) belonging to another tenant — RLS is NOT enforcing isolation"
  fi
fi

# --- Control plane (Issue #930 Wave 5) ----------------------------------------
# The drill previously proved the schema ledger, a sample tenant row, and RLS
# isolation on `awcms_mini_offices` — all base-platform. Nothing looked at the
# control plane at all, so a restore could report "pass" with every
# provisioning run, entitlement, invoice, payment envelope, and projection
# cursor missing. #930's Wave 5 asks for a rehearsal that covers control-plane
# tables, projections, and jobs; this is that coverage.
#
# Two different failures are distinguished, because they mean opposite things:
#
#   * A control-plane TABLE that is absent from the restored schema is always a
#     failure. It means the dump or the restore dropped part of the schema, and
#     that is true whether or not the deployment uses the control plane.
#   * Tables present but EMPTY is legitimate: a LAN/offline deployment never
#     enables the control plane, and every one of its modules is
#     default-disabled per tenant (ADR-0022 §7). That is a "skip", not a pass.
#
# Note the asymmetry with `tenant_isolation` below: a control_plane "skip" does
# NOT force the overall verdict to "incomplete", while a tenant_isolation
# "skip" does. That is deliberate rather than a loophole — RLS isolation is
# something EVERY deployment has and the drill exists to prove, so an unproven
# one is a gap; control-plane data is something most deployments legitimately
# do not have, and demanding it would make "incomplete" the normal result and
# train operators to ignore the verdict.
control_plane_status="skip"
control_plane_rows="0"
control_plane_detail="control-plane tables restored but empty — expected for a deployment that never enabled the control plane"

control_plane_tables=(
  awcms_mini_tenant_provisioning_requests
  awcms_mini_tenant_entitlement_assignments
  awcms_mini_subscription_billing_invoices
  awcms_mini_payment_gateway_webhook_inbox
  awcms_mini_control_plane_support_access_grants
  awcms_mini_reporting_projection_state
  awcms_mini_reporting_projection_cursors
)

missing_tables=()
control_plane_total=0
for cp_table in "${control_plane_tables[@]}"; do
  if ! exists="$(psql -tAc "SELECT to_regclass('public.${cp_table}') IS NOT NULL" 2>/dev/null)"; then
    missing_tables+=("$cp_table")
    continue
  fi
  if [[ "$(echo "$exists" | tr -d '[:space:]')" != "t" ]]; then
    missing_tables+=("$cp_table")
    continue
  fi
  cp_count="$(psql -tAc "SELECT count(*) FROM ${cp_table}" 2>/dev/null || echo 0)"
  cp_count="$(echo "$cp_count" | tr -d '[:space:]')"
  [[ "$cp_count" =~ ^[0-9]+$ ]] || cp_count=0
  control_plane_total=$(( control_plane_total + cp_count ))
done

control_plane_rows="$control_plane_total"

if [[ ${#missing_tables[@]} -gt 0 ]]; then
  control_plane_status="fail"
  control_plane_detail="control-plane table(s) absent from the restored schema: ${missing_tables[*]} — the dump or restore lost part of the schema"
elif [[ "$control_plane_total" -gt 0 ]]; then
  control_plane_status="pass"
  control_plane_detail="${control_plane_total} control-plane row(s) restored across provisioning, entitlement, billing, payment, support-access, and reporting projection state"
fi

unset PGPASSWORD

drill_finished_epoch="$(date -u +%s)"
drill_finished_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
duration_seconds="$(( drill_finished_epoch - drill_started_epoch ))"

backup_age_seconds="unknown"
if [[ -n "$backup_created_at" ]]; then
  if backup_created_epoch="$(date -u -d "$backup_created_at" +%s 2>/dev/null)"; then
    backup_age_seconds="$(( drill_finished_epoch - backup_created_epoch ))"
  fi
fi

# PR #708 review: "pass" must mean every check that can prove something
# meaningful actually ran and confirmed it — not merely "didn't fail". In
# particular tenant_isolation (the one check this drill exists to prove: RLS
# still enforces cross-tenant isolation post-restore) can legitimately come
# back "skip" (role missing, or fewer than two tenants with data in this
# backup) without that being a failure of the backup/restore machinery
# itself — but a report reader (operator, or a monitoring/cron wrapper that
# only checks a status string) must not be able to mistake a skipped check
# for a verified one. So "pass" requires schema_migrations AND
# tenant_isolation to BOTH be "pass" specifically; a "fail" on either wins
# outright; anything else (e.g. tenant_isolation "skip") is reported as
# "incomplete" — a third, distinct state that is neither a clean pass nor a
# hard failure, so it can't be silently treated as either.
if [[ "$schema_migrations_status" == "fail" || "$tenant_isolation_status" == "fail" || "$control_plane_status" == "fail" ]]; then
  overall="fail"
elif [[ "$schema_migrations_status" == "pass" && "$tenant_isolation_status" == "pass" ]]; then
  overall="pass"
else
  overall="incomplete"
fi

report_file="${DRILL_REPORT_DIR}/restore-drill-$(date -u +%Y%m%d_%H%M%S).json"
cat > "$report_file" <<JSON
{
  "drill_started_at": "${drill_started_iso}",
  "drill_finished_at": "${drill_finished_iso}",
  "duration_seconds": ${duration_seconds},
  "backup_file": "$(basename "$latest_dump_enc")",
  "backup_created_at": "${backup_created_at}",
  "backup_age_seconds": "${backup_age_seconds}",
  "target_database": "${DRILL_TARGET_DB}",
  "checks": {
    "schema_migrations": {
      "status": "${schema_migrations_status}",
      "count": ${schema_migrations_count},
      "detail": "${schema_migrations_detail}"
    },
    "sample_record": {
      "status": "${sample_record_status}",
      "count": ${sample_record_count},
      "detail": "${sample_record_detail}"
    },
    "tenant_isolation": {
      "status": "${tenant_isolation_status}",
      "detail": "${tenant_isolation_detail}"
    },
    "control_plane": {
      "status": "${control_plane_status}",
      "rows": ${control_plane_rows},
      "detail": "${control_plane_detail}"
    }
  },
  "overall": "${overall}"
}
JSON

echo "restore-drill.sh: report written to ${report_file}"
echo "restore-drill.sh: RTO proxy (duration) = ${duration_seconds}s, RPO proxy (backup age) = ${backup_age_seconds}s"
echo "restore-drill.sh: overall = ${overall}"

if [[ "$overall" != "pass" ]]; then
  exit 1
fi

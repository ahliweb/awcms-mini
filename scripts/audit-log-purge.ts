/**
 * audit-log-purge.ts — `bun run logs:audit:purge`.
 *
 * Issue #447 (M9 — activating the logging system: correlation ID
 * propagation, audit log retention/purge, observability extension points).
 * Internal worker entrypoint for `purgeExpiredAuditEvents`
 * (`src/modules/logging/application/audit-purge.ts`) — intended to be run
 * on a schedule (cron/systemd timer/k8s CronJob), the same pattern as
 * `scripts/object-sync-dispatch.ts` (Issue #436): not exposed over HTTP,
 * because `awcms_mini_audit_events` retention/purge is an administrative
 * operation, not something any tenant-scoped role should be able to trigger
 * over the API (doc 04 §Aturan implementasi — purge is for "retention/legal
 * hold yang memenuhi syarat", an operational decision, not a user action).
 *
 * Iterates every `active` tenant and drains its expired backlog in bounded
 * batches (`AUDIT_EVENT_PURGE_BATCH_LIMIT` rows per call), looping per
 * tenant until a batch purges nothing or `MAX_PASSES_PER_TENANT` is hit —
 * the same safety bound `object-sync-dispatch.ts` uses so one huge backlog
 * cannot make a single scheduled run run forever.
 *
 * Retention is configurable per run, in this priority order: `--retention-
 * days=<n>` CLI flag, then `AUDIT_LOG_RETENTION_DAYS` env var (doc 18), then
 * `AUDIT_EVENT_DEFAULT_RETENTION_DAYS` (730 days / 2 years).
 */
import { getDatabaseClient } from "../src/lib/database/client";
import {
  AUDIT_EVENT_DEFAULT_RETENTION_DAYS,
  purgeExpiredAuditEvents
} from "../src/modules/logging/application/audit-purge";

const MAX_PASSES_PER_TENANT = 50;

type TenantRow = { id: string };

function resolveRetentionDays(): number {
  const flag = process.argv.find((arg) => arg.startsWith("--retention-days="));

  if (flag) {
    const parsed = Number(flag.split("=")[1]);

    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  const envValue = process.env.AUDIT_LOG_RETENTION_DAYS;

  if (envValue) {
    const parsed = Number(envValue);

    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return AUDIT_EVENT_DEFAULT_RETENTION_DAYS;
}

async function main() {
  const sql = getDatabaseClient();
  const correlationId = crypto.randomUUID();
  const retentionDays = resolveRetentionDays();

  try {
    const tenants = (await sql`
      SELECT id FROM awcms_mini_tenants WHERE status = 'active'
    `) as TenantRow[];

    let totalPurged = 0;
    const now = new Date();
    let cutoffIso = "";

    for (const tenant of tenants) {
      for (let pass = 0; pass < MAX_PASSES_PER_TENANT; pass += 1) {
        const result = await purgeExpiredAuditEvents(sql, tenant.id, {
          retentionDays,
          now,
          correlationId
        });

        totalPurged += result.purgedCount;
        cutoffIso = result.cutoff.toISOString();

        if (result.purgedCount === 0) {
          break;
        }
      }
    }

    console.log(
      `logs:audit:purge complete — correlationId=${correlationId} ` +
        `retentionDays=${retentionDays} cutoff=${cutoffIso} ` +
        `tenants=${tenants.length} purged=${totalPurged}`
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`logs:audit:purge FAILED — ${detail}`);
    process.exitCode = 1;
  } finally {
    await sql.close({ timeout: 1 });
  }
}

if (import.meta.main) {
  await main();
}

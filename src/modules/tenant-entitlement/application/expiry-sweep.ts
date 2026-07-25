/**
 * Entitlement expiry sweep — the consumer for the
 * `control_plane_entitlement_expired_unswept` gauge (Issue #930, epic #868).
 *
 * Wave 1 of #930 shipped that gauge and an SLO on top of it. Nothing drained
 * the backlog it measured: no expiry sweep existed anywhere in the repo, so
 * the alert watched a queue with no consumer and could only climb. This is
 * that consumer.
 *
 * ## What this sweep does and does not change
 *
 * It records reality; it does not alter anyone's access. `domain/resolution.ts`'s
 * `assignmentActive()` already returns null once `now >= effectiveTo`, so an
 * expired assignment contributes no grants whether or not this has run. Moving
 * the row from `active` to `expired` takes it from "no grants (window closed)"
 * to "no grants (not active)" — the effective entitlement a tenant resolves is
 * identical before and after. The integration test pins that explicitly,
 * because a sweep that quietly changed someone's access would be a much worse
 * bug than the drift it exists to fix.
 *
 * What it fixes is bookkeeping: operator listings, commercial reporting, and
 * the entitlement projections all read `status`, so a fleet of `active` rows
 * whose windows closed months ago misstates what the platform is selling.
 *
 * ## Per-tenant by construction
 *
 * This function handles ONE tenant, inside that tenant's own RLS context. The
 * cross-tenant iteration lives in `scripts/tenant-entitlement-expiry-sweep.ts`,
 * the composition root — same split as the fleet observation sweep, and for
 * the same reason: a platform operator is not a soft super-tenant, and no
 * query here ever sees two tenants' rows at once (ADR-0022 §6b).
 *
 * ## Idempotent under concurrent workers
 *
 * Three independent reasons a second worker cannot double-process a row:
 * `runJob` holds a per-job-name advisory lock; the selection takes
 * `FOR UPDATE SKIP LOCKED` so overlapping transactions never contend on the
 * same rows; and the UPDATE re-asserts `status = 'active'` in its own
 * predicate, so a row another worker already closed simply is not matched.
 * Re-running the sweep with nothing left to do is a no-op that reports zero.
 */
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  TENANT_ENTITLEMENT_ASSIGNMENT_CHANGED_EVENT_TYPE,
  TENANT_ENTITLEMENT_EVENT_VERSION
} from "../../domain-event-runtime/domain/event-type-registry";
import { recordAuditEvent } from "../../logging/application/audit-log";

const MODULE_KEY = "tenant_entitlement";

/** Upper bound on rows closed per tenant per pass — the sweep is never unbounded. */
export const DEFAULT_EXPIRY_BATCH_LIMIT = 100;

export type TenantExpirySweepResult = {
  /** Rows whose window had closed and that this pass transitioned. */
  expired: number;
  /**
   * True when the batch limit was reached, i.e. more expirable rows may
   * remain for the next pass. Surfaced rather than looped-until-empty so one
   * pathological tenant can never monopolise a run.
   */
  truncated: boolean;
};

type ExpiredRow = {
  id: string;
  plan_key: string;
  offer_version: number;
  effective_to: Date;
};

/**
 * How many assignments in THIS tenant the sweep WOULD close out. Read-only, so
 * `--dry-run` can report real numbers without writing: the sweep itself is a
 * mutation, and a dry run that called it would defeat the point of the flag.
 *
 * The predicate is deliberately identical to the one in
 * `sweepExpiredAssignmentsForTenant`; if they ever diverge, the dry run stops
 * predicting the real run, which is the only thing it is for.
 */
export async function countExpirableAssignmentsForTenant(
  tx: Bun.SQL,
  tenantId: string,
  now: Date
): Promise<number> {
  const rows = (await tx`
    SELECT count(*)::int AS row_count
    FROM awcms_mini_tenant_entitlement_assignments
    WHERE tenant_id = ${tenantId}
      AND status = 'active'
      AND effective_to IS NOT NULL
      AND effective_to < ${now}
  `) as { row_count: number }[];

  return rows[0]?.row_count ?? 0;
}

/**
 * Close out every assignment in THIS tenant whose validity window has already
 * elapsed. Caller supplies a transaction already scoped to `tenantId`.
 */
export async function sweepExpiredAssignmentsForTenant(
  tx: Bun.SQL,
  tenantId: string,
  ctx: { now: Date; correlationId: string; batchLimit?: number }
): Promise<TenantExpirySweepResult> {
  const batchLimit = ctx.batchLimit ?? DEFAULT_EXPIRY_BATCH_LIMIT;

  // One statement, so the selection and the transition cannot drift apart.
  // `FOR UPDATE SKIP LOCKED` is paired with LIMIT deliberately — an unbounded
  // FOR UPDATE would lock the whole expirable set and serialise every worker
  // behind the slowest one.
  //
  // MATERIALIZED, and joined rather than `WHERE id IN (SELECT ... LIMIT n)`.
  // That subquery form does NOT bound the update: the planner is free to
  // choose a nested-loop semi-join with the LIMIT subquery on the inner side,
  // re-executing it once per candidate row, so every row matches its own
  // "top n" and the whole set is updated. Verified on this exact table —
  // `EXPLAIN` showed `Nested Loop Semi Join`, and a batch limit of 2 against 3
  // expirable rows updated all 3. The batch limit is a lock-footprint control,
  // so a silently unbounded version is not a cosmetic bug.
  //
  // The outer WHERE re-states `status = 'active'` rather than trusting the
  // CTE: between the CTE's snapshot and the update, another path (an operator
  // cancel, a supersede) may have moved the row, and this sweep must lose that
  // race rather than overwrite a human decision.
  const rows = (await tx`
    WITH picked AS MATERIALIZED (
      SELECT id
      FROM awcms_mini_tenant_entitlement_assignments
      WHERE tenant_id = ${tenantId}
        AND status = 'active'
        AND effective_to IS NOT NULL
        AND effective_to < ${ctx.now}
      ORDER BY effective_to ASC
      LIMIT ${batchLimit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE awcms_mini_tenant_entitlement_assignments AS a
    SET status = 'expired',
        expired_at = ${ctx.now},
        updated_at = now()
    FROM picked
    WHERE a.id = picked.id
      AND a.status = 'active'
    RETURNING a.id, a.plan_key, a.offer_version, a.effective_to
  `) as ExpiredRow[];

  for (const row of rows) {
    // Sequential, never Promise.all: these all run on the SAME transaction
    // handle, and one Postgres connection processes one query at a time.
    await appendDomainEvent(tx, tenantId, {
      eventType: TENANT_ENTITLEMENT_ASSIGNMENT_CHANGED_EVENT_TYPE,
      eventVersion: TENANT_ENTITLEMENT_EVENT_VERSION,
      aggregateType: "tenant_entitlement_assignment",
      aggregateId: row.id,
      producerModule: MODULE_KEY,
      correlationId: ctx.correlationId,
      actorTenantUserId: null,
      payload: {
        assignmentId: row.id,
        planKey: row.plan_key,
        offerVersion: row.offer_version,
        changeType: "expired",
        status: "expired"
      }
    });

    // `info`, not `warning`. An entitlement reaching the end of its own
    // validity window is the system working as designed — the commercial
    // decision was made when the window was set. Logging it at warning would
    // put routine expiries in the same bucket as suspensions and revocations,
    // which are the rows an auditor actually needs to find.
    await recordAuditEvent(tx, {
      tenantId,
      moduleKey: MODULE_KEY,
      action: "expire",
      resourceType: "tenant_entitlement_assignment",
      resourceId: row.id,
      severity: "info",
      message: `Entitlement "${row.plan_key}" v${row.offer_version} expired: validity window closed.`,
      attributes: {
        planKey: row.plan_key,
        offerVersion: row.offer_version,
        effectiveTo: row.effective_to.toISOString(),
        sweptBy: "tenant-entitlement:expiry-sweep"
      },
      correlationId: ctx.correlationId
    });
  }

  return { expired: rows.length, truncated: rows.length >= batchLimit };
}

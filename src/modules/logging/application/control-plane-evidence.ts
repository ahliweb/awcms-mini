/**
 * Operator evidence package for ONE tenant (Issue #930 Wave 5, epic #868).
 *
 * #930's acceptance criterion is three words long — "bounded, masked, and
 * audited" — and each one is a separate failure mode, so each is enforced
 * somewhere different:
 *
 *   * BOUNDED lives here (row caps per section, a clamped time window, and a
 *     `truncated` flag per section that is never silently omitted).
 *   * MASKED lives here too, and structurally: the row types below simply have
 *     no field capable of carrying a provider reference, envelope, token,
 *     secret, or email address. A future `SELECT *` cannot leak one into the
 *     response, because there is nowhere for it to land.
 *   * AUDITED lives at the route, which is also where authorization is
 *     re-checked — see `src/pages/api/v1/control-plane/tenants/[tenantId]/evidence.ts`.
 *
 * ## What this is FOR, and what it must never become
 *
 * An operator investigating "why is this tenant's control plane unhealthy?"
 * needs to see shape and timing: how many provisioning steps failed, whether
 * entitlements lapsed, whether invoices are stuck, whether webhooks are
 * backing up. None of that requires a single customer-identifying value, and
 * the moment it carries one this stops being an operational tool and becomes a
 * cross-tenant data-access channel with a support ticket for a warrant.
 *
 * So the rule is: COUNTS, STATUSES, and TIMESTAMPS. Plan keys and currency
 * codes are commercial vocabulary the operator already sells and are allowed.
 * Everything else — owner names, login identifiers, provider account
 * references, invoice numbers, webhook payloads — is excluded by construction
 * rather than by redaction, because redaction is a thing you can forget to
 * apply and a missing field is not.
 *
 * ## Cross-tenant shape
 *
 * This function handles ONE tenant and expects a transaction already scoped to
 * it. The operator authorizes in the PLATFORM tenant and reads inside the
 * TARGET tenant's own RLS context (ADR-0022 §6b — a platform operator is not a
 * soft super-tenant), which the route composes via `withTargetTenant`.
 */

/** Hard ceiling on how far back a single package may reach. */
export const EVIDENCE_MAX_WINDOW_DAYS = 90;

/** Hard ceiling on rows returned per section. */
export const EVIDENCE_SECTION_ROW_LIMIT = 100;

export type EvidenceWindow = {
  from: Date;
  to: Date;
  /** True when the requested window was wider than `EVIDENCE_MAX_WINDOW_DAYS` and was narrowed. */
  clamped: boolean;
};

/**
 * Resolve and CLAMP the requested window.
 *
 * Clamping is reported, never silent: an operator who asked for a year and
 * received 90 days must be able to tell that from a tenant that genuinely had
 * no activity before then. Those two look identical in the data and mean
 * opposite things.
 */
export function resolveEvidenceWindow(
  requestedFrom: Date | null,
  requestedTo: Date | null,
  now: Date
): EvidenceWindow {
  const to = requestedTo && requestedTo <= now ? requestedTo : now;
  const maxSpanMs = EVIDENCE_MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const earliestAllowed = new Date(to.getTime() - maxSpanMs);

  if (!requestedFrom || requestedFrom < earliestAllowed) {
    return { from: earliestAllowed, to, clamped: Boolean(requestedFrom) };
  }

  return { from: requestedFrom, to, clamped: false };
}

type CountByStatus = { status: string; count: number };

export type EvidenceSection<T> = {
  rows: T[];
  /** True when the section hit `EVIDENCE_SECTION_ROW_LIMIT`; more rows exist. */
  truncated: boolean;
};

export type ProvisioningStepEvidence = {
  stepKey: string;
  status: string;
  attempts: number;
  lastErrorClass: string | null;
  updatedAt: string;
};

export type EntitlementEvidence = {
  planKey: string;
  offerVersion: number;
  status: string;
  effectiveFrom: string;
  effectiveTo: string | null;
};

export type ControlPlaneEvidencePackage = {
  tenantId: string;
  window: { fromIso: string; toIso: string; clamped: boolean };
  limits: { maxWindowDays: number; sectionRowLimit: number };
  provisioning: {
    requestStatus: string | null;
    readinessState: string | null;
    lastReconciledAt: string | null;
    steps: EvidenceSection<ProvisioningStepEvidence>;
  };
  entitlements: EvidenceSection<EntitlementEvidence>;
  billing: { invoicesByStatus: CountByStatus[] };
  payments: {
    outboxByStatus: CountByStatus[];
    webhookInboxByStatus: CountByStatus[];
  };
  supportAccess: { grantsByStatus: CountByStatus[] };
};

async function countByStatus(
  tx: Bun.SQL,
  tenantId: string,
  table: string,
  timestampColumn: string,
  window: EvidenceWindow
): Promise<CountByStatus[]> {
  // `tx.unsafe` with the table/column interpolated is safe ONLY because both
  // come from the literal call sites below — never from a request. The values
  // that DO come from the request (tenant, window) stay bound parameters.
  const rows = (await tx.unsafe(
    `SELECT status, count(*)::int AS count
     FROM ${table}
     WHERE tenant_id = $1 AND ${timestampColumn} >= $2 AND ${timestampColumn} <= $3
     GROUP BY status
     ORDER BY status ASC`,
    [tenantId, window.from, window.to]
  )) as CountByStatus[];
  return rows;
}

/**
 * Collect one tenant's control-plane evidence. `tx` must already be scoped to
 * `tenantId`.
 *
 * Every query is sequential rather than `Promise.all`: they all run on the
 * SAME transaction handle, and one Postgres connection processes one query at
 * a time — concurrency here has produced a real hang in this repo.
 */
export async function collectControlPlaneEvidence(
  tx: Bun.SQL,
  tenantId: string,
  window: EvidenceWindow
): Promise<ControlPlaneEvidencePackage> {
  const requestRows = (await tx`
    SELECT status, readiness_state, last_reconciled_at
    FROM awcms_mini_tenant_provisioning_requests
    WHERE tenant_id = ${tenantId}
    ORDER BY created_at DESC
    LIMIT 1
  `) as {
    status: string;
    readiness_state: string | null;
    last_reconciled_at: Date | null;
  }[];

  // LIMIT + 1 so "there is more" is observed rather than inferred: asking for
  // exactly the limit cannot distinguish "exactly full" from "overflowing".
  const stepRows = (await tx`
    SELECT step_key, status, attempt_count, last_error_class, updated_at
    FROM awcms_mini_tenant_provisioning_steps
    WHERE tenant_id = ${tenantId}
      AND updated_at >= ${window.from}
      AND updated_at <= ${window.to}
    ORDER BY updated_at DESC
    LIMIT ${EVIDENCE_SECTION_ROW_LIMIT + 1}
  `) as {
    step_key: string;
    status: string;
    attempt_count: number;
    last_error_class: string | null;
    updated_at: Date;
  }[];

  const entitlementRows = (await tx`
    SELECT plan_key, offer_version, status, effective_from, effective_to
    FROM awcms_mini_tenant_entitlement_assignments
    WHERE tenant_id = ${tenantId}
      AND effective_from <= ${window.to}
      AND (effective_to IS NULL OR effective_to >= ${window.from})
    ORDER BY effective_from DESC
    LIMIT ${EVIDENCE_SECTION_ROW_LIMIT + 1}
  `) as {
    plan_key: string;
    offer_version: number;
    status: string;
    effective_from: Date;
    effective_to: Date | null;
  }[];

  const invoicesByStatus = await countByStatus(
    tx,
    tenantId,
    "awcms_mini_subscription_billing_invoices",
    "created_at",
    window
  );
  const outboxByStatus = await countByStatus(
    tx,
    tenantId,
    "awcms_mini_payment_gateway_outbox",
    "created_at",
    window
  );
  const webhookInboxByStatus = await countByStatus(
    tx,
    tenantId,
    "awcms_mini_payment_gateway_webhook_inbox",
    "received_at",
    window
  );
  const grantsByStatus = await countByStatus(
    tx,
    tenantId,
    "awcms_mini_control_plane_support_access_grants",
    "created_at",
    window
  );

  return {
    tenantId,
    window: {
      fromIso: window.from.toISOString(),
      toIso: window.to.toISOString(),
      clamped: window.clamped
    },
    limits: {
      maxWindowDays: EVIDENCE_MAX_WINDOW_DAYS,
      sectionRowLimit: EVIDENCE_SECTION_ROW_LIMIT
    },
    provisioning: {
      requestStatus: requestRows[0]?.status ?? null,
      readinessState: requestRows[0]?.readiness_state ?? null,
      lastReconciledAt:
        requestRows[0]?.last_reconciled_at?.toISOString() ?? null,
      steps: {
        rows: stepRows.slice(0, EVIDENCE_SECTION_ROW_LIMIT).map((row) => ({
          stepKey: row.step_key,
          status: row.status,
          attempts: row.attempt_count,
          // The error CLASS only. `last_error_message` sits in the very next
          // column and is deliberately NOT selected: it is free text a
          // provider or a step handler wrote, and free text is where
          // identifiers end up. The class is a bounded enum the module already
          // treats as safe telemetry.
          lastErrorClass: row.last_error_class,
          updatedAt: row.updated_at.toISOString()
        })),
        truncated: stepRows.length > EVIDENCE_SECTION_ROW_LIMIT
      }
    },
    entitlements: {
      rows: entitlementRows.slice(0, EVIDENCE_SECTION_ROW_LIMIT).map((row) => ({
        planKey: row.plan_key,
        offerVersion: row.offer_version,
        status: row.status,
        effectiveFrom: row.effective_from.toISOString(),
        effectiveTo: row.effective_to?.toISOString() ?? null
      })),
      truncated: entitlementRows.length > EVIDENCE_SECTION_ROW_LIMIT
    },
    billing: { invoicesByStatus },
    payments: { outboxByStatus, webhookInboxByStatus },
    supportAccess: { grantsByStatus }
  };
}

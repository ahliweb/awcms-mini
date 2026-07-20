/**
 * `subscription_billing` dunning (Issue #876, epic #868). A dunning attempt for
 * a past-due invoice REQUESTS a tenant lifecycle transition through the #873
 * `lifecycle_transition` port — billing NEVER writes `tenant_lifecycle` state
 * directly and never bypasses #873 policy (AC). FAIL-CLOSED (lesson #873): an
 * ERROR or a non-ok result from the port is treated as NOT APPLIED (`refused`/
 * `not_available`) — the attempt is recorded honestly and billing does not
 * assume the transition happened. Runs inside the caller's tenant-scoped `tx`.
 *
 * CAVEAT on "recorded honestly": a port that throws an ordinary in-process error
 * is caught here, so the attempt row IS persisted as `refused`. But if the port
 * throws a *database* error (e.g. it touched an aborted connection), PostgreSQL
 * marks the whole transaction as failed and the subsequent `insertDunningAttempt`
 * cannot commit — the attempt is then NOT persisted. That is still fail-closed:
 * no lifecycle change was asserted and nothing partial is written; the caller's
 * `tx` simply rolls back and the dunning pass retries the invoice next run.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  SUBSCRIPTION_BILLING_DUNNING_ATTEMPTED_EVENT_TYPE,
  SUBSCRIPTION_BILLING_EVENT_VERSION
} from "../../domain-event-runtime/domain/event-type-registry";
import { log } from "../../../lib/logging/logger";
import type {
  LifecycleTransitionPort,
  LifecycleState
} from "../../_shared/ports/tenant-lifecycle-port";
import {
  insertDunningAttempt,
  loadInvoiceForUpdate,
  nextDunningAttemptNo
} from "./billing-directory";
import type { ActionContext } from "./subscription-engine";

const MODULE_KEY = "subscription_billing";
const AGGREGATE_TYPE = "subscription_billing_invoice";

export type DunningEngineDeps = {
  /**
   * Optional #873 `lifecycle_transition` write port. Absent (LAN/offline, or
   * lifecycle not enabled) -> the attempt is recorded as `not_available` and NO
   * lifecycle change is asserted (billing never bypasses #873).
   */
  lifecycle?: LifecycleTransitionPort;
};

export type DunningOutcome =
  "requested" | "applied" | "refused" | "not_available";

export type DunningResult =
  | {
      ok: true;
      attemptId: string | null;
      attemptNo: number;
      requestedLifecycleState: LifecycleState;
      lifecycleOutcome: DunningOutcome;
    }
  | { ok: false; reason: "not_found" | "invalid_state"; message: string };

export async function runDunningAttempt(
  tx: Bun.SQL,
  tenantId: string,
  invoiceId: string,
  command: {
    requestedLifecycleState: LifecycleState;
    reason: string;
    expectedVersion?: number | null;
  },
  deps: DunningEngineDeps,
  ctx: ActionContext,
  now: Date = new Date()
): Promise<DunningResult> {
  const invoice = await loadInvoiceForUpdate(tx, tenantId, invoiceId);
  if (!invoice)
    return { ok: false, reason: "not_found", message: "Invoice not found." };
  const outstanding =
    Number(invoice.total_minor) -
    Number(invoice.credited_minor) -
    Number(invoice.allocated_minor);
  if (invoice.status !== "issued" || outstanding <= 0) {
    return {
      ok: false,
      reason: "invalid_state",
      message: `Dunning applies only to an issued, outstanding invoice (status ${invoice.status}, outstanding ${outstanding}).`
    };
  }

  const attemptNo = await nextDunningAttemptNo(tx, tenantId, invoiceId);

  // Request the lifecycle transition through #873 — fail-closed on any error /
  // non-ok result (never assume the transition applied).
  let lifecycleOutcome: DunningOutcome = "not_available";
  if (deps.lifecycle) {
    try {
      const result = await deps.lifecycle.requestTransition({
        toState: command.requestedLifecycleState,
        reason: `dunning attempt ${attemptNo} for invoice ${invoiceId}: ${command.reason}`,
        source: "billing",
        actorTenantUserId: ctx.actorTenantUserId,
        correlationId: ctx.correlationId
      });
      lifecycleOutcome = result.ok ? "applied" : "refused";
    } catch (error) {
      // Indeterminate -> treated as NOT applied (safe). Never swallow into a
      // false "applied" (lesson #873 fail-closed).
      log("warning", "subscription_billing: dunning lifecycle request failed", {
        invoiceId,
        error: error instanceof Error ? error.message : "unknown"
      });
      lifecycleOutcome = "refused";
    }
  }

  const attempt = await insertDunningAttempt(tx, {
    tenantId,
    invoiceId,
    subscriptionId: invoice.subscription_id,
    attemptNo,
    scheduledAt: now.toISOString(),
    state: "executed",
    requestedLifecycleState: command.requestedLifecycleState,
    lifecycleOutcome,
    reason: command.reason,
    correlationId: ctx.correlationId ?? null,
    executedAt: now.toISOString(),
    actor: ctx.actorTenantUserId
  });

  await appendDomainEvent(tx, tenantId, {
    eventType: SUBSCRIPTION_BILLING_DUNNING_ATTEMPTED_EVENT_TYPE,
    eventVersion: SUBSCRIPTION_BILLING_EVENT_VERSION,
    aggregateType: AGGREGATE_TYPE,
    aggregateId: invoiceId,
    aggregateVersion: Number(invoice.version),
    producerModule: MODULE_KEY,
    correlationId: ctx.correlationId,
    actorTenantUserId: ctx.actorTenantUserId,
    payload: {
      attemptId: attempt?.id ?? null,
      invoiceId,
      subscriptionId: invoice.subscription_id,
      attemptNo,
      requestedLifecycleState: command.requestedLifecycleState,
      lifecycleOutcome
    }
  });
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId: ctx.actorTenantUserId ?? undefined,
    moduleKey: MODULE_KEY,
    action: "update",
    resourceType: "subscription_billing_dunning_attempt",
    resourceId: attempt?.id ?? invoiceId,
    severity: "warning",
    message: `Dunning attempt ${attemptNo} requested lifecycle "${command.requestedLifecycleState}" (${lifecycleOutcome}): ${command.reason}`,
    attributes: {
      invoiceId,
      attemptNo,
      requestedLifecycleState: command.requestedLifecycleState,
      lifecycleOutcome
    },
    correlationId: ctx.correlationId
  });

  return {
    ok: true,
    attemptId: attempt?.id ?? null,
    attemptNo,
    requestedLifecycleState: command.requestedLifecycleState,
    lifecycleOutcome
  };
}

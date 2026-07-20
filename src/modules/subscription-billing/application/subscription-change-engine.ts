/**
 * `subscription_billing` upgrade/downgrade/cancel scheduling + application
 * (Issue #876, epic #868). Scheduling is DETERMINISTIC and PRESERVES old period
 * evidence (AC): a change never rewrites or deletes the current subscription's
 * offer binding or its billing periods — it records a scheduled change and, on
 * apply, an upgrade/downgrade creates a NEW subscription bound to the target
 * immutable offer and cancels the old one (all history retained). A prior
 * pending change is superseded (never silently overwritten). Runs inside the
 * caller's already tenant-scoped `tx`.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  SUBSCRIPTION_BILLING_EVENT_VERSION,
  SUBSCRIPTION_BILLING_SUBSCRIPTION_CHANGED_EVENT_TYPE
} from "../../domain-event-runtime/domain/event-type-registry";
import type { ServiceCatalogReadPort } from "../../_shared/ports/service-catalog-read-port";
import {
  insertSubscriptionChange,
  loadSubscriptionForUpdate,
  supersedeScheduledChanges,
  type SubscriptionRow
} from "./billing-directory";
import type { ActionContext } from "./subscription-engine";

const MODULE_KEY = "subscription_billing";
const AGGREGATE_TYPE = "subscription_billing_subscription";

export type ChangeEngineDeps = {
  catalog: ServiceCatalogReadPort;
};

export type ScheduleChangeResult =
  | { ok: true; changeId: string }
  | {
      ok: false;
      reason: "not_found" | "offer_not_found" | "invalid_state" | "validation";
      message: string;
    };

export async function scheduleSubscriptionChange(
  tx: Bun.SQL,
  tenantId: string,
  subscriptionId: string,
  command: {
    changeType: "upgrade" | "downgrade" | "cancel";
    toOfferPlanKey: string | null;
    toOfferVersion: number | null;
    prorationPolicy: string;
    effectiveAt: string;
    reason: string;
  },
  deps: ChangeEngineDeps,
  ctx: ActionContext
): Promise<ScheduleChangeResult> {
  const sub = await loadSubscriptionForUpdate(tx, tenantId, subscriptionId);
  if (!sub)
    return {
      ok: false,
      reason: "not_found",
      message: "Subscription not found."
    };
  if (sub.state === "canceled" || sub.state === "expired") {
    return {
      ok: false,
      reason: "invalid_state",
      message: `Subscription in state "${sub.state}" cannot be changed.`
    };
  }

  // Validate the target offer for upgrade/downgrade (immutable published offer).
  if (command.changeType !== "cancel") {
    if (command.toOfferPlanKey === null || command.toOfferVersion === null) {
      return {
        ok: false,
        reason: "validation",
        message: "target offer required."
      };
    }
    const offer = await deps.catalog.getPublishedOffer(
      command.toOfferPlanKey,
      command.toOfferVersion
    );
    if (!offer) {
      return {
        ok: false,
        reason: "offer_not_found",
        message: `Published offer ${command.toOfferPlanKey}@v${command.toOfferVersion} not found.`
      };
    }
    if (offer.currency !== sub.currency) {
      return {
        ok: false,
        reason: "validation",
        message: `Target offer currency ${offer.currency} != subscription currency ${sub.currency}.`
      };
    }
  }

  // Supersede any prior pending change (never silently overwrite).
  await supersedeScheduledChanges(tx, tenantId, subscriptionId);

  const change = await insertSubscriptionChange(tx, {
    tenantId,
    subscriptionId,
    changeType: command.changeType,
    fromOfferPlanKey: sub.offer_plan_key,
    fromOfferVersion: Number(sub.offer_version),
    toOfferPlanKey: command.toOfferPlanKey,
    toOfferVersion: command.toOfferVersion,
    prorationPolicy: command.prorationPolicy,
    effectiveAt: command.effectiveAt,
    reason: command.reason,
    correlationId: ctx.correlationId ?? null,
    actor: ctx.actorTenantUserId
  });

  await emitChanged(
    tx,
    tenantId,
    sub,
    {
      changeId: change.id,
      changeType: command.changeType,
      toOfferPlanKey: command.toOfferPlanKey,
      toOfferVersion: command.toOfferVersion,
      effectiveAt: command.effectiveAt,
      status: "scheduled"
    },
    ctx
  );
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId: ctx.actorTenantUserId ?? undefined,
    moduleKey: MODULE_KEY,
    action: "update",
    resourceType: "subscription_billing_subscription_change",
    resourceId: change.id,
    severity: "warning",
    message: `Subscription ${command.changeType} scheduled at ${command.effectiveAt}: ${command.reason}`,
    attributes: {
      subscriptionId,
      changeType: command.changeType,
      toOfferPlanKey: command.toOfferPlanKey,
      toOfferVersion: command.toOfferVersion,
      effectiveAt: command.effectiveAt
    },
    correlationId: ctx.correlationId
  });

  return { ok: true, changeId: change.id };
}

async function emitChanged(
  tx: Bun.SQL,
  tenantId: string,
  sub: SubscriptionRow,
  detail: {
    changeId: string;
    changeType: string;
    toOfferPlanKey: string | null;
    toOfferVersion: number | null;
    effectiveAt: string;
    status: string;
  },
  ctx: ActionContext
): Promise<void> {
  await appendDomainEvent(tx, tenantId, {
    eventType: SUBSCRIPTION_BILLING_SUBSCRIPTION_CHANGED_EVENT_TYPE,
    eventVersion: SUBSCRIPTION_BILLING_EVENT_VERSION,
    aggregateType: AGGREGATE_TYPE,
    aggregateId: sub.id,
    aggregateVersion: Number(sub.version),
    producerModule: MODULE_KEY,
    correlationId: ctx.correlationId,
    actorTenantUserId: ctx.actorTenantUserId,
    payload: {
      changeId: detail.changeId,
      subscriptionId: sub.id,
      changeType: detail.changeType,
      fromOfferPlanKey: sub.offer_plan_key,
      fromOfferVersion: Number(sub.offer_version),
      toOfferPlanKey: detail.toOfferPlanKey,
      toOfferVersion: detail.toOfferVersion,
      effectiveAt: detail.effectiveAt,
      status: detail.status
    }
  });
}

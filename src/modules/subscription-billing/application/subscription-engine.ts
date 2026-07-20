/**
 * `subscription_billing` subscription engine (Issue #876, epic #868). Runs
 * inside the CALLER's already tenant-scoped `tx` so the state change, the
 * append-only period/history, the versioned domain event (same-commit), and the
 * audit record COMMIT ATOMICALLY. The published-offer binding is read through
 * the INJECTED `service_catalog_read` port (composition-root wiring, never a
 * direct import — module-boundary). Concurrency: create is unique-guarded
 * (`ON CONFLICT`), transition is state+version-predicated (lost race -> 409).
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  SUBSCRIPTION_BILLING_EVENT_VERSION,
  SUBSCRIPTION_BILLING_SUBSCRIPTION_TRANSITIONED_EVENT_TYPE
} from "../../domain-event-runtime/domain/event-type-registry";
import type { ServiceCatalogReadPort } from "../../_shared/ports/service-catalog-read-port";
import {
  isLegalSubscriptionTransition,
  isTerminalSubscriptionState,
  type SubscriptionSource,
  type SubscriptionState
} from "../domain/subscription-state";
import { isBillingInterval, nextPeriodEnd } from "../domain/period";
import type { RoundingMode } from "../domain/money";
import {
  applySubscriptionTransition,
  createSubscription,
  loadSubscriptionForUpdate,
  type SubscriptionRow
} from "./billing-directory";

const MODULE_KEY = "subscription_billing";
const AGGREGATE_TYPE = "subscription_billing_subscription";

export type SubscriptionEngineDeps = {
  /** Read-only #870 published catalog port, wired at the composition root. */
  catalog: ServiceCatalogReadPort;
};

export type ActionContext = {
  actorTenantUserId: string | null;
  correlationId?: string;
};

export type SubscriptionDto = {
  id: string;
  offerPlanKey: string;
  offerVersion: number;
  offerHash: string;
  currency: string;
  state: SubscriptionState;
  version: number;
  billingInterval: string;
  prorationPolicy: string;
  roundingMode: RoundingMode;
  collectionMode: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
};

export function toSubscriptionDto(row: SubscriptionRow): SubscriptionDto {
  return {
    id: row.id,
    offerPlanKey: row.offer_plan_key,
    offerVersion: Number(row.offer_version),
    offerHash: row.offer_hash,
    currency: row.currency,
    state: row.state,
    version: Number(row.version),
    billingInterval: row.billing_interval,
    prorationPolicy: row.proration_policy,
    roundingMode: row.rounding_mode,
    collectionMode: row.collection_mode,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    trialEndsAt: row.trial_ends_at
  };
}

export type CreateResult =
  | { ok: true; subscription: SubscriptionDto }
  | {
      ok: false;
      reason: "offer_not_found" | "conflict" | "validation";
      message: string;
    };

export async function createSubscriptionForOffer(
  tx: Bun.SQL,
  tenantId: string,
  command: {
    offerPlanKey: string;
    offerVersion: number;
    billingInterval: string;
    billingAnchorDay: number | null;
    prorationPolicy: string;
    roundingMode: RoundingMode;
    collectionMode: string;
    trialEndsAt: string | null;
    billingContactRef: string | null;
    reason: string;
    source: SubscriptionSource;
  },
  deps: SubscriptionEngineDeps,
  ctx: ActionContext,
  now: Date = new Date()
): Promise<CreateResult> {
  const offer = await deps.catalog.getPublishedOffer(
    command.offerPlanKey,
    command.offerVersion
  );
  if (!offer) {
    return {
      ok: false,
      reason: "offer_not_found",
      message: `Published offer ${command.offerPlanKey}@v${command.offerVersion} not found.`
    };
  }
  if (!isBillingInterval(command.billingInterval)) {
    return {
      ok: false,
      reason: "validation",
      message: "unknown billing interval"
    };
  }

  // Trialing iff the offer allows a trial AND a trial end is supplied; else active.
  const trialing = offer.trialEnabled && command.trialEndsAt !== null;
  const initialState: SubscriptionState = trialing ? "trialing" : "active";
  const periodStart = now.toISOString();
  const periodEnd = nextPeriodEnd(now, command.billingInterval).toISOString();

  const row = await createSubscription(tx, tenantId, {
    offerPlanKey: offer.planKey,
    offerVersion: offer.version,
    offerHash: offer.offerHash,
    currency: offer.currency,
    initialState,
    billingInterval: command.billingInterval,
    billingAnchorDay: command.billingAnchorDay,
    prorationPolicy: command.prorationPolicy,
    roundingMode: command.roundingMode,
    collectionMode: command.collectionMode,
    trialEndsAt: command.trialEndsAt,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    billingContactRef: command.billingContactRef,
    reason: command.reason,
    source: command.source,
    actor: ctx.actorTenantUserId
  });
  if (!row) {
    return {
      ok: false,
      reason: "conflict",
      message: `A live subscription for plan ${command.offerPlanKey} already exists.`
    };
  }

  await appendDomainEvent(tx, tenantId, {
    eventType: SUBSCRIPTION_BILLING_SUBSCRIPTION_TRANSITIONED_EVENT_TYPE,
    eventVersion: SUBSCRIPTION_BILLING_EVENT_VERSION,
    aggregateType: AGGREGATE_TYPE,
    aggregateId: row.id,
    aggregateVersion: Number(row.version),
    producerModule: MODULE_KEY,
    correlationId: ctx.correlationId,
    actorTenantUserId: ctx.actorTenantUserId,
    payload: {
      subscriptionId: row.id,
      tenantId,
      fromState: null,
      toState: initialState,
      version: Number(row.version),
      offerPlanKey: row.offer_plan_key,
      offerVersion: Number(row.offer_version),
      source: command.source,
      genesis: true
    }
  });
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId: ctx.actorTenantUserId ?? undefined,
    moduleKey: MODULE_KEY,
    action: "create",
    resourceType: "subscription_billing_subscription",
    resourceId: row.id,
    severity: "warning",
    message: `Subscription created for ${row.offer_plan_key}@v${row.offer_version} at "${initialState}": ${command.reason}`,
    attributes: {
      offerPlanKey: row.offer_plan_key,
      offerVersion: Number(row.offer_version),
      state: initialState,
      currency: row.currency
    },
    correlationId: ctx.correlationId
  });

  return { ok: true, subscription: toSubscriptionDto(row) };
}

export type TransitionResult =
  | { ok: true; subscription: SubscriptionDto }
  | {
      ok: false;
      reason: "not_found" | "illegal_transition" | "version_conflict";
      message: string;
      current?: SubscriptionDto;
    };

export async function transitionSubscription(
  tx: Bun.SQL,
  tenantId: string,
  subscriptionId: string,
  command: {
    toState: SubscriptionState;
    source: SubscriptionSource;
    reason: string;
    expectedVersion: number | null;
  },
  ctx: ActionContext,
  now: Date = new Date()
): Promise<TransitionResult> {
  const row = await loadSubscriptionForUpdate(tx, tenantId, subscriptionId);
  if (!row) {
    return {
      ok: false,
      reason: "not_found",
      message: "Subscription not found."
    };
  }
  if (
    command.expectedVersion !== null &&
    command.expectedVersion !== Number(row.version)
  ) {
    return {
      ok: false,
      reason: "version_conflict",
      message: `Subscription version is ${row.version}, expected ${command.expectedVersion}.`,
      current: toSubscriptionDto(row)
    };
  }
  if (
    command.toState === row.state ||
    isTerminalSubscriptionState(row.state) ||
    !isLegalSubscriptionTransition(row.state, command.toState)
  ) {
    return {
      ok: false,
      reason: "illegal_transition",
      message: `Illegal subscription transition "${row.state}" -> "${command.toState}".`,
      current: toSubscriptionDto(row)
    };
  }

  const canceledAt = command.toState === "canceled" ? now.toISOString() : null;
  const endedAt =
    command.toState === "canceled" || command.toState === "expired"
      ? now.toISOString()
      : null;
  const updated = await applySubscriptionTransition(tx, {
    tenantId,
    subscriptionId,
    fromState: row.state,
    fromVersion: Number(row.version),
    toState: command.toState,
    actor: ctx.actorTenantUserId,
    canceledAt,
    endedAt
  });
  if (!updated) {
    return {
      ok: false,
      reason: "version_conflict",
      message: "Subscription changed concurrently.",
      current: toSubscriptionDto(row)
    };
  }

  await appendDomainEvent(tx, tenantId, {
    eventType: SUBSCRIPTION_BILLING_SUBSCRIPTION_TRANSITIONED_EVENT_TYPE,
    eventVersion: SUBSCRIPTION_BILLING_EVENT_VERSION,
    aggregateType: AGGREGATE_TYPE,
    aggregateId: updated.id,
    aggregateVersion: Number(updated.version),
    producerModule: MODULE_KEY,
    correlationId: ctx.correlationId,
    actorTenantUserId: ctx.actorTenantUserId,
    payload: {
      subscriptionId: updated.id,
      tenantId,
      fromState: row.state,
      toState: command.toState,
      version: Number(updated.version),
      offerPlanKey: updated.offer_plan_key,
      offerVersion: Number(updated.offer_version),
      source: command.source
    }
  });
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId: ctx.actorTenantUserId ?? undefined,
    moduleKey: MODULE_KEY,
    action: "update",
    resourceType: "subscription_billing_subscription",
    resourceId: updated.id,
    severity: "warning",
    message: `Subscription ${row.state} -> ${command.toState}: ${command.reason}`,
    attributes: {
      fromState: row.state,
      toState: command.toState,
      version: Number(updated.version),
      source: command.source
    },
    correlationId: ctx.correlationId
  });

  return { ok: true, subscription: toSubscriptionDto(updated) };
}

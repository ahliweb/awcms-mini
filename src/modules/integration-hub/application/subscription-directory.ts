import { getIntegrationAdapterByKey } from "../infrastructure/adapter-registry";
import { validateOutboundUrlShape } from "../domain/ssrf-guard";
import {
  validateSubscriptionFilter,
  type SubscriptionFilter
} from "../domain/subscription-filter";
import { isPrivateTargetsAllowed } from "../domain/integration-hub-config";
import { isRegisteredDomainEventType } from "../../domain-event-runtime/domain/event-type-registry";
import { assertValidSecretReferenceNaming } from "../domain/secret-reference-validation";

export { InvalidSecretReferenceError } from "../domain/secret-reference-validation";

/**
 * Outbound event subscription CRUD (Issue #754). `target_url` is
 * SSRF-validated at WRITE time here (defense in depth — the outbound
 * dispatch job re-validates again at actual delivery time,
 * `infrastructure/outbound-http-client.ts`, since a DNS record can change
 * between subscription creation and a later delivery attempt).
 */

export class UnknownOutboundAdapterError extends Error {
  constructor(adapterKey: string) {
    super(
      `"${adapterKey}" is not a registered outbound adapter — see infrastructure/adapter-registry.ts.`
    );
    this.name = "UnknownOutboundAdapterError";
  }
}

export class UnregisteredSubscribableEventTypeError extends Error {
  constructor(eventType: string) {
    super(
      `"${eventType}" is not a registered domain_event_runtime event type — see domain-event-runtime/domain/event-type-registry.ts.`
    );
    this.name = "UnregisteredSubscribableEventTypeError";
  }
}

export class InvalidOutboundTargetError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Outbound target_url rejected: ${reason}`);
    this.name = "InvalidOutboundTargetError";
    this.reason = reason;
  }
}

export class InvalidSubscriptionFilterError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Subscription filter rejected: ${reason}`);
    this.name = "InvalidSubscriptionFilterError";
    this.reason = reason;
  }
}

type IntegrationSubscriptionDbRow = {
  id: string;
  tenant_id: string;
  subscribed_event_type: string;
  target_adapter_key: string;
  target_url: string;
  target_headers: Record<string, string>;
  secret_reference: string | null;
  filter: SubscriptionFilter;
  status: string;
  max_attempts: number;
  timeout_ms: number;
  description: string | null;
  created_at: Date;
  updated_at: Date;
};

/** Public camelCase DTO — matches the OpenAPI contract, never the raw DB row shape (same split `endpoint-directory.ts` uses). */
export type IntegrationSubscriptionDto = {
  id: string;
  tenantId: string;
  subscribedEventType: string;
  targetAdapterKey: string;
  targetUrl: string;
  targetHeaders: Record<string, string>;
  hasOutboundSigningSecret: boolean;
  filter: SubscriptionFilter;
  status: string;
  maxAttempts: number;
  timeoutMs: number;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toDto(row: IntegrationSubscriptionDbRow): IntegrationSubscriptionDto {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    subscribedEventType: row.subscribed_event_type,
    targetAdapterKey: row.target_adapter_key,
    targetUrl: row.target_url,
    targetHeaders: row.target_headers,
    hasOutboundSigningSecret: row.secret_reference !== null,
    filter: row.filter,
    status: row.status,
    maxAttempts: row.max_attempts,
    timeoutMs: row.timeout_ms,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export type CreateSubscriptionInput = {
  subscribedEventType: string;
  targetAdapterKey: string;
  targetUrl: string;
  targetHeaders?: Record<string, string>;
  secretReference?: string | null;
  filter?: SubscriptionFilter;
  maxAttempts?: number;
  timeoutMs?: number;
  description?: string | null;
  actorTenantUserId?: string | null;
  /** Test-only override — production callers always use the real `isPrivateTargetsAllowed()`. */
  allowPrivateTargetsOverride?: boolean;
};

function assertKnownOutboundAdapter(adapterKey: string): void {
  const adapter = getIntegrationAdapterByKey(adapterKey);

  if (
    !adapter ||
    (adapter.direction !== "outbound" && adapter.direction !== "both")
  ) {
    throw new UnknownOutboundAdapterError(adapterKey);
  }
}

export async function createIntegrationSubscription(
  tx: Bun.SQL,
  tenantId: string,
  input: CreateSubscriptionInput
): Promise<IntegrationSubscriptionDto> {
  assertKnownOutboundAdapter(input.targetAdapterKey);

  if (!isRegisteredDomainEventType(input.subscribedEventType, "1.0")) {
    // Every event type this hub can currently fan out for is version
    // "1.0" (see event-type-registry.ts) — this check exists primarily to
    // reject a typo'd/unknown event type at write time rather than let a
    // subscription sit silently unmatched forever.
    throw new UnregisteredSubscribableEventTypeError(input.subscribedEventType);
  }

  const filter = input.filter ?? {};
  const filterValidation = validateSubscriptionFilter(filter);

  if (!filterValidation.ok) {
    throw new InvalidSubscriptionFilterError(filterValidation.reason);
  }

  const urlCheck = validateOutboundUrlShape(input.targetUrl, {
    allowPrivateTargets:
      input.allowPrivateTargetsOverride ?? isPrivateTargetsAllowed()
  });

  if (!urlCheck.ok) {
    throw new InvalidOutboundTargetError(urlCheck.reason);
  }

  if (input.secretReference) {
    assertValidSecretReferenceNaming(input.secretReference);
  }

  const rows = (await tx`
    INSERT INTO awcms_mini_integration_subscriptions
      (tenant_id, subscribed_event_type, target_adapter_key, target_url,
       target_headers, secret_reference, filter, max_attempts, timeout_ms,
       description, created_by, updated_by)
    VALUES (
      ${tenantId}, ${input.subscribedEventType}, ${input.targetAdapterKey}, ${input.targetUrl},
      ${input.targetHeaders ?? {}}, ${input.secretReference ?? null}, ${filter},
      ${input.maxAttempts ?? 8}, ${input.timeoutMs ?? 10000}, ${input.description ?? null},
      ${input.actorTenantUserId ?? null}, ${input.actorTenantUserId ?? null}
    )
    RETURNING *
  `) as IntegrationSubscriptionDbRow[];

  return toDto(rows[0]!);
}

export async function listIntegrationSubscriptions(
  tx: Bun.SQL,
  tenantId: string
): Promise<IntegrationSubscriptionDto[]> {
  const rows = (await tx`
    SELECT * FROM awcms_mini_integration_subscriptions
    WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
    ORDER BY created_at DESC
  `) as IntegrationSubscriptionDbRow[];

  return rows.map(toDto);
}

export async function getIntegrationSubscription(
  tx: Bun.SQL,
  tenantId: string,
  id: string
): Promise<IntegrationSubscriptionDto | null> {
  const rows = (await tx`
    SELECT * FROM awcms_mini_integration_subscriptions
    WHERE tenant_id = ${tenantId} AND id = ${id} AND deleted_at IS NULL
  `) as IntegrationSubscriptionDbRow[];

  return rows[0] ? toDto(rows[0]) : null;
}

export async function setIntegrationSubscriptionStatus(
  tx: Bun.SQL,
  tenantId: string,
  id: string,
  status: "active" | "paused" | "disabled",
  actorTenantUserId: string | null
): Promise<IntegrationSubscriptionDto | null> {
  const rows = (await tx`
    UPDATE awcms_mini_integration_subscriptions
    SET status = ${status}, updated_at = now(), updated_by = ${actorTenantUserId}
    WHERE tenant_id = ${tenantId} AND id = ${id} AND deleted_at IS NULL
    RETURNING *
  `) as IntegrationSubscriptionDbRow[];

  return rows[0] ? toDto(rows[0]) : null;
}

export async function softDeleteIntegrationSubscription(
  tx: Bun.SQL,
  tenantId: string,
  id: string,
  reason: string,
  actorTenantUserId: string | null
): Promise<boolean> {
  const rows = (await tx`
    UPDATE awcms_mini_integration_subscriptions
    SET deleted_at = now(), deleted_by = ${actorTenantUserId}, delete_reason = ${reason},
        status = 'disabled', updated_at = now(), updated_by = ${actorTenantUserId}
    WHERE tenant_id = ${tenantId} AND id = ${id} AND deleted_at IS NULL
    RETURNING id
  `) as { id: string }[];

  return rows.length > 0;
}

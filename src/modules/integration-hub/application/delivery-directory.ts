/**
 * Read-only admin visibility for inbound/outbound deliveries, attempt
 * history, and adapter health (Issue #754 scope: "recent delivery
 * metadata, failures"). Every query is tenant-scoped (RLS + explicit
 * `tenant_id` filter, defense in depth) and paginated with a bounded
 * `LIMIT`. Same "DB snake_case row -> public camelCase DTO" split
 * `endpoint-directory.ts`/`subscription-directory.ts` use.
 */
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_LIST_LIMIT;
  }
  return Math.min(limit, MAX_LIST_LIMIT);
}

type InboundDeliveryDbRow = {
  id: string;
  tenant_id: string;
  endpoint_id: string;
  adapter_key: string;
  provider_delivery_id: string | null;
  signature_valid: boolean;
  verification_failure_reason: string | null;
  content_type: string | null;
  raw_body_size: number;
  status: string;
  normalized_event_id: string | null;
  received_at: Date;
};

export type InboundDeliveryDto = {
  id: string;
  tenantId: string;
  endpointId: string;
  adapterKey: string;
  providerDeliveryId: string | null;
  signatureValid: boolean;
  verificationFailureReason: string | null;
  contentType: string | null;
  rawBodySize: number;
  status: string;
  normalizedEventId: string | null;
  receivedAt: Date;
};

function toInboundDto(row: InboundDeliveryDbRow): InboundDeliveryDto {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    endpointId: row.endpoint_id,
    adapterKey: row.adapter_key,
    providerDeliveryId: row.provider_delivery_id,
    signatureValid: row.signature_valid,
    verificationFailureReason: row.verification_failure_reason,
    contentType: row.content_type,
    rawBodySize: row.raw_body_size,
    status: row.status,
    normalizedEventId: row.normalized_event_id,
    receivedAt: row.received_at
  };
}

export async function listInboundDeliveries(
  tx: Bun.SQL,
  tenantId: string,
  options: { limit?: number; endpointId?: string } = {}
): Promise<InboundDeliveryDto[]> {
  const limit = clampLimit(options.limit);

  const rows = (await tx`
    SELECT id, tenant_id, endpoint_id, adapter_key, provider_delivery_id,
           signature_valid, verification_failure_reason, content_type,
           raw_body_size, status, normalized_event_id, received_at
    FROM awcms_mini_integration_inbound_deliveries
    WHERE tenant_id = ${tenantId}
      AND (${options.endpointId ?? null}::uuid IS NULL OR endpoint_id = ${options.endpointId ?? null})
    ORDER BY received_at DESC
    LIMIT ${limit}
  `) as InboundDeliveryDbRow[];

  return rows.map(toInboundDto);
}

type OutboundDeliveryDbRow = {
  id: string;
  tenant_id: string;
  subscription_id: string;
  source_event_id: string;
  event_type: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: Date | null;
  last_error: string | null;
  last_http_status: number | null;
  replay_of_delivery_id: string | null;
  created_at: Date;
  updated_at: Date;
};

export type OutboundDeliveryDto = {
  id: string;
  tenantId: string;
  subscriptionId: string;
  sourceEventId: string;
  eventType: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: Date | null;
  lastError: string | null;
  lastHttpStatus: number | null;
  replayOfDeliveryId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toOutboundDto(row: OutboundDeliveryDbRow): OutboundDeliveryDto {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    subscriptionId: row.subscription_id,
    sourceEventId: row.source_event_id,
    eventType: row.event_type,
    status: row.status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    lastHttpStatus: row.last_http_status,
    replayOfDeliveryId: row.replay_of_delivery_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function listOutboundDeliveries(
  tx: Bun.SQL,
  tenantId: string,
  options: { limit?: number; subscriptionId?: string; status?: string } = {}
): Promise<OutboundDeliveryDto[]> {
  const limit = clampLimit(options.limit);

  const rows = (await tx`
    SELECT id, tenant_id, subscription_id, source_event_id, event_type, status,
           attempt_count, max_attempts, next_attempt_at, last_error, last_http_status,
           replay_of_delivery_id, created_at, updated_at
    FROM awcms_mini_integration_outbound_deliveries
    WHERE tenant_id = ${tenantId}
      AND (${options.subscriptionId ?? null}::uuid IS NULL OR subscription_id = ${options.subscriptionId ?? null})
      AND (${options.status ?? null}::text IS NULL OR status = ${options.status ?? null})
    ORDER BY created_at DESC
    LIMIT ${limit}
  `) as OutboundDeliveryDbRow[];

  return rows.map(toOutboundDto);
}

export async function getOutboundDelivery(
  tx: Bun.SQL,
  tenantId: string,
  id: string
): Promise<OutboundDeliveryDto | null> {
  const rows = (await tx`
    SELECT id, tenant_id, subscription_id, source_event_id, event_type, status,
           attempt_count, max_attempts, next_attempt_at, last_error, last_http_status,
           replay_of_delivery_id, created_at, updated_at
    FROM awcms_mini_integration_outbound_deliveries
    WHERE tenant_id = ${tenantId} AND id = ${id}
  `) as OutboundDeliveryDbRow[];

  return rows[0] ? toOutboundDto(rows[0]) : null;
}

type DeliveryAttemptDbRow = {
  id: string;
  delivery_id: string;
  attempt_no: number;
  outcome: string;
  http_status: number | null;
  response_snippet: string | null;
  error_message: string | null;
  attempted_at: Date;
};

export type DeliveryAttemptDto = {
  id: string;
  deliveryId: string;
  attemptNo: number;
  outcome: string;
  httpStatus: number | null;
  responseSnippet: string | null;
  errorMessage: string | null;
  attemptedAt: Date;
};

function toAttemptDto(row: DeliveryAttemptDbRow): DeliveryAttemptDto {
  return {
    id: row.id,
    deliveryId: row.delivery_id,
    attemptNo: row.attempt_no,
    outcome: row.outcome,
    httpStatus: row.http_status,
    responseSnippet: row.response_snippet,
    errorMessage: row.error_message,
    attemptedAt: row.attempted_at
  };
}

export async function listDeliveryAttempts(
  tx: Bun.SQL,
  tenantId: string,
  deliveryId: string
): Promise<DeliveryAttemptDto[]> {
  const rows = (await tx`
    SELECT id, delivery_id, attempt_no, outcome, http_status, response_snippet, error_message, attempted_at
    FROM awcms_mini_integration_delivery_attempts
    WHERE tenant_id = ${tenantId} AND delivery_id = ${deliveryId}
    ORDER BY attempt_no ASC
  `) as DeliveryAttemptDbRow[];

  return rows.map(toAttemptDto);
}

type AdapterHealthDbRow = {
  adapter_key: string;
  direction: string;
  state: string;
  consecutive_failures: number;
  consecutive_successes: number;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  last_checked_at: Date;
};

export type AdapterHealthDto = {
  adapterKey: string;
  direction: string;
  state: string;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastCheckedAt: Date;
};

function toHealthDto(row: AdapterHealthDbRow): AdapterHealthDto {
  return {
    adapterKey: row.adapter_key,
    direction: row.direction,
    state: row.state,
    consecutiveFailures: row.consecutive_failures,
    consecutiveSuccesses: row.consecutive_successes,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    lastCheckedAt: row.last_checked_at
  };
}

export async function listAdapterHealth(
  tx: Bun.SQL,
  tenantId: string
): Promise<AdapterHealthDto[]> {
  const rows = (await tx`
    SELECT adapter_key, direction, state, consecutive_failures, consecutive_successes,
           last_success_at, last_failure_at, last_checked_at
    FROM awcms_mini_integration_adapter_health
    WHERE tenant_id = ${tenantId}
    ORDER BY adapter_key ASC, direction ASC
  `) as AdapterHealthDbRow[];

  return rows.map(toHealthDto);
}

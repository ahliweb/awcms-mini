import { randomUUID, createHash } from "node:crypto";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  INTEGRATION_HUB_EVENT_VERSION,
  INTEGRATION_HUB_INBOUND_MESSAGE_NORMALIZED_EVENT_TYPE
} from "../../domain-event-runtime/domain/event-type-registry";
import { getIntegrationAdapterByKey } from "../infrastructure/adapter-registry";
import {
  checkBodySize,
  checkContentType,
  checkEndpointAcceptingTraffic,
  RAW_BODY_SNIPPET_MAX_LENGTH
} from "../domain/inbound-validation";
import {
  resolvePreviousSecretIfInOverlap,
  resolveSecretReference
} from "./secret-resolver";
import {
  redactSecretsInText,
  redactSensitiveAttributes
} from "../../_shared/redaction";
import {
  applyHealthFailure,
  applyHealthSuccess
} from "../domain/adapter-health";

/**
 * The REAL inbound-webhook write path (Issue #754 critical requirement
 * #3: replay protection must be enforced HERE, via a real DB uniqueness
 * constraint, not only a validator unit-tested in isolation). Called by
 * `POST /api/v1/integration-hub/inbound/{endpointToken}`
 * (`src/pages/api/v1/integration-hub/inbound/[endpointToken].ts`) — the
 * ONLY caller. Every step below runs, in order, inside the SAME
 * tenant-scoped transaction (`withTenant`'s callback) as the eventual
 * `appendDomainEvent` call, so a verified inbound delivery and its
 * normalized domain event commit atomically (or neither does).
 */

const MAX_NORMALIZED_BODY_BYTES = 32_000;

export type IntegrationEndpointLookupRow = {
  endpoint_id: string;
  tenant_id: string;
  adapter_key: string;
  secret_reference: string;
  secret_reference_previous: string | null;
  previous_secret_expires_at: Date | null;
  endpoint_status: string;
  max_body_bytes: number;
  allowed_content_types: string[];
  timestamp_tolerance_seconds: number;
  tenant_status: string;
};

/**
 * The bootstrap lookup — runs BEFORE any tenant context exists (a webhook
 * receiver has no prior JWT/session to derive a tenant from). Calls the
 * `SECURITY DEFINER` function `awcms_mini_resolve_integration_endpoint_
 * lookup` (migration 071), which returns a narrow, non-secret projection
 * (never `raw_body_snippet`/any other table) in exactly one round trip
 * regardless of outcome — same "avoid a timing side-channel between
 * unknown token and known-but-inactive" pattern `resolvePublicTenantByHost`
 * already established (migration 033).
 */
export async function resolveIntegrationEndpointByToken(
  sql: Bun.SQL,
  endpointToken: string
): Promise<IntegrationEndpointLookupRow | null> {
  const rows = (await sql`
    SELECT * FROM awcms_mini_resolve_integration_endpoint_lookup(${endpointToken})
  `) as IntegrationEndpointLookupRow[];

  return rows[0] ?? null;
}

export type ProcessInboundWebhookParams = {
  endpoint: IntegrationEndpointLookupRow;
  rawBody: string;
  headers: Readonly<Record<string, string>>;
  contentType: string | null;
  now: Date;
  correlationId: string;
};

export type ProcessInboundWebhookResult =
  | { outcome: "accepted_new"; deliveryId: string; eventId: string }
  | { outcome: "accepted_duplicate" }
  | { outcome: "rejected"; httpStatus: number; code: string; message: string };

type InboundDeliveryInsertRow = { id: string };

async function upsertAdapterHealth(
  tx: Bun.SQL,
  tenantId: string,
  adapterKey: string,
  success: boolean
): Promise<void> {
  const existingRows = (await tx`
    SELECT state, consecutive_failures, consecutive_successes
    FROM awcms_mini_integration_adapter_health
    WHERE tenant_id = ${tenantId} AND adapter_key = ${adapterKey} AND direction = 'inbound'
  `) as {
    state: string;
    consecutive_failures: number;
    consecutive_successes: number;
  }[];

  const current = existingRows[0]
    ? {
        state: existingRows[0].state as "up" | "degraded" | "down",
        consecutiveFailures: Number(existingRows[0].consecutive_failures),
        consecutiveSuccesses: Number(existingRows[0].consecutive_successes)
      }
    : { state: "up" as const, consecutiveFailures: 0, consecutiveSuccesses: 0 };

  const next = success
    ? applyHealthSuccess(current)
    : applyHealthFailure(current);

  await tx`
    INSERT INTO awcms_mini_integration_adapter_health
      (tenant_id, adapter_key, direction, state, consecutive_failures,
       consecutive_successes, last_success_at, last_failure_at, last_checked_at, updated_at)
    VALUES (
      ${tenantId}, ${adapterKey}, 'inbound', ${next.state}, ${next.consecutiveFailures},
      ${next.consecutiveSuccesses}, ${success ? new Date() : null}, ${success ? null : new Date()},
      now(), now()
    )
    ON CONFLICT (tenant_id, adapter_key, direction) DO UPDATE SET
      state = EXCLUDED.state,
      consecutive_failures = EXCLUDED.consecutive_failures,
      consecutive_successes = EXCLUDED.consecutive_successes,
      last_success_at = COALESCE(EXCLUDED.last_success_at, awcms_mini_integration_adapter_health.last_success_at),
      last_failure_at = COALESCE(EXCLUDED.last_failure_at, awcms_mini_integration_adapter_health.last_failure_at),
      last_checked_at = now(),
      updated_at = now()
  `;
}

/**
 * Security-auditor finding (PR #784, Low, AGENTS.md rule #9): the parsed
 * body only ever got secret-PATTERN redaction (`redactSecretsInText`, on
 * the raw text snippet) before this fix — a PII-KEY-named field
 * (nik/npwp/phone/whatsapp/email, `_shared/redaction.ts`'s
 * `REDACTION_KEYS`) inside a provider's JSON payload flowed through
 * unmasked into the persisted domain event AND the outbound relay to
 * subscribers. Applying `redactSensitiveAttributes` here is a deliberate
 * trade-off, not a blanket policy change: a legitimate integration that
 * genuinely needs a PII-key-named field forwarded verbatim (e.g. an order
 * webhook's customer phone number) will now see `"[REDACTED]"` instead —
 * accepted because AGENTS.md rule #9 ("data sensitif wajib dimask")
 * applies with no generic-relay carve-out; a future real adapter needing
 * raw PII passthrough is a deliberate, reviewed exception to request
 * (e.g. a narrower per-adapter allowlist), not a silent default. Only
 * applied to a genuine object (JSON.parse can also yield an array/
 * primitive/null at the top level, which `redactSensitiveAttributes`
 * does not accept).
 */
function redactNormalizedBodyPii(body: unknown): unknown {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return redactSensitiveAttributes(body as Record<string, unknown>);
  }

  return body;
}

type NormalizedBodyResult = {
  body: unknown;
  truncated: boolean;
  /**
   * `true` only when `rawBody` was valid JSON whose top-level value is a
   * genuine object — the one case `redactNormalizedBodyPii` actually runs
   * `redactSensitiveAttributes` against it (it deliberately passes an
   * array/primitive/null top-level value through un-redacted, same
   * restriction `redactSensitiveAttributes` itself has). Callers use this
   * to decide whether `raw_body_snippet` is safe to persist at all — see
   * that field's own doc comment below.
   */
  isRedactedObject: boolean;
};

function buildNormalizedBody(
  rawBody: string,
  contentType: string | null
): NormalizedBodyResult {
  const base = (contentType ?? "").split(";")[0]!.trim().toLowerCase();

  if (base !== "application/json") {
    return { body: null, truncated: false, isRedactedObject: false };
  }

  if (rawBody.length > MAX_NORMALIZED_BODY_BYTES) {
    return { body: null, truncated: true, isRedactedObject: false };
  }

  try {
    const parsed: unknown = JSON.parse(rawBody);
    const isObject =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);

    return {
      body: redactNormalizedBodyPii(parsed),
      truncated: false,
      isRedactedObject: isObject
    };
  } catch {
    return { body: null, truncated: false, isRedactedObject: false };
  }
}

/**
 * Runs INSIDE the caller's `withTenant(sql, endpoint.tenant_id, ...)`
 * transaction. Returns `"rejected"` for every pre-signature gate failure
 * AND for signature verification failure — none of these persist a
 * normalized event, and a REJECTED attempt gets a fresh per-attempt
 * `replay_key` (`randomUUID()`) so a flood of invalid attempts never
 * collides with (or blocks) a legitimate subsequent valid delivery's own
 * uniqueness check.
 */
export async function processInboundWebhook(
  tx: Bun.SQL,
  params: ProcessInboundWebhookParams
): Promise<ProcessInboundWebhookResult> {
  const { endpoint, rawBody, headers, contentType, now, correlationId } =
    params;

  const trafficCheck = checkEndpointAcceptingTraffic(
    endpoint.endpoint_status,
    endpoint.tenant_status
  );

  if (!trafficCheck.ok) {
    return {
      outcome: "rejected",
      httpStatus: 403,
      code: "ENDPOINT_NOT_ACCEPTING_TRAFFIC",
      message: "This inbound endpoint is not currently accepting traffic."
    };
  }

  const contentTypeCheck = checkContentType(
    contentType,
    endpoint.allowed_content_types
  );
  const bodySizeCheck = checkBodySize(
    Buffer.byteLength(rawBody, "utf8"),
    endpoint.max_body_bytes
  );

  const adapter = getIntegrationAdapterByKey(endpoint.adapter_key);
  const rawBodySha256 = createHash("sha256").update(rawBody).digest("hex");
  const rawBodySize = Buffer.byteLength(rawBody, "utf8");

  const rejectAndRecord = async (
    reason: string,
    httpStatus: number,
    code: string,
    message: string
  ): Promise<ProcessInboundWebhookResult> => {
    await tx`
      INSERT INTO awcms_mini_integration_inbound_deliveries
        (tenant_id, endpoint_id, adapter_key, replay_key, signature_valid,
         verification_failure_reason, content_type, raw_body_sha256, raw_body_size,
         status, correlation_id)
      VALUES (
        ${endpoint.tenant_id}, ${endpoint.endpoint_id}, ${endpoint.adapter_key}, ${randomUUID()},
        false, ${reason}, ${contentType}, ${rawBodySha256}, ${rawBodySize}, 'rejected', ${correlationId}
      )
    `;
    await upsertAdapterHealth(
      tx,
      endpoint.tenant_id,
      endpoint.adapter_key,
      false
    );

    return { outcome: "rejected", httpStatus, code, message };
  };

  if (!adapter || !adapter.verifyInbound) {
    return rejectAndRecord(
      "unknown_adapter",
      400,
      "UNKNOWN_ADAPTER",
      "Unknown or unsupported adapter for this endpoint."
    );
  }

  if (!contentTypeCheck.ok) {
    return rejectAndRecord(
      contentTypeCheck.reason,
      415,
      "UNSUPPORTED_CONTENT_TYPE",
      "Unsupported content type for this endpoint."
    );
  }

  if (!bodySizeCheck.ok) {
    return rejectAndRecord(
      bodySizeCheck.reason,
      413,
      "PAYLOAD_TOO_LARGE",
      "Request body exceeds this endpoint's configured maximum size."
    );
  }

  const secretResolution = resolveSecretReference(endpoint.secret_reference);

  if (!secretResolution.ok) {
    return rejectAndRecord(
      "secret_unresolvable",
      500,
      "INTERNAL_ERROR",
      "This endpoint's signing secret is not configured."
    );
  }

  const previousSecret = resolvePreviousSecretIfInOverlap(
    endpoint.secret_reference_previous,
    endpoint.previous_secret_expires_at,
    now
  );

  const verification = adapter.verifyInbound({
    rawBody,
    headers,
    secret: secretResolution.value,
    previousSecret,
    toleranceSeconds: endpoint.timestamp_tolerance_seconds,
    now
  });

  if (!verification.valid) {
    return rejectAndRecord(
      verification.reason,
      401,
      "SIGNATURE_VERIFICATION_FAILED",
      "Signature verification failed."
    );
  }

  const {
    body: normalizedBody,
    truncated,
    isRedactedObject
  } = buildNormalizedBody(rawBody, contentType);
  /**
   * Security-auditor finding (PR #784, Medium): `raw_body_snippet` (up to
   * `RAW_BODY_SNIPPET_MAX_LENGTH` chars of the RAW provider payload) only
   * ever got secret-PATTERN redaction (`redactSecretsInText`), never the
   * PII-KEY-based masking `normalizedBody` above gets via
   * `redactNormalizedBodyPii` — a payload containing e.g. `"nik":"3271..."`
   * or a bare email/phone was stored in plaintext at rest. Rather than
   * re-implementing a second, text-pattern-based PII-key scanner (a
   * fragile duplicate of `redactSensitiveAttributes`'s own key-based
   * logic — same "don't fork a second incomplete sanitizer" lesson this
   * codebase has already learned the hard way for markdown-escaping),
   * `raw_body_snippet` is simply NOT persisted at all when
   * `normalizedBody` above already IS the real, key-redacted
   * troubleshooting artifact for this delivery (`isRedactedObject`) — the
   * raw snippet added no information the normalized body doesn't already
   * cover, minus the PII-at-rest exposure. Only kept (still
   * secret-pattern-redacted, as before) for the cases `normalizedBody` is
   * `null`/unstructured (non-JSON content type, oversized, parse failure,
   * or a top-level JSON array/primitive) — there, it remains the ONLY
   * troubleshooting artifact this delivery has.
   */
  const snippet = isRedactedObject
    ? null
    : redactSecretsInText(rawBody.slice(0, RAW_BODY_SNIPPET_MAX_LENGTH));

  const inserted = (await tx`
    INSERT INTO awcms_mini_integration_inbound_deliveries
      (tenant_id, endpoint_id, adapter_key, replay_key, provider_delivery_id,
       signature_valid, content_type, raw_body_sha256, raw_body_size,
       raw_body_snippet, status, correlation_id)
    VALUES (
      ${endpoint.tenant_id}, ${endpoint.endpoint_id}, ${endpoint.adapter_key},
      ${verification.replayKey}, ${verification.providerDeliveryId ?? null},
      true, ${contentType}, ${rawBodySha256}, ${rawBodySize}, ${snippet}, 'received', ${correlationId}
    )
    ON CONFLICT (tenant_id, endpoint_id, replay_key) DO NOTHING
    RETURNING id
  `) as InboundDeliveryInsertRow[];

  await upsertAdapterHealth(tx, endpoint.tenant_id, endpoint.adapter_key, true);

  if (inserted.length === 0) {
    // A verified delivery with this exact replay_key was already
    // processed — the DB uniqueness constraint (not an in-memory check)
    // is what makes this durable across restarts/multi-instance
    // deployments (Issue #754 critical requirement #3). Idempotent
    // success: no new normalized event, no duplicated side effect.
    return { outcome: "accepted_duplicate" };
  }

  const deliveryId = inserted[0]!.id;

  const appendResult = await appendDomainEvent(tx, endpoint.tenant_id, {
    eventType: INTEGRATION_HUB_INBOUND_MESSAGE_NORMALIZED_EVENT_TYPE,
    eventVersion: INTEGRATION_HUB_EVENT_VERSION,
    aggregateType: "integration_hub_inbound_delivery",
    aggregateId: deliveryId,
    producerModule: "integration_hub",
    correlationId,
    payload: {
      endpointId: endpoint.endpoint_id,
      adapterKey: endpoint.adapter_key,
      providerDeliveryId: verification.providerDeliveryId ?? null,
      inboundDeliveryId: deliveryId,
      receivedAt: now.toISOString(),
      contentType,
      bodySize: rawBodySize,
      bodyTruncated: truncated,
      body: normalizedBody
    }
  });

  await tx`
    UPDATE awcms_mini_integration_inbound_deliveries
    SET status = 'normalized', normalized_event_id = ${appendResult.eventId}
    WHERE tenant_id = ${endpoint.tenant_id} AND id = ${deliveryId}
  `;

  return { outcome: "accepted_new", deliveryId, eventId: appendResult.eventId };
}

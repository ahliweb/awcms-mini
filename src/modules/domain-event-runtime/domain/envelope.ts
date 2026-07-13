import { findSecretShapedValues } from "../../_shared/redaction";

/**
 * Envelope shape/validation for the domain-event-runtime outbox (Issue
 * #742). Field names mirror the generic envelope skill `awcms-mini-new-event`
 * documents and the AsyncAPI `DomainEventEnvelope` schema
 * (`asyncapi/awcms-mini-domain-events.asyncapi.yaml`) already used by every
 * other module's events, plus the additional ordering/aggregate metadata
 * this issue's scope explicitly requires (aggregate type/id/version,
 * explicit order key, producer module, schema reference).
 */

/**
 * `namespace.aggregate.action`, lowercase, dot-separated (doc 05 §Event
 * naming, skill `awcms-mini-new-event`). Each segment allows hyphens too
 * (not just the trailing segments) — every real event name in this repo
 * uses a hyphenated `awcms-mini` namespace prefix (e.g.
 * `awcms-mini.social-publishing.job.published`,
 * `awcms-mini.domain-event-runtime.sample.recorded`), so a pattern that
 * only allowed hyphens AFTER the first dot would reject the namespace
 * segment itself — caught by `tests/unit/domain-event-runtime-envelope.
 * test.ts` before this ever reached the matching DB CHECK constraint
 * (migration 056), which uses the identical corrected pattern.
 */
const EVENT_TYPE_PATTERN = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9_-]+)+$/;
const EVENT_VERSION_PATTERN = /^[0-9]+\.[0-9]+$/;

/** Matches the DB CHECK constraint in `sql/056_awcms_mini_domain_event_runtime_schema.sql` — kept in sync deliberately (the DB constraint is the hard backstop, this is the friendly pre-check that lets a caller get a clear application error instead of a raw Postgres constraint violation). */
export const DOMAIN_EVENT_PAYLOAD_MAX_BYTES = 65_536;

export type DomainEventPayloadValidationResult =
  { valid: true } | { valid: false; errors: string[] };

/**
 * Deliberately NARROWER than `_shared/redaction.ts`'s `REDACTION_KEYS` —
 * that list also includes ordinary PII substrings (`npwp`, `nik`, `phone`,
 * `whatsapp`, `email`, `cookie`) that ARE legitimate business data a
 * consumer may genuinely need (e.g. an email address for a downstream
 * "send welcome email" projection) — this repo's own architecture
 * encourages referencing the canonical `profile_identity` record instead
 * of duplicating PII (ADR-0013 §4), but that is a producer-level design
 * choice this generic runtime should not mechanically force by rejecting
 * every payload that happens to contain an `email`/`phone` field. This
 * list instead matches ONLY names that are essentially never a legitimate
 * event payload field under any circumstance — a literal credential
 * container. Same "duplicate a short literal list rather than export an
 * internal detail across an unrelated module boundary" reasoning
 * `retry-classification.ts` already uses for its own
 * `NOT_RETRYABLE_SQLSTATE_CLASSES` duplicate of `tenant-context.ts`'s
 * private list.
 */
const CREDENTIAL_KEY_SUBSTRINGS = [
  "password",
  "passwordhash",
  "token",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "secret",
  "credential",
  "authorization"
];

function isCredentialShapedKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return CREDENTIAL_KEY_SUBSTRINGS.some((substring) =>
    normalized.includes(substring)
  );
}

function collectCredentialShapedKeys(value: unknown, keys: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectCredentialShapedKeys(item, keys);
    }
    return;
  }

  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(
      value as Record<string, unknown>
    )) {
      if (isCredentialShapedKey(key)) {
        keys.add(key);
      }
      collectCredentialShapedKeys(nested, keys);
    }
  }
}

/**
 * Payload hygiene (Issue #742 security requirement: "Payloads are
 * minimized and schema-validated; secrets, credentials, raw tokens, and
 * unnecessary PII are prohibited"). Two checks, both write-time HARD
 * REJECTIONS (never persisted, not silently redacted-then-stored):
 *
 * 1. A credential-shaped KEY name (`password`/`token`/`apiKey`/`secret`/
 *    `credential`/`authorization`) — narrower than `_shared/redaction.ts`'s
 *    `findSensitiveKeys`, see `CREDENTIAL_KEY_SUBSTRINGS`'s own comment for
 *    why ordinary PII key names are deliberately NOT included here.
 * 2. A credential-SHAPED value regardless of key name — reuses
 *    `_shared/redaction.ts`'s `findSecretShapedValues` (Issue #516/PR
 *    #712) unchanged: a JWT/PEM key/AWS key id/Bearer header/connection-
 *    string credential is never legitimate in an event payload, whatever
 *    it's called.
 *
 * Ordinary PII (email/phone/NPWP/NIK/WhatsApp) is NOT rejected here — it
 * is masked on READ by `payload-redaction.ts`'s `redactEventPayloadForResponse`
 * (full `REDACTION_KEYS`-based) for admin/API inspection responses, while
 * the raw value stays available to a consumer `handler` that genuinely
 * needs it.
 */
export function validateDomainEventPayload(
  payload: unknown
): DomainEventPayloadValidationResult {
  const errors: string[] = [];

  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return { valid: false, errors: ["payload must be a JSON object."] };
  }

  const record = payload as Record<string, unknown>;
  const serializedSize = Buffer.byteLength(JSON.stringify(record), "utf8");

  if (serializedSize > DOMAIN_EVENT_PAYLOAD_MAX_BYTES) {
    errors.push(
      `payload exceeds the ${DOMAIN_EVENT_PAYLOAD_MAX_BYTES}-byte limit (${serializedSize} bytes) — minimize the payload, do not embed derived/joinable data.`
    );
  }

  const credentialKeys = new Set<string>();
  collectCredentialShapedKeys(record, credentialKeys);

  if (credentialKeys.size > 0) {
    errors.push(
      `payload contains credential-shaped key name(s): ${[...credentialKeys].join(", ")}.`
    );
  }

  const secretShapedPaths = findSecretShapedValues(record);
  if (secretShapedPaths.length > 0) {
    errors.push(
      `payload contains credential-shaped value(s) at: ${secretShapedPaths.join(", ")}.`
    );
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

export function isValidEventType(eventType: string): boolean {
  return EVENT_TYPE_PATTERN.test(eventType);
}

export function isValidEventVersion(eventVersion: string): boolean {
  return EVENT_VERSION_PATTERN.test(eventVersion);
}

/**
 * The default explicit ordering key when a producer does not supply one —
 * `aggregate_type:aggregate_id`, i.e. "this aggregate's own history is
 * strictly ordered." A producer MAY override this (e.g. to order by a
 * coarser key shared across several aggregates that must not interleave,
 * such as a single external account id spanning several documents) but
 * never needs to for the common case.
 */
export function deriveOrderKey(
  aggregateType: string,
  aggregateId: string
): string {
  return `${aggregateType}:${aggregateId}`;
}

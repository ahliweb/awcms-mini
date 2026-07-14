/**
 * Capability port (ADR-0011) — Issue #754 (`integration_hub`, epic
 * `platform-evolution` #738 Wave 3). Lets a provider-owning module (e.g. a
 * future `email` bounce-webhook handler, or `social_publishing`'s Meta/
 * Telegram inbound webhook) register its OWN signature-verification/
 * payload-normalization logic without `integration_hub` ever importing
 * that module's `application`/`domain` tree directly — the same
 * port/adapter separation `workflow-notification-port.ts`/
 * `social-publishing-port.ts` already establish for other cross-module
 * collaborations. Zero imports from any module (the ADR-0011 rule for
 * every file in this directory) — a pure TypeScript interface only.
 *
 * `integration_hub` PROVIDES this port (declares `capabilities.provides:
 * ["integration_adapter_registration"]` in its own `module.ts`) — it does
 * not consume anything. A concrete adapter implementing this interface is
 * registered into `integration_hub/infrastructure/adapter-registry.ts`'s
 * static array (reviewed source code, never a runtime/dynamic
 * registration — `docs/awcms-mini/21_module_admission_governance.md` §7).
 * This foundation issue ships exactly TWO self-contained FIXTURE adapters
 * (`fixture_hmac_sha256`, `fixture_shared_secret_nonce`) — no real business
 * provider integration, mirroring the accepted "foundation issue ships
 * zero real business integrations" precedent (#643, #742). A future
 * provider-owning module adds its own adapter object satisfying this
 * interface, and a reviewed one-line addition to the static registry array
 * — never a plugin upload, never `eval`/dynamic `import()` of tenant input.
 *
 * All functions here are PURE (no I/O, no network, no DB) — signature
 * verification is local HMAC comparison only; the actual DB write (persist
 * the inbound delivery row, enforce replay-protection via a unique
 * constraint) happens in `integration_hub`'s own `application/` layer,
 * never inside an adapter implementation.
 */

export type IntegrationAdapterDirection = "inbound" | "outbound" | "both";

/**
 * Coarse data-sensitivity classification, used only for admin/observability
 * display and `data_lifecycle` retention guidance — never itself an
 * authorization or masking mechanism (that stays `_shared/redaction.ts` +
 * ABAC, unaffected by this field).
 */
export type IntegrationAdapterDataSensitivity = "low" | "medium" | "high";

export type IntegrationInboundVerificationInput = {
  /** Exact raw request bytes (as received, before any JSON parsing) — every signature scheme in this repo signs the raw body, never a re-serialized parse (re-serialization can silently change byte-for-byte content: key order, whitespace, escaping). */
  rawBody: string;
  /** Lower-cased header names, exactly as received. Never mutated by a verifier. */
  headers: Readonly<Record<string, string>>;
  /** Resolved from the endpoint's `secret_reference` (an `env:VAR_NAME` pointer, never persisted/logged as plaintext) — the actual secret VALUE, already resolved by the caller. Never logged. */
  secret: string;
  /** Resolved from the endpoint's `secret_reference_previous`, when key rotation with overlap is in progress and `now` is still within the overlap window. `null` when no rotation is in progress. */
  previousSecret?: string | null;
  toleranceSeconds: number;
  now: Date;
};

export type IntegrationInboundVerificationResult =
  | {
      valid: true;
      /**
       * The dedup key persisted into the DB unique constraint
       * `(tenant_id, endpoint_id, replay_key)` — item #3 of Issue #754's
       * critical checklist: replay protection MUST be a real DB uniqueness
       * constraint, never only an in-memory check. A verifier derives this
       * from a provider-supplied delivery id when the scheme carries one,
       * or from an explicit nonce header, or (last resort) from a stable
       * hash of the signature+timestamp — see each fixture adapter's own
       * doc comment for which strategy it uses.
       */
      replayKey: string;
      /** Provider's own delivery/message id, when the scheme carries one — stored for operator troubleshooting, distinct from `replayKey` (which may derive from it but is not always identical). */
      providerDeliveryId?: string;
      usedPreviousSecret?: boolean;
    }
  | {
      valid: false;
      /** A bounded, non-free-text reason code (never raw header/signature values) — safe for metrics labels and audit records (Issue #754: "low-cardinality metrics for verification failures by bounded reason"). */
      reason:
        | "missing_signature_header"
        | "missing_timestamp_header"
        | "malformed_signature"
        | "signature_mismatch"
        | "timestamp_out_of_tolerance"
        | "missing_replay_key";
    };

export type IntegrationNormalizedInboundMessage = {
  /** Maps to a `domain_event_runtime` event type this hub is registered to publish — never an arbitrary caller-supplied string (Issue #754 security requirement: "No inbound payload can select ... internal event type outside the reviewed descriptor"). */
  eventType: string;
  eventVersion: string;
  payload: Record<string, unknown>;
};

export type IntegrationNormalizationResult =
  | { ok: true; message: IntegrationNormalizedInboundMessage }
  | { ok: false; reason: string };

export type IntegrationAdapterHealthCheckResult =
  | { state: "up" }
  | { state: "degraded"; reason: string }
  | { state: "down"; reason: string };

/**
 * One provider/adapter descriptor + verification/normalization logic,
 * contributed by a reviewed source-code registry entry (never a database
 * row, never tenant-controlled — `docs/awcms-mini/21_module_admission_
 * governance.md` §7). `verifyInbound`/`normalizeInbound` are optional
 * because an `direction: "outbound"`-only adapter (e.g. a future real
 * outbound-only provider) never receives inbound webhooks.
 */
export type IntegrationAdapterPort = {
  /** Stable, unique key across the whole registry, e.g. `"fixture_hmac_sha256"`. Used as the DB `adapter_key` value on endpoints/subscriptions/health rows. */
  readonly adapterKey: string;
  readonly displayName: string;
  readonly direction: IntegrationAdapterDirection;
  readonly dataSensitivity: IntegrationAdapterDataSensitivity;
  /** Bound for any operation this adapter is involved in (outbound HTTP call timeout, etc.) — documentation/default only, the actual bound is still enforced by the caller (`withTimeout`). */
  readonly defaultTimeoutMs: number;
  /** `"retryable_network_provider"` — transient failures should be retried with backoff (the common case). `"manual_only"` — a failure here should never auto-retry (reserved for a future adapter kind whose side effects are not safely re-playable; no adapter in this foundation issue uses this value). */
  readonly retryClassification: "retryable_network_provider" | "manual_only";
  verifyInbound?(
    input: IntegrationInboundVerificationInput
  ): IntegrationInboundVerificationResult;
  normalizeInbound?(
    rawBody: string,
    headers: Readonly<Record<string, string>>
  ): IntegrationNormalizationResult;
};

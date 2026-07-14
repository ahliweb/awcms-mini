import type { IntegrationAdapterPort } from "../../_shared/ports/integration-adapter-port";
import {
  verifyFixtureHmacSha256,
  verifyFixtureSharedSecretNonce
} from "../domain/fixture-signature-schemes";

/**
 * Static, reviewed-source-code adapter registry (Issue #754,
 * `docs/awcms-mini/21_module_admission_governance.md` §7 — no runtime
 * plugin loading, ever). Exactly THREE entries in this foundation issue —
 * two self-contained inbound FIXTURE signature schemes (proving the
 * generic verification/replay-protection mechanism end-to-end, Issue #754
 * acceptance criterion: "At least two fixture signature schemes verify
 * valid messages and reject modified body, stale timestamp, reused nonce,
 * and wrong tenant/endpoint") and one generic outbound HTTP adapter
 * descriptor (the "generic HTTP fixture" the SSRF acceptance criterion
 * names) — mirroring the accepted "foundation issue ships zero real
 * business integrations" precedent (#643, #742). A future provider-owning
 * module (e.g. `email` bounce webhooks, `social_publishing` inbound Meta/
 * Telegram webhooks) adds its OWN `IntegrationAdapterPort` object here via
 * a reviewed one-line addition — this hub never imports that module's
 * `application`/`domain` tree to do so (the port interface, defined in
 * `_shared`, is the only contract crossed).
 */
export const FIXTURE_HMAC_SHA256_ADAPTER_KEY = "fixture_hmac_sha256";
export const FIXTURE_SHARED_SECRET_NONCE_ADAPTER_KEY =
  "fixture_shared_secret_nonce";
export const GENERIC_HTTP_WEBHOOK_ADAPTER_KEY = "generic_http_webhook";

const fixtureHmacSha256Adapter: IntegrationAdapterPort = {
  adapterKey: FIXTURE_HMAC_SHA256_ADAPTER_KEY,
  displayName: "Fixture: HMAC-SHA256 (delivery-id replay key)",
  direction: "inbound",
  dataSensitivity: "low",
  defaultTimeoutMs: 10_000,
  retryClassification: "retryable_network_provider",
  verifyInbound: verifyFixtureHmacSha256
};

const fixtureSharedSecretNonceAdapter: IntegrationAdapterPort = {
  adapterKey: FIXTURE_SHARED_SECRET_NONCE_ADAPTER_KEY,
  displayName: "Fixture: shared-secret + nonce (body-digest signed)",
  direction: "inbound",
  dataSensitivity: "low",
  defaultTimeoutMs: 10_000,
  retryClassification: "retryable_network_provider",
  verifyInbound: verifyFixtureSharedSecretNonce
};

/** Outbound-only descriptor — no `verifyInbound`/`normalizeInbound` (this adapter never receives webhooks). Real delivery logic (SSRF-guarded `fetch`) lives in `infrastructure/outbound-http-client.ts`, not on this descriptor — the descriptor is metadata only, matching every other entry here. */
const genericHttpWebhookAdapter: IntegrationAdapterPort = {
  adapterKey: GENERIC_HTTP_WEBHOOK_ADAPTER_KEY,
  displayName: "Generic HTTP webhook (SSRF-guarded)",
  direction: "outbound",
  dataSensitivity: "medium",
  defaultTimeoutMs: 10_000,
  retryClassification: "retryable_network_provider"
};

export const INTEGRATION_ADAPTERS: readonly IntegrationAdapterPort[] = [
  fixtureHmacSha256Adapter,
  fixtureSharedSecretNonceAdapter,
  genericHttpWebhookAdapter
];

export function getIntegrationAdapterByKey(
  adapterKey: string
): IntegrationAdapterPort | undefined {
  return INTEGRATION_ADAPTERS.find(
    (adapter) => adapter.adapterKey === adapterKey
  );
}

export function listInboundIntegrationAdapters(): readonly IntegrationAdapterPort[] {
  return INTEGRATION_ADAPTERS.filter(
    (adapter) => adapter.direction === "inbound" || adapter.direction === "both"
  );
}

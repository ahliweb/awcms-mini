/**
 * "provider-outage-sso-discovery" scenario (Issue #699). Reuses the REAL
 * SSO discovery function (`src/lib/auth/generic-oidc-client.ts`'s
 * `discoverOidcConfiguration`, Issue #591/#610) — no fake HTTP server, no
 * mocked timeout: this calls the exact function
 * `GET /api/v1/auth/sso/{providerKey}/start` calls, pointed at a
 * guaranteed-unreachable local address (`127.0.0.1:1` — a port nothing
 * ever listens on, so the OS fails the connection immediately, without a
 * real network round trip or any wall-clock wait).
 *
 * Represents the "partial SSO failure" scope item from the issue: an
 * outage in a tenant's SSO IdP must fail fast and boundedly rather than
 * hanging or crashing — proving the SAME provider-isolation contract
 * (bounded timeout + circuit breaker, ADR-0006-equivalent for a
 * synchronous provider call rather than an outbox one) that keeps a
 * broken SSO provider from ever blocking the REST of the app, including
 * ordinary email/password login on the very same tenant.
 *
 * Phases:
 * - Setup: a fresh random tenant/provider key pair, so this scenario's
 *   circuit-breaker/cache entries never collide with any real tenant's.
 * - Execute: `discoverOidcConfiguration` against the unreachable issuer.
 * - Verify: the call resolves (never throws) with `{ ok: false }`, and
 *   resolves fast — well under its own configured discovery timeout
 *   (default 5000ms, `AUTH_SSO_DISCOVERY_TIMEOUT_MS`) since a loopback
 *   connection refusal is near-instant, not a real timeout expiry. The
 *   measured latency is this scenario's RTO-like metric for "how long a
 *   caller is blocked before an unreachable SSO IdP call gives up".
 * - Cleanup: none — no DB row, no file, no persistent state; the
 *   in-process circuit-breaker/cache entries are scoped to this run's
 *   random tenant/provider key and never reused.
 */
import { discoverOidcConfiguration } from "../../auth/generic-oidc-client";
import { resolveSsoDiscoveryTimeoutMs } from "../../auth/sso-config";
import type { ScenarioDefinition, ScenarioOutcome } from "../scenario-runner";

/** A port nothing listens on — guarantees an immediate ECONNREFUSED, never a real network wait. */
const UNREACHABLE_ISSUER = "http://127.0.0.1:1";

export function ssoDiscoveryOutageScenario(): ScenarioDefinition {
  return {
    name: "provider-outage-sso-discovery",
    tier: "safe",
    timeoutMs: 10_000,
    async run(ctx): Promise<ScenarioOutcome> {
      const tenantId = crypto.randomUUID();
      const providerKey = `dr-drill-${crypto.randomUUID().slice(0, 8)}`;
      const configuredTimeoutMs = resolveSsoDiscoveryTimeoutMs(ctx.env);

      const start = performance.now();
      const result = await discoverOidcConfiguration(
        tenantId,
        providerKey,
        UNREACHABLE_ISSUER,
        ctx.env
      );
      const failureLatencyMs = performance.now() - start;

      if (result.ok) {
        return {
          ok: false,
          detail:
            "Discovery against a guaranteed-unreachable issuer unexpectedly succeeded."
        };
      }

      if (failureLatencyMs > configuredTimeoutMs) {
        return {
          ok: false,
          detail:
            `Discovery took ${failureLatencyMs.toFixed(0)}ms to fail — expected a ` +
            `fast connection-refused failure well under its configured ` +
            `${configuredTimeoutMs}ms timeout.`
        };
      }

      return {
        ok: true,
        detail:
          `SSO discovery against an unreachable issuer failed fast ` +
          `(${failureLatencyMs.toFixed(0)}ms, well under its ${configuredTimeoutMs}ms ` +
          "configured timeout) without throwing — a down SSO IdP cannot hang " +
          "or crash the caller, leaving local/password login on the same " +
          "tenant unaffected.",
        metrics: { failureLatencyMs: Number(failureLatencyMs.toFixed(1)) }
      };
    }
  };
}

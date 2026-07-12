import type { SocialProviderAdapter } from "../domain/social-provider-adapter";

/**
 * Module-level singleton registry (Issue #643) — mirrors
 * `src/lib/database/circuit-breaker.ts`'s `providerCircuitBreakers` map
 * shape (one shared registry per process, not per-request/per-tenant).
 *
 * Starts EMPTY. This foundation issue registers zero real adapters — no
 * Meta/LinkedIn/Telegram HTTP call exists anywhere in this module. Future
 * adapter issues (#644 Meta, #645 LinkedIn, #646 Telegram) call
 * `registerSocialProviderAdapter` from their own composition root (a
 * script or module init, not from inside `application`/`domain` — same
 * "registration is a composition-root concern" convention this repo
 * already applies to `setLogSink`/`setAuditExportHook`).
 *
 * A job whose `provider_key` has no registered adapter is NOT silently
 * skipped forever — the dispatcher
 * (`application/social-publish-dispatch.ts`) treats "no adapter registered"
 * as a terminal `failed` outcome with `errorCode: "provider_not_registered"`
 * (not retryable), and `scripts/security-readiness.ts`'s
 * `checkSocialPublishingProviderReadiness` fails readiness for any
 * deployment with a `connected` account whose `provider_key` has no
 * adapter registered — "Readiness check fails if enabled provider is
 * missing required credentials/scopes" (issue acceptance criterion).
 */
const registry = new Map<string, SocialProviderAdapter>();

export function registerSocialProviderAdapter(
  adapter: SocialProviderAdapter
): void {
  registry.set(adapter.providerKey, adapter);
}

export function getSocialProviderAdapter(
  providerKey: string
): SocialProviderAdapter | undefined {
  return registry.get(providerKey);
}

export function listRegisteredSocialProviderKeys(): string[] {
  return Array.from(registry.keys());
}

/** Test-only escape hatch — clears every registered adapter. Never called by production code. */
export function resetSocialProviderRegistryForTests(): void {
  registry.clear();
}

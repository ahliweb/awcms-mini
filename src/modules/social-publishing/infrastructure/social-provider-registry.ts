import type { SocialProviderAdapter } from "../domain/social-provider-adapter";
import { createMetaFacebookPageAdapter } from "./meta/meta-facebook-page-adapter";
import { createMetaInstagramAdapter } from "./meta/meta-instagram-adapter";

/**
 * Module-level singleton registry (Issue #643) — mirrors
 * `src/lib/database/circuit-breaker.ts`'s `providerCircuitBreakers` map
 * shape (one shared registry per process, not per-request/per-tenant).
 *
 * Started EMPTY at Issue #643 (foundation) — no Meta/LinkedIn/Telegram
 * HTTP call existed anywhere in this module yet. Issue #644 (Meta) is the
 * first to populate it (see the registration block at the bottom of this
 * file); #645 (LinkedIn) and #646 (Telegram) each call
 * `registerSocialProviderAdapter` from their own composition root the
 * same way (a script or module init, not from inside `application`/
 * `domain` — same "registration is a composition-root concern"
 * convention this repo already applies to `setLogSink`/
 * `setAuditExportHook`).
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

// ---------------------------------------------------------------------------
// Adapter registrations (composition-root wiring). Each adapter issue
// (#644 Meta, #645 LinkedIn, #646 Telegram) appends its own import + call
// here — keep each addition to exactly this shape (one import, one
// `registerSocialProviderAdapter(createXxxAdapter())` call) so three
// parallel adapter PRs touching this same block stay trivial to merge;
// never restructure the registry above for this. Registering an adapter
// here is always side-effect-safe and cannot throw — every adapter factory
// only reads `process.env` lazily inside `publish`/`verifyCredentials`,
// never at construction time, so a deployment that never configures a
// given provider is unaffected by it being registered.
registerSocialProviderAdapter(createMetaFacebookPageAdapter());
registerSocialProviderAdapter(createMetaInstagramAdapter());

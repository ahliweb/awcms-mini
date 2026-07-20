/**
 * The static, reviewed-source-code registry of payment provider adapters (Issue
 * #877) — same shape as `integration-hub/infrastructure/adapter-registry.ts` and
 * `domain-event-runtime/infrastructure/consumer-registry.ts`. There is NO
 * runtime discovery / upload / `eval` (doc 21 §7 / ADR-0012 §7): the set of
 * adapters is the compile-time union declared here.
 *
 * The base repo registers ONLY the fake/sandbox adapter. A derived application
 * adds its own REAL provider adapter by calling `registerPaymentProviderAdapter`
 * from its composition wiring (imported via `src/modules/application-registry.ts`
 * bootstrap) — never by editing this file. An unknown provider key resolves to
 * `null` and every caller fails CLOSED (a webhook/dispatch for an unregistered
 * provider is rejected/deferred, never silently trusted).
 */
import type { PaymentProviderAdapter } from "../domain/provider-adapter";
import { sandboxAdapter, SANDBOX_PROVIDER_KEY } from "./sandbox-adapter";

const ADAPTERS = new Map<string, PaymentProviderAdapter>();

export function registerPaymentProviderAdapter(
  adapter: PaymentProviderAdapter
): void {
  ADAPTERS.set(adapter.key, adapter);
}

export function getPaymentProviderAdapter(
  providerKey: string
): PaymentProviderAdapter | null {
  return ADAPTERS.get(providerKey) ?? null;
}

export function listPaymentProviderKeys(): string[] {
  return [...ADAPTERS.keys()];
}

// The base repo's single built-in adapter (test/documentation only).
registerPaymentProviderAdapter(sandboxAdapter);

export { SANDBOX_PROVIDER_KEY };

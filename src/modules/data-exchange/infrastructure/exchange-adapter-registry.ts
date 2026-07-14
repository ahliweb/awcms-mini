/**
 * Static exchange-adapter registry (Issue #752) — same shape as
 * `domain-event-runtime/infrastructure/consumer-registry.ts`'s
 * `DOMAIN_EVENT_CONSUMERS`: a reviewed-source-code list, never a
 * database-driven/dynamic registration. `ExchangeDescriptor.
 * adapterRegistryKey` (`_shared/module-contract.ts`) resolves through this
 * file to the REAL `DataExchangeAdapterPort`/`DataExchangeExportSourcePort`
 * implementation.
 *
 * Ships exactly ONE entry today — `reference_items`, this module's own
 * self-contained fixture (`application/reference-items-exchange-adapter.ts`)
 * — proving the mechanism end-to-end without importing another module's
 * `application`/`domain` code (ADR-0017 §10). A REAL owning module
 * registers its own entry here when it starts using this mechanism, by
 * importing its adapter from `<module>/application/*-data-exchange-
 * adapter.ts` — a one-directional `data_exchange -> <owning module>`
 * `infrastructure` import, which `tests/unit/module-boundary-cycles.test.ts`
 * only flags if it becomes a CYCLE (the owning module importing
 * `data_exchange`'s `application`/`domain` code back), which no adapter
 * needs to do (adapters only implement the port type from `_shared/
 * ports/`, they never call back into `data_exchange`'s own internals).
 */
import type {
  DataExchangeAdapterPort,
  DataExchangeExportSourcePort
} from "../../_shared/ports/data-exchange-adapter-port";
import {
  referenceItemsExportAdapter,
  referenceItemsImportAdapter
} from "../application/reference-items-exchange-adapter";

export type ExchangeAdapterRegistration = {
  registryKey: string;
  importAdapter?: DataExchangeAdapterPort;
  exportAdapter?: DataExchangeExportSourcePort;
};

const BASE_ADAPTER_REGISTRATIONS: readonly ExchangeAdapterRegistration[] = [
  {
    registryKey: "reference_items",
    importAdapter: referenceItemsImportAdapter,
    exportAdapter: referenceItemsExportAdapter
  }
];

/** `export let` (not `const`) so test-only helpers below can register a fake adapter for a single test's duration — same test-injection shape `DOMAIN_EVENT_CONSUMERS` establishes. */
export let EXCHANGE_ADAPTER_REGISTRATIONS: readonly ExchangeAdapterRegistration[] =
  BASE_ADAPTER_REGISTRATIONS;

export function registerExchangeAdapterForTests(
  registration: ExchangeAdapterRegistration
): void {
  EXCHANGE_ADAPTER_REGISTRATIONS = [
    ...EXCHANGE_ADAPTER_REGISTRATIONS,
    registration
  ];
}

export function resetExchangeAdaptersForTests(): void {
  EXCHANGE_ADAPTER_REGISTRATIONS = BASE_ADAPTER_REGISTRATIONS;
}

/**
 * `findLast`, not `find` — a test-only registration appended via
 * `registerExchangeAdapterForTests` for an ALREADY-registered `registryKey`
 * (e.g. a flaky/fault-injecting fixture standing in for `reference_items`
 * for one test's duration) must shadow the base entry, not be silently
 * shadowed BY it. Production code only ever appends each `registryKey`
 * once (`BASE_ADAPTER_REGISTRATIONS`), so this has no effect outside tests.
 */
export function resolveImportAdapter(
  registryKey: string
): DataExchangeAdapterPort | null {
  return (
    EXCHANGE_ADAPTER_REGISTRATIONS.findLast(
      (entry) => entry.registryKey === registryKey
    )?.importAdapter ?? null
  );
}

export function resolveExportAdapter(
  registryKey: string
): DataExchangeExportSourcePort | null {
  return (
    EXCHANGE_ADAPTER_REGISTRATIONS.findLast(
      (entry) => entry.registryKey === registryKey
    )?.exportAdapter ?? null
  );
}

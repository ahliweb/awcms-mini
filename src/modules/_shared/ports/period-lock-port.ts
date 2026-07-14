/**
 * `PeriodLockPort` (Issue #755, epic #738 `platform-evolution` Wave 4,
 * ADR-0019 — ERP extension readiness contracts). A generic-accounting-period
 * "may this business transaction be posted/reversed right now" query
 * capability that a future ERP extension (implemented OUTSIDE this base
 * repository, per ADR-0019) implements and a posting-capable caller (also
 * living in the ERP extension, never in Core/System) consults BEFORE
 * accepting a posting/reversal request.
 *
 * This base repository ships NO real period-lock adapter and NO chart of
 * accounts/ledger/period table — "period lock" here is a pure capability
 * SHAPE, same "port defined ahead of any base-shipped adapter" precedent
 * `legal-hold-guard-port.ts`/`party-directory-port.ts` already established,
 * except this port has no base implementation at all (not even a flat
 * default), because the very CONCEPT of an accounting period belongs
 * entirely to the ERP extension (ADR-0019 explicitly excludes chart of
 * accounts/journal/period tables from the base).
 *
 * **Fail-closed is mandatory** (Issue #755 security requirement: "Period
 * lock and posting authorization are default-deny when the capability is
 * unavailable or ambiguous for a required operation"). `checked: false`
 * means the caller COULD NOT determine whether the period is locked (no
 * adapter wired, adapter errored, ambiguous scope) — a caller MUST treat
 * this identically to `locked: true` for a `"post"`/`"reverse"` operation.
 * `NO_PERIOD_LOCK_ADAPTER_CONFIGURED` below is the explicit, always-safe
 * default a composition root wires when no ERP extension is composed —
 * it never silently permits posting; it always reports `checked: false`.
 *
 * **Not an identity/RLS boundary** (Issue #755: "period lock ... does not
 * become an identity/RLS boundary"). This port answers a business-period
 * question only — it never substitutes for tenant RLS or ABAC permission
 * checks, which the caller must still enforce independently in every case
 * (defense in depth, same rule every other port in this repo already
 * follows).
 */

import type { BusinessScopeReference } from "./business-scope-hierarchy-port";

/**
 * `"post"` — a NEW business transaction is being posted into `periodKey`.
 * `"reverse"` — a reversal/compensation is being posted (Issue #755
 * invariant: "corrections use reversal/compensation" — a reversal itself
 * still requires an open period to land in, distinct from re-opening or
 * mutating the ORIGINAL posted transaction, which is never permitted
 * regardless of lock state).
 */
export type PeriodLockOperation = "post" | "reverse";

export type PeriodLockCheckResult =
  | { checked: true; locked: false }
  | { checked: true; locked: true; reason: string }
  /** Capability unavailable, ambiguous, or errored — caller MUST fail closed (deny), never treat this as "unlocked". */
  | { checked: false; reason: string };

export type PeriodLockPort = {
  /**
   * `legalEntityScope` — `null` means "tenant-level, no legal-entity/
   * organization-unit scoping applies" (Issue #755: tenant remains the
   * security boundary; legal entity is a business scope only, resolved the
   * same way `BusinessScopeHierarchyPort` already resolves one, never a
   * second identity boundary). `periodKey` is an opaque, ERP-extension-
   * owned string (e.g. `"2026-07"` for a calendar month, or a fiscal-period
   * code) — this port never interprets its format, only passes it through.
   */
  checkPeriodLock(
    tx: Bun.SQL,
    tenantId: string,
    legalEntityScope: BusinessScopeReference | null,
    periodKey: string,
    operation: PeriodLockOperation
  ): Promise<PeriodLockCheckResult>;
};

/**
 * The ONLY period-lock "adapter" this base repository ships — always
 * reports `checked: false` (never `locked: false`). A composition root
 * that has not composed any ERP extension wires THIS, so any posting-
 * capable code path that (incorrectly) ships inside the base would fail
 * closed rather than silently permitting posting. A real ERP extension
 * replaces this with its own adapter backed by its own period/fiscal-
 * calendar tables.
 */
export const noPeriodLockAdapterConfigured: PeriodLockPort = {
  async checkPeriodLock(): Promise<PeriodLockCheckResult> {
    return {
      checked: false,
      reason:
        "no period-lock capability configured — no ERP extension composed this adapter."
    };
  }
};

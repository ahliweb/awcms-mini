/**
 * Fixture-only reference posting engine (Issue #755, ADR-0019) — proves
 * `_shared/business-transaction-contract.ts`'s
 * `AccountingPostingRequestPayload`/`AccountingPostingResultPayload`
 * invariants and `_shared/ports/period-lock-port.ts`'s fail-closed
 * contract are actually implementable and machine-verifiable, WITHOUT any
 * real accounting/ledger logic (no debit/credit balancing, no chart of
 * accounts — ADR-0019's explicit base exclusions apply here too; this is
 * illustration-only fixture code, not a template for a real posting
 * engine's business rules).
 *
 * Pure, synchronous-per-call, in-memory (a `Map` keyed by `requestId`
 * stands in for a real extension's own durable ledger table) — no
 * database, no network. Enforces, in order:
 *
 * 1. **Idempotency** (invariant 3, `business-transaction-contract.ts`) —
 *    a `requestId` already recorded returns the SAME stored result,
 *    never re-evaluates/re-posts.
 * 2. **Cross-tenant/legal-entity mismatch rejection** (Issue #755
 *    security requirement: "Cross-tenant/legal-entity reference mismatches
 *    are rejected") — the request's own `tenantId` (passed by the caller,
 *    representing the AUTHENTICATED tenant context) must match
 *    `transaction.tenantId` exactly; `legalEntityScope`, when present,
 *    must resolve for that SAME tenant (this fixture models "resolves"
 *    with a simple caller-supplied resolver function standing in for a
 *    real `BusinessScopeHierarchyPort.resolveScope` call).
 * 3. **Period lock, fail-closed** (Issue #755: "Period lock ... fails
 *    closed for posting") — `checked: false` OR `locked: true` both
 *    reject the request; only `checked: true, locked: false` proceeds.
 * 4. **Reversal is a NEW posted transaction, never a mutation** (invariant
 *    2) — a request carrying `reversalOfExternalTransactionId` requires
 *    the referenced original to already be `"posted"` in this same engine
 *    instance; the original's own stored result is never touched.
 */
import type {
  AccountingPostingRequestPayload,
  AccountingPostingResultPayload
} from "../../../../../src/modules/_shared/business-transaction-contract";
import type { PeriodLockPort } from "../../../../../src/modules/_shared/ports/period-lock-port";
import type { BusinessScopeReference } from "../../../../../src/modules/_shared/ports/business-scope-hierarchy-port";

/** Stands in for a real `BusinessScopeHierarchyPort.resolveScope` call — returns whether `scope` genuinely belongs to `tenantId`. */
export type LegalEntityScopeResolver = (
  tenantId: string,
  scope: BusinessScopeReference
) => Promise<boolean>;

export class FixturePostingEngine {
  private readonly resultsByRequestId = new Map<
    string,
    AccountingPostingResultPayload
  >();

  constructor(
    private readonly periodLockPort: PeriodLockPort,
    private readonly resolveLegalEntityScope: LegalEntityScopeResolver
  ) {}

  /** Read-only lookup for tests/callers — never mutated from outside `submitPostingRequest`. */
  getStoredResult(
    requestId: string
  ): AccountingPostingResultPayload | undefined {
    return this.resultsByRequestId.get(requestId);
  }

  async submitPostingRequest(
    tx: Bun.SQL,
    authenticatedTenantId: string,
    request: AccountingPostingRequestPayload
  ): Promise<AccountingPostingResultPayload> {
    const existing = this.resultsByRequestId.get(request.requestId);
    if (existing) {
      return existing;
    }

    const result = await this.evaluatePostingRequest(
      tx,
      authenticatedTenantId,
      request
    );
    this.resultsByRequestId.set(request.requestId, result);
    return result;
  }

  private async evaluatePostingRequest(
    tx: Bun.SQL,
    authenticatedTenantId: string,
    request: AccountingPostingRequestPayload
  ): Promise<AccountingPostingResultPayload> {
    const { transaction } = request;

    if (transaction.tenantId !== authenticatedTenantId) {
      return this.rejected(
        request,
        "tenant mismatch: transaction.tenantId does not match the authenticated tenant context."
      );
    }

    if (transaction.legalEntityScope) {
      const resolved = await this.resolveLegalEntityScope(
        authenticatedTenantId,
        transaction.legalEntityScope
      );
      if (!resolved) {
        return this.rejected(
          request,
          "legal-entity scope mismatch: the referenced scope does not resolve for this tenant."
        );
      }
    }

    if (request.reversalOfExternalTransactionId) {
      const original = this.resultsByRequestId.get(
        request.reversalOfExternalTransactionId
      );
      if (!original || original.status !== "posted") {
        return this.rejected(
          request,
          "reversal target is not a posted transaction known to this engine."
        );
      }
    }

    const operation = request.reversalOfExternalTransactionId
      ? "reverse"
      : "post";
    const lockCheck = await this.periodLockPort.checkPeriodLock(
      tx,
      authenticatedTenantId,
      transaction.legalEntityScope,
      request.periodKey,
      operation
    );

    if (!lockCheck.checked) {
      return this.rejected(
        request,
        `period-lock capability unavailable — failing closed (${lockCheck.reason}).`
      );
    }
    if (lockCheck.locked) {
      return this.rejected(request, lockCheck.reason);
    }

    const postedAt = new Date().toISOString();
    return {
      requestId: request.requestId,
      transaction: { ...transaction, status: "posted" },
      status: request.reversalOfExternalTransactionId ? "reversed" : "posted",
      postedAt,
      ledgerReference: `fixture-ledger:${request.requestId}`
    };
  }

  private rejected(
    request: AccountingPostingRequestPayload,
    reason: string
  ): AccountingPostingResultPayload {
    return {
      requestId: request.requestId,
      transaction: { ...request.transaction, status: "rejected" },
      status: "rejected",
      rejectionReason: reason
    };
  }
}

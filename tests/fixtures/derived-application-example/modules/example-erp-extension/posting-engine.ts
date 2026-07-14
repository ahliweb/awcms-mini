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
 * Pure, synchronous-per-call, in-memory (two `Map`s stand in for a real
 * extension's own durable ledger table) — no database, no network.
 * Enforces, in order:
 *
 * 1. **Idempotency by `requestId`** (invariant 3, `business-transaction-
 *    contract.ts`) — a `requestId` already recorded returns the SAME
 *    stored result, never re-evaluates/re-posts.
 * 2. **Cross-tenant/legal-entity mismatch rejection** (Issue #755
 *    security requirement: "Cross-tenant/legal-entity reference mismatches
 *    are rejected") — the request's own `tenantId` (passed by the caller,
 *    representing the AUTHENTICATED tenant context) must match
 *    `transaction.tenantId` exactly; `legalEntityScope`, when present,
 *    must resolve for that SAME tenant (this fixture models "resolves"
 *    with a simple caller-supplied resolver function standing in for a
 *    real `BusinessScopeHierarchyPort.resolveScope` call).
 * 3. **Duplicate-post rejection by business-transaction identity**
 *    (invariants 1/2, `business-transaction-contract.ts`) — a plain
 *    (non-reversal) posting request whose `(tenantId, transactionType,
 *    externalTransactionId)` already has a posted/reversed ledger entry
 *    is rejected, EVEN under a brand-new `requestId` — `requestId`-only
 *    idempotency (step 1) is not sufficient by itself; a caller must not
 *    be able to double-post the same real-world business object merely by
 *    minting a new `requestId`.
 * 4. **Reversal target resolution, tenant/legal-entity-scoped** (Issue
 *    #755 security-auditor finding, High, fixed here) — a reversal is
 *    looked up by `(tenantId, transactionType, reversalOfExternalTransactionId)`
 *    — the SAME ID space `business-transaction-contract.ts` documents for
 *    `reversalOfExternalTransactionId` (the original's `externalTransactionId`,
 *    NEVER a `requestId`) — scoped to the AUTHENTICATED tenant, so a
 *    reversal request can never resolve a target that belongs to a
 *    different tenant, even one whose `externalTransactionId`/`requestId`
 *    an attacker has observed or guessed. The resolved original's own
 *    `tenantId`/`legalEntityScope` are re-verified explicitly (defense in
 *    depth, not solely relying on the lookup key's own scoping) before the
 *    reversal is allowed to proceed.
 * 5. **Period lock, fail-closed** (Issue #755: "Period lock ... fails
 *    closed for posting") — `checked: false` OR `locked: true` both
 *    reject the request; only `checked: true, locked: false` proceeds.
 * 6. **Reversal is a NEW posted transaction, never a mutation** (invariant
 *    2) — the original's own stored result/ledger entry is never touched
 *    by a reversal; the reversal itself is a distinct business
 *    transaction (its own `externalTransactionId`) that merely references
 *    the original via `reversalOfExternalTransactionId`.
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

/**
 * The ONLY key a duplicate-post check or a reversal-target lookup may use
 * — always tenant-scoped, never derived from (or looked up via) a
 * `requestId`, which is a caller-side retry identifier unrelated to the
 * business transaction's own identity.
 */
function transactionLedgerKey(
  tenantId: string,
  transactionType: string,
  externalTransactionId: string
): string {
  return `${tenantId}::${transactionType}::${externalTransactionId}`;
}

function legalEntityScopesMatch(
  a: BusinessScopeReference | null,
  b: BusinessScopeReference | null
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.scopeType === b.scopeType && a.scopeId === b.scopeId;
}

export class FixturePostingEngine {
  private readonly resultsByRequestId = new Map<
    string,
    AccountingPostingResultPayload
  >();

  /**
   * Indexed by `transactionLedgerKey(tenantId, transactionType,
   * externalTransactionId)` — set ONLY when a request reaches `"posted"`/
   * `"reversed"`, never for a `"rejected"` result. This is the sole source
   * of truth for both the duplicate-post check and reversal-target
   * resolution; it is never keyed by `requestId`.
   */
  private readonly ledgerByTransactionKey = new Map<
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

    if (result.status === "posted" || result.status === "reversed") {
      this.ledgerByTransactionKey.set(
        transactionLedgerKey(
          authenticatedTenantId,
          request.transaction.transactionType,
          request.transaction.externalTransactionId
        ),
        result
      );
    }

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

    if (!request.reversalOfExternalTransactionId) {
      // Plain (non-reversal) post — reject a duplicate of an already
      // posted/reversed business transaction, independent of requestId
      // (invariants 1/2: posted immutable, corrections via reversal only
      // — a second forward post of the SAME externalTransactionId under a
      // new requestId would otherwise bypass both).
      const duplicateKey = transactionLedgerKey(
        authenticatedTenantId,
        transaction.transactionType,
        transaction.externalTransactionId
      );
      if (this.ledgerByTransactionKey.has(duplicateKey)) {
        return this.rejected(
          request,
          `duplicate posting: externalTransactionId "${transaction.externalTransactionId}" is already posted for this tenant — corrections must use a reversal request (reversalOfExternalTransactionId), never a second forward post.`
        );
      }
    } else {
      // Reversal — resolve the ORIGINAL by (tenantId, transactionType,
      // reversalOfExternalTransactionId), the SAME ID space
      // `reversalOfExternalTransactionId` is documented against
      // (business-transaction-contract.ts), scoped to the AUTHENTICATED
      // tenant. This can never resolve a different tenant's transaction —
      // the key itself is tenant-scoped — but the original's own
      // tenantId/legalEntityScope are still re-verified explicitly below
      // (defense in depth), rather than trusting the lookup key alone.
      const originalKey = transactionLedgerKey(
        authenticatedTenantId,
        transaction.transactionType,
        request.reversalOfExternalTransactionId
      );
      const original = this.ledgerByTransactionKey.get(originalKey);

      if (!original || original.status !== "posted") {
        return this.rejected(
          request,
          "reversal target is not a posted transaction known to this engine for this tenant."
        );
      }
      if (original.transaction.tenantId !== authenticatedTenantId) {
        return this.rejected(
          request,
          "reversal target tenant mismatch — the resolved original does not belong to the authenticated tenant."
        );
      }
      if (
        !legalEntityScopesMatch(
          original.transaction.legalEntityScope,
          transaction.legalEntityScope
        )
      ) {
        return this.rejected(
          request,
          "reversal target legal-entity scope mismatch — the reversal must reference the same legal-entity scope as the original posted transaction."
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

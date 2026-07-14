/**
 * Business transaction reference, lifecycle metadata, and accounting
 * posting request/result event-payload contracts (Issue #755, epic #738
 * `platform-evolution` Wave 4, ADR-0019 — ERP extension readiness
 * contracts). Pure DATA shapes — no behavior, no `Bun.SQL` parameter, same
 * "-contract.ts lives in `_shared/` root, not `_shared/ports/`" convention
 * `module-contract.ts`/`extension-manifest-contract.ts` already establish
 * (a `-port.ts` file always declares at least one async method an adapter
 * implements; this file never does).
 *
 * These types describe the SHAPE of a business transaction and its posting
 * request/result as they would ride inside a `domain_event_runtime`
 * (Issue #742) event envelope's `payload` — this base repository does not
 * itself publish or consume any event using these shapes (no base module
 * has a "business transaction" concept); an ERP extension's own event
 * types (e.g. `"<extension_key>.posting.requested"`) carry a payload
 * shaped like `AccountingPostingRequestPayload` and
 * `AccountingPostingResultPayload` below, letting any base tooling that
 * inspects event payload shapes (docs, contract tests) reason about them
 * structurally without the base depending on the extension's real event
 * type strings.
 *
 * **Binding invariants (ADR-0019, Issue #755 acceptance criteria) — every
 * ERP extension implementing this contract MUST uphold these:**
 *
 * 1. **Posted transactions are immutable.** Once `status` reaches
 *    `"posted"`, the extension never mutates that transaction's own
 *    posted fields in place — see invariant 2.
 * 2. **Corrections use reversal/compensation, never mutation.** Reversing
 *    a posted transaction means posting a NEW transaction referencing the
 *    original via `reversalOfExternalTransactionId` — the original's own
 *    record and result are never overwritten or deleted.
 * 3. **Posted-state uniqueness is keyed by business identity, not by
 *    `requestId`.** A compliant implementation MUST enforce uniqueness of
 *    `"posted"`/`"reversed"` state per `(tenantId, transactionType,
 *    externalTransactionId)`, independent of `requestId` — invariant 4's
 *    `requestId`-based idempotency alone is NOT sufficient: a caller
 *    minting a brand-new `requestId` for the SAME real-world business
 *    transaction (accidentally or adversarially) must still be rejected
 *    as a duplicate post, never accepted as an independent second
 *    posted entry. This is what makes invariants 1/2 actually hold in
 *    practice — an implementation that only deduplicates by `requestId`
 *    can be tricked into double-posting the same business object simply
 *    by varying the retry identifier (Issue #755 security-auditor
 *    finding, Medium).
 * 4. **Posting is idempotent and externally correlated.** The SAME
 *    `requestId` submitted more than once (worker retry, at-least-once
 *    redelivery) MUST produce the SAME result, never a duplicate posting
 *    — mirrors this repo's own `saveIdempotencyRecord` (`_shared/
 *    idempotency.ts`) discipline, applied here to accounting posting
 *    rather than an HTTP mutation. Complements, but never replaces,
 *    invariant 3's business-identity uniqueness.
 * 5. **Request acceptance is not equivalent to successful posting.** An
 *    `AccountingPostingResultPayload` with `status: "accepted"` only means
 *    the request was durably queued/validated — a caller MUST NOT treat
 *    acceptance as proof the transaction posted; only `status: "posted"`
 *    (or `"reversed"`) means the posting actually completed.
 * 6. **Source modules do not write ERP tables directly.** A base/System/
 *    Optional-Business-Foundation module never inserts into an ERP
 *    extension's own ledger/journal/transaction tables — only the
 *    extension's own code does, reached exclusively through this event
 *    contract (or the extension's own API), never a shared-table write
 *    (ADR-0013 §6).
 * 7. **Reversal-target resolution is tenant/legal-entity-scoped, in the
 *    documented ID space.** `reversalOfExternalTransactionId` resolves an
 *    ORIGINAL transaction by its own `externalTransactionId` (never a
 *    `requestId` — a distinct ID space, see `AccountingPostingRequestPayload.
 *    requestId`'s own doc comment), scoped to the reversal request's
 *    AUTHENTICATED tenant. A resolved original whose `tenantId`/
 *    `legalEntityScope` do not match the reversal request's own MUST be
 *    rejected — a reversal can never "find" and reference a different
 *    tenant's (or a different legal entity's) posted transaction (Issue
 *    #755 security-auditor finding, High).
 */

import type { BusinessScopeReference } from "./ports/business-scope-hierarchy-port";

/**
 * `"draft"` — not yet submitted for posting (extension-internal only,
 * never crosses the posting-request contract). `"submitted"` — a posting
 * request was accepted for processing but not yet posted (Issue #755
 * invariant 5 — "accepted" in `AccountingPostingResultPayload` maps here).
 * `"posted"` — successfully posted, now immutable. `"reversed"` — a
 * reversal transaction was posted against this one (the ORIGINAL keeps
 * its own `"posted"` status forever; only the reversal's own reference
 * carries `"reversed"` pointing back via `reversalOfExternalTransactionId`
 * — this status never retroactively appears on an already-`"posted"`
 * reference). `"rejected"` — the posting request failed validation/period-
 * lock/authorization and was never posted.
 */
export type BusinessTransactionLifecycleStatus =
  "draft" | "submitted" | "posted" | "reversed" | "rejected";

/**
 * A pointer into `document_infrastructure`'s numbering sequence allocation
 * (Issue #751, `document-infrastructure/domain/document-number-sequence.ts`)
 * — structurally compatible with, but NOT importing, that module's real
 * types (this file has zero module imports, same rule every `_shared`
 * contract file follows). An ERP extension that wants a formatted document
 * number for a business transaction calls `document_infrastructure`'s own
 * public API/service directly to allocate one, then embeds the result here
 * — this type only describes what gets embedded, it does not allocate
 * anything itself.
 */
export type DocumentReferenceLink = {
  sequenceKey: string;
  documentNumber: string;
  /** The `document_infrastructure` document id this business transaction is evidenced by, when one was created — optional, since not every business transaction needs a formal registered document. */
  documentId?: string;
};

/**
 * Generic reference to any business transaction an ERP extension owns —
 * the base never stores this type, it only appears embedded in posting
 * request/result payloads and in this doc comment's own examples.
 */
export type BusinessTransactionReference = {
  tenantId: string;
  /** `null` — tenant-level, no legal-entity/organization-unit scoping applies (Issue #755: legal entity is a business scope only, never a second identity boundary). Non-null must resolve via `BusinessScopeHierarchyPort` (`_shared/ports/business-scope-hierarchy-port.ts`) — an extension MUST reject a reference whose scope does not resolve for `tenantId`, never trust it from request input alone. */
  legalEntityScope: BusinessScopeReference | null;
  /** Namespaced `<extension_key>.<domain>.<doc_type>`, e.g. `"example_erp.sales.invoice"` — opaque to the base, never validated/interpreted here beyond being a non-empty string. */
  transactionType: string;
  /** The ERP extension's own identifier for this transaction — opaque to the base. */
  externalTransactionId: string;
  status: BusinessTransactionLifecycleStatus;
  documentReference?: DocumentReferenceLink;
};

/**
 * A posting request payload — the ERP extension's own event type (e.g.
 * `"example_erp.posting.requested"`) carries one of these as its
 * `domain_event_runtime` envelope `payload`. `requestId` is the
 * idempotency key (invariant 4 above) — MUST be unique per distinct
 * posting attempt-intent, and MUST be resubmitted UNCHANGED on any retry
 * of the exact same intent. `requestId` is NEVER the ID space
 * `reversalOfExternalTransactionId` below resolves against (invariant 7)
 * — that field always references an `externalTransactionId`, a distinct
 * identifier space entirely.
 */
export type AccountingPostingRequestPayload = {
  requestId: string;
  transaction: BusinessTransactionReference;
  /** Opaque, ERP-extension-owned accounting-period identifier (e.g. `"2026-07"`) — checked via `PeriodLockPort` (`_shared/ports/period-lock-port.ts`), never interpreted by the base. */
  periodKey: string;
  currencyCode: string;
  /** Decimal-as-string — the base never parses/sums/interprets this value, it only ever appears as an opaque control total for reconciliation/display. */
  totalDebit: string;
  totalCredit: string;
  requestedAt: string;
  /** Present only for a reversal/compensation request (invariant 2) — the ORIGINAL transaction's `externalTransactionId` (NEVER a `requestId` — invariant 7) this request reverses, resolved within the SAME tenant as this request's own `transaction.tenantId`. */
  reversalOfExternalTransactionId?: string;
};

/**
 * `"accepted"` — durably queued/validated, NOT yet posted (invariant 5).
 * `"posted"` — posting completed, transaction is now immutable.
 * `"rejected"` — validation/period-lock/authorization failed; never
 * posted. `"reversed"` — this result is for a reversal request that
 * itself posted successfully (the reversal transaction reached `"posted"`
 * — `"reversed"` here describes the RESULT of a reversal-type request,
 * not a retroactive status change to the original).
 */
export type AccountingPostingResultStatus =
  "accepted" | "posted" | "rejected" | "reversed";

export type AccountingPostingResultPayload = {
  /** MUST equal the originating `AccountingPostingRequestPayload.requestId` — this is how a caller correlates a result back to its own request without relying solely on the envelope's `correlationId`/`causationId` (Issue #755: "posting is idempotent and externally correlated" — both mechanisms apply together, this field for payload-level correlation, the envelope fields for cross-system tracing). */
  requestId: string;
  transaction: BusinessTransactionReference;
  status: AccountingPostingResultStatus;
  /** Present only when `status` is `"posted"` or `"reversed"`. */
  postedAt?: string;
  /** Present only when `status` is `"rejected"` — a human-readable reason (e.g. "period locked", "legal entity scope mismatch"), never a raw internal error/stack trace. */
  rejectionReason?: string;
  /** Opaque pointer into the ERP extension's own ledger — the base never interprets this, only stores/displays it verbatim (same "opaque resourceId" convention `DataExchangeCommitOutcome.resourceId` already uses). */
  ledgerReference?: string;
};

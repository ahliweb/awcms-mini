/**
 * `BusinessScopeHierarchyPort` (Issue #746, epic #738 platform-evolution
 * Wave 2, ADR-0013 §2/§4). The capability `identity_access`'s business-scope
 * assignment/SoD machinery consumes to answer two questions about a generic
 * `(scopeType, scopeId)` reference WITHOUT identity-access ever importing an
 * optional organization module's tables directly (issue #746 explicit
 * requirement: "Identity-access has no direct import/table write to an
 * optional organization module"):
 *
 * 1. Is this scope reference currently valid/resolvable for this tenant
 *    (existence + tenant ownership)? "Scope identifiers are validated
 *    through the owning capability and cannot be trusted from request input
 *    alone" (issue #746 security requirement) — this port IS that
 *    validation boundary.
 * 2. What are this scope's ancestor/descendant scope ids, for hierarchy-aware
 *    access (e.g. "branch B is under region R")?
 *
 * This port only RESOLVES the hierarchy graph — it never decides
 * authorization policy itself (that stays in `domain/access-control.ts`/
 * `domain/sod-conflict-evaluation.ts`, which consult bounded, already-
 * resolved `businessScopeFacts`, not this port, keeping those functions
 * I/O-free and pure).
 *
 * No optional organization module (`organization_structure`, ADR-0013 §1
 * Wave 2 candidate) exists in this repo yet, so identity-access itself
 * supplies the only implementation today: a FLAT default adapter
 * (`identity-access/application/business-scope-hierarchy-port-adapter.ts`)
 * that validates `scopeType: "office"` against `awcms_mini_offices` (see
 * that adapter's own header for why a direct read of a `tenant_admin`-owned
 * table is the deliberate, precedented choice here, not a new port) and
 * returns `resolved: false` for every other `scopeType` — a safe default
 * (no hierarchy propagation), never a crash. Once `organization_structure`
 * ships, its own adapter takes over resolution for the scope types it owns
 * (e.g. "branch", "region", "cost_center"); the composition root (route
 * handlers, the expiry job script) is what decides which adapter to inject,
 * exactly the ports-and-adapters pattern `legal-hold-guard-port.ts`
 * documents for the same reason.
 *
 * `resolved: false` is a distinct outcome from "resolved but has no
 * ancestors/descendants" (an empty array with `resolved: true`) — callers
 * MUST default-deny high-risk actions when `resolved: false` (issue #746:
 * "Unknown scope type, unresolved scope, stale hierarchy ... default to
 * deny for high-risk actions"), never treat an unresolved scope as "no
 * hierarchy constraint applies".
 */
export type BusinessScopeResolution = {
  /** `false` for an unknown scope type, a scope id that doesn't exist, or one that belongs to a different tenant — never inferred from an empty ancestor/descendant list. */
  resolved: boolean;
  /** Ancestor scope references (broadest last-known ancestor last), empty when `resolved` is `false` or the scope genuinely has no ancestors. */
  ancestorScopeIds: readonly string[];
  /** Descendant scope references, same emptiness convention as `ancestorScopeIds`. */
  descendantScopeIds: readonly string[];
};

export type BusinessScopeHierarchyPort = {
  /**
   * Resolves one `(scopeType, scopeId)` reference for `tenantId`. `tx` must
   * already be tenant-scoped (via `withTenant`) — an implementation reads
   * only its own owned, `FORCE ROW LEVEL SECURITY`'d table(s).
   */
  resolveScope(
    tx: Bun.SQL,
    tenantId: string,
    scopeType: string,
    scopeId: string
  ): Promise<BusinessScopeResolution>;
};

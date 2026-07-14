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
 * TWO adapters implement this port today. `identity-access`'s own FLAT
 * default adapter (`identity-access/application/business-scope-hierarchy-
 * port-adapter.ts`) validates ONLY `scopeType: "office"` against
 * `awcms_mini_offices` (see that adapter's own header for why a direct
 * read of a `tenant_admin`-owned table is the deliberate, precedented
 * choice here, not a new port) and returns `resolved: false` for every
 * other `scopeType` — a safe default (no hierarchy propagation), never a
 * crash. `organization_structure` (Issue #749, ADR-0016) now ships its OWN
 * adapter (`organization-structure/application/organization-structure-
 * hierarchy-port-adapter.ts`) that walks its real effective-dated
 * hierarchy table for `scopeType: "legal_entity"`/`"organization_unit"` —
 * neither adapter supersedes the other; **the composition root (route
 * handler, job script) is what decides which adapter to inject** based on
 * which `scopeType`(s) it expects to resolve, exactly the ports-and-
 * adapters pattern `legal-hold-guard-port.ts` documents for the same
 * reason. `organization_structure` cannot be a lifecycle/capability
 * dependency of `identity_access` (Core never depends on Optional,
 * ADR-0013 §1) — this port is the ONLY thing that lets `identity_access`
 * benefit from a real hierarchy without ever importing
 * `organization_structure`'s tables.
 *
 * `resolved: false` is a distinct outcome from "resolved but has no
 * ancestors/descendants" (an empty array with `resolved: true`) — callers
 * MUST default-deny high-risk actions when `resolved: false` (issue #746:
 * "Unknown scope type, unresolved scope, stale hierarchy ... default to
 * deny for high-risk actions"), never treat an unresolved scope as "no
 * hierarchy constraint applies".
 *
 * **Heterogeneous ancestry (Issue #749).** Ancestor/descendant entries are
 * `{ scopeType, scopeId }` REFERENCES, not bare ids of the SAME scopeType
 * as the query — an organization unit's ancestor chain can legitimately
 * terminate at a different-typed legal entity (e.g.
 * `unit(branch) -> unit(region) -> legal_entity`). A flat `string[]` of
 * ids (the original #746 shape) implicitly, and wrongly, assumed every
 * ancestor/descendant shared the queried scope's own `scopeType` — that
 * assumption breaks the moment a real hierarchy-owning adapter (e.g.
 * `organization_structure`'s, see `organization-structure-hierarchy-port-
 * adapter.ts`) walks a chain that legitimately crosses scope types. This
 * is a breaking change from the original #746 shape
 * (`ancestorScopeIds: readonly string[]`); the only real caller today
 * (`identity-access/application/business-scope-assignment-service.ts`)
 * reads only `resolution.resolved` and needed no logic change.
 */
export type BusinessScopeReference = {
  scopeType: string;
  scopeId: string;
};

export type BusinessScopeResolution = {
  /** `false` for an unknown scope type, a scope id that doesn't exist, or one that belongs to a different tenant — never inferred from an empty ancestor/descendant list. */
  resolved: boolean;
  /** Ancestor scope references, immediate parent first, broadest/last-known ancestor last (may legitimately end in a different scopeType, e.g. a "legal_entity" terminating an "organization_unit" chain) — empty when `resolved` is `false` or the scope genuinely has no ancestors. */
  ancestorScopes: readonly BusinessScopeReference[];
  /** Descendant scope references (any depth, any scopeType), same emptiness convention as `ancestorScopes`. */
  descendantScopes: readonly BusinessScopeReference[];
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

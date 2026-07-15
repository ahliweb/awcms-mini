---
"awcms-mini": patch
---

Fix (Issue #794, follow-up to #786/#790, epic #738 platform-evolution): make
`detectSoDConflicts`'s `"same_scope_only"` segregation-of-duties matching
hierarchy-aware. Before this fix, a `same_scope_only` rule (e.g.
`identity_access.business_scope_assignment_scope_maker_checker`) matched
only on EXACT `(scopeType, scopeId)` equality — a subject holding
`business_scope_assignments.create` at a parent `organization_unit` could
be granted `.revoke` at a hierarchically-related child unit without
tripping the conflict rule, even though both scopes belong to the same
business hierarchy the rule was meant to bound. This was purely theoretical
before PR #790 wired the real `organizationStructureHierarchyPortAdapter`
into production (the hierarchy port always resolved `false` for
`legal_entity`/`organization_unit` before that) — #790 made it practically
reachable.

`detectSoDConflicts` (`src/modules/identity-access/domain/sod-conflict-evaluation.ts`)
now accepts an optional `RequestedScope.relatedScopes` list; a held fact
whose scope appears in that list (the requested scope's own
`ancestorScopes`/`descendantScopes`) is now treated as a scope match, same
as exact equality or the existing null-scope "ordinary RBAC grant matches
every scope" case. `createBusinessScopeAssignment`
(`application/business-scope-assignment-service.ts`) wires this from the
hierarchy-port resolution it already fetches to validate the requested
scope — no additional hierarchy-port call is introduced. A caller that
never resolves hierarchy (e.g. identity-access's own flat "office" scope
adapter) simply omits `relatedScopes`, so its exact-match-only behavior is
unchanged.

Not exploitable across tenant/RLS boundaries and does not bypass ABAC
default-deny — the documented residual limitation (the generic
`authorizeInTransaction`/`checkHighRiskSoDConflicts` chokepoint used by
~124 route files across many modules still has no hierarchy port wired in
and still compares scope by exact equality) is called out explicitly in
`src/modules/identity-access/README.md` and
`docs/awcms-mini/20_threat_model_security_architecture.md`, not silently
absorbed into this fix's claim.

Added an adversarial integration test proving a `.create` grant at a
parent `organization_unit` now blocks a subsequent `.revoke` grant at a
real hierarchy-descendant child unit
(`tests/integration/business-scope-organization-structure-wiring.integration.test.ts`),
plus pure unit tests for the new `relatedScopes` matching
(`tests/unit/sod-conflict-evaluation.test.ts`).

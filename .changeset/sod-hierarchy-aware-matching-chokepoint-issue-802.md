---
"awcms-mini": patch
---

Fix (Issue #802, follow-up to #794/PR #800, epic #738 platform-evolution):
close the residual `checkHighRiskSoDConflicts` hierarchy-matching gap Issue
#794 explicitly left open. `detectSoDConflicts`'s `"same_scope_only"`
hierarchy-aware matching (#794) was previously wired ONLY into
`createBusinessScopeAssignment` — the OTHER `same_scope_only` call site,
`checkHighRiskSoDConflicts` (`src/modules/identity-access/application/high-risk-sod-guard.ts`),
wired at the generic `authorizeInTransaction` chokepoint (`access-guard.ts`)
shared by ~124 route files, still compared `sodScopeType`/`sodScopeId` by
exact equality only — an actor holding `.revoke` via an ordinary RBAC role
plus a business-scope `.create` fact at an ancestor `organization_unit`
could revoke a descendant-scope assignment without tripping
`business_scope_assignment_scope_maker_checker` through this path. Because
`detectSoDConflicts` found no match, this near-miss also generated ZERO
telemetry (`sod_conflicts_detected_total` never fired), contradicting
#794's own "if not fixed, at minimum add monitoring" fallback requirement.

Investigation found the real exploitable surface much narrower than "124
route files": only ONE caller of `authorizeInTransaction`,
`.../business-scope/assignments/[id]/revoke.ts`, has ever populated
`resourceAttributes.sodScopeType`/`.sodScopeId` — every other caller
already gets `requestedScope: null`, which a `same_scope_only` rule already
treats as `indeterminate: true` (default-deny), not a silent gap.

`checkHighRiskSoDConflicts`/`authorizeInTransaction` now accept an OPTIONAL
`hierarchyPort` parameter, resolved LAZILY only when both a
`requestedScope` is supplied and a `hierarchyPort` is passed — every other
caller today passes neither, so their behavior is byte-for-byte unchanged
(zero new queries, zero regression risk across the other ~123 route
files). Only `revoke.ts` now composes the real `BusinessScopeHierarchyPort`
(the same `organization_structure` adapter composition
`assignments/index.ts` already uses for the create path, factored into
`src/pages/api/v1/identity/business-scope/hierarchy-port-composition.ts`
so both routes share one composition root instead of duplicating it) and
passes it in. Since the detection gap is closed at the source, the
previously-silent near-miss now correctly fires
`recordSoDConflictEvaluation`/`sod_conflicts_detected_total` through the
already-existing mechanism — no separate monitoring code needed.

Added an adversarial integration test proving a `.create` grant at a
parent `organization_unit` (via a business-scope assignment) plus
`.revoke` via an ordinary RBAC role can no longer revoke a DIFFERENT
subject's assignment at a hierarchy-descendant unit through this
chokepoint (`tests/integration/business-scope-organization-structure-wiring.integration.test.ts`,
"Issue #802 adversarial" — now `403 SOD_CONFLICT`, recorded with
`trigger_context: "high_risk_decision"`).

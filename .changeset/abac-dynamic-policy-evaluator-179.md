---
"awcms-mini": minor
---

feat(identity-access): dynamic ABAC policy evaluator from awcms_mini_abac_policies (#179)

`evaluateAccess`/`authorizeInTransaction` now CONSUME stored ABAC policies at the
single authorization chokepoint, default-deny, without weakening any existing
guard (tenant isolation, self-approval, force-decision, module-enabled,
business-scope, SoD) or RLS.

- **DSL** (`domain/abac-policy.ts`): a bounded, deterministic, versioned jsonb
  condition AST — `allOf`/`anyOf`/`not` nodes and `{attr, op, value|valueAttr}`
  leaves over a server-side attribute allow-list (`subject.*`/`resource.*`/
  `action`/`env.*`) with operators `eq/ne/in/nin/lt/lte/gt/gte/exists`.
  Fail-closed parser/validator: unknown attribute/operator, wrong value type, or
  a too-new `dsl_version` makes a policy invalid at authoring, so it can never be
  stored or enabled. No `eval`/`new Function`/dynamic import/templated SQL.
- **Evaluator** (`domain/abac-evaluator.ts`): a pure interpreter. Precedence
  (ADR-0023): explicit deny (and any invalid policy / evaluation error) wins over
  RBAC and allow-policies; the RBAC permission is still required (an allow-policy
  never creates one); applicable allow-policies act as a constraint.
- **Cache** (`application/policy-cache.ts`): tenant-keyed, invalidated
  deterministically after every policy create/update/enable/disable — no restart.
- **Admin API**: `GET/POST /api/v1/access/policies`, `GET/PUT
  /api/v1/access/policies/{id}`, `POST /api/v1/access/policies/{id}/{enable,
  disable}`, and a read-only, audited `POST /api/v1/access/policies/simulate`.
  `POST /api/v1/access/evaluate` now reflects active policies too.
- **Decision log** records `matched_policy` + `matched_policy_version` + reason,
  with no raw PII.
- **Hardening (adversarial review):** allow-list membership is now own-property
  only (`Object.prototype.hasOwnProperty.call`) in both the validator and the
  eval-time backstop, so prototype-chain keys (`__proto__`/`constructor`/
  `toString`/…) can no longer pass the unknown-attribute check and silently skip
  a `deny` (fail-open closed). The simulation endpoint now requires
  `identity_access.user_management.read` to simulate a DIFFERENT existing tenant
  user (foreign-subject horizontal-read oracle), and records the probed subject
  id in the audit event for attribution.
- Migrations `sql/081` (policy DSL columns + decision-log version) and `sql/082`
  (admin permission seed). ADR-0023, identity-access README, threat model, and
  five illustrative ERP example policies (`fixtures/abac-example-policies.json`,
  not seeded into the base) added.

---
"awcms-mini": minor
---

security(saas-control-plane): platform/tenant separation, SoD, step-up policy, and no-soft-super-tenant enforcement (#879)

Cross-cutting security model for the SaaS control-plane modules (epic #868,
Wave 2, ADR-0022 §5/§6/§8). Enforcement and static gates — the operator admin
surfaces (runtime step-up prompts, support-access grant UI/worker) are applied
in #878 and verified in #881, per the issue's dependency note.

- **Segregation of duties (SoD).** Five maker/checker rules deferred from
  #870–#877 are now declared on their owning module's `sodRules`
  (service_catalog publish/retire, tenant_entitlement override vs audit-review,
  tenant_lifecycle restore requester/approver, subscription_billing invoice
  create/issue, payment_gateway provider-config vs refund) and wired into the
  real `authorizeInTransaction` chokepoint via `high-risk-sod-guard.ts`. A
  single actor holding both halves is denied the high-risk enforcing action
  with a safe `403 SOD_CONFLICT` unless a bounded, approver-gated exception is
  on file. Adversarial + mutation proof in the tenant_entitlement integration
  suite.
- **Step-up policy registry** (`_shared/control-plane-step-up-registry.ts`,
  gate `control-plane:step-up:check`): pure code classification of the
  high-risk control-plane actions requiring current assurance (refund, credit,
  entitlement override, lifecycle restore, provider configuration, + adjacent),
  validated against the live registry so a policy can never point at a
  non-existent permission. Reuses the existing MFA/assurance mechanism — no new
  IdP/MFA.
- **No soft super-tenant** (ADR-0022 §6 High-1): new static gate
  `rls:platform-claim:check` fails any `CREATE POLICY` predicate widened past
  `tenant_id` with a platform-claim disjunction (`OR is_platform`,
  `has_platform_claim()`, or a novel `OR current_setting('app.…')`) — a
  functional BYPASSRLS the role-attribute check cannot see.
- **security-readiness** adds three critical, go-live-blocking checks:
  `checkNoSoftSuperTenantRlsPredicate`, `checkControlPlaneStepUpPolicyValid`,
  `checkControlPlaneSoDAndDefaultDisabled` (all five SoD rules present + all
  seven control-plane modules default-disabled).
- Docs: `docs/awcms-mini/control-plane-security.md` (role matrix, SoD registry,
  step-up policy, support/break-glass SOP, privacy/data-classification/retention
  matrix, no-soft-super-tenant trust model, anomaly signals, OWASP/ISO control
  mapping). No schema change (SoD rules, step-up policy, and gates are
  code/registry only).

# Control-plane security model (Issue #879)

Cross-cutting security model for the SaaS control-plane modules (epic #868,
Wave 2). This document is the human-readable companion to the enforcement
that actually ships in code — SoD rules on the owning modules, the step-up
policy registry, the RLS platform-claim static gate, and the extended
security-readiness checks. It refines, and must be read together with,
[ADR-0022](../adr/0022-saas-control-plane-admission-boundary-and-lifecycle-contracts.md)
(§5 actors/SoD, §6 trust model / no soft super-tenant, §8 data classification)
and the base threat model in
[20_threat_model_security_architecture.md](20_threat_model_security_architecture.md).

> Scope note. #879 delivers the security **model, registries, static gates,
> and readiness**. Application to the operator **admin surfaces** is #878 and
> pilot verification is #881 (per the issue's own dependency note). Items that
> require those surfaces (runtime step-up prompts, the support-access grant
> UI/worker) are called out under "Deferred to #878/#881" below.

## 1. Platform / tenant role matrix

The tenant remains the single security boundary (RLS predicate is always and
only `tenant_id`, ADR-0013 §2). Platform actors do **not** get a database
bypass; they operate a target tenant only inside that tenant's per-tenant
context, audited.

| Actor               | Scope                                         | May do                                               | Mandatory controls                                                                               |
| ------------------- | --------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Platform operator   | Cross-tenant (platform administration)        | Catalog, provisioning, lifecycle                     | Explicit platform permissions; **not** BYPASSRLS; high-risk actions need audit + step-up         |
| Billing operator    | Cross-tenant, commercial only                 | Invoice/credit/refund/dunning                        | Separated from platform operator (SoD); refund/credit high-risk (idempotency + audit + step-up)  |
| Support operator    | Cross-tenant **only when a grant is open**    | Read a specific tenant's context for troubleshooting | Reason-bound, time-bound (auto-expire), tenant-bound, audited; **no** default tenant-data access |
| Security/audit      | Read audit trail (`logging.audit_trail.read`) | Independent review of high-risk actions              | SoD-separated from the duties they review (see §2)                                               |
| Tenant owner/admin  | One tenant (RLS `tenant_id`)                  | Own subscription/invoice/usage; bounded self-service | Full RLS; never sees another tenant; cannot change global catalog/price                          |
| Automation identity | Worker/job                                    | Deterministic state transitions from events/schedule | Least-privilege DB role; no interactive session; high-risk mutations stay idempotent + audited   |

Control-plane permissions are seeded **granted to no role** by their migration
(see the payment_gateway permission seed) — a platform-operator role is
provisioned narrowly at deploy time, separate from any tenant-admin role. All
seven control-plane modules are `defaultTenantState: "disabled"`, so a
LAN/offline deployment that never activates the control plane has no reachable
control-plane surface at all.

## 2. Segregation-of-duties (SoD) registry

Five maker/checker rules, deferred from #870–#877 to #879, are declared on the
**owning module's** `module.ts` (`sodRules`) and wired automatically into the
real `authorizeInTransaction` chokepoint via
`identity-access/application/high-risk-sod-guard.ts`. Enforcement fires when a
subject exercises the **high-risk enforcing (checker) action** while also
holding the conflicting (maker) permission — a deny-overrides-allow decision
that can only turn an already-allowed high-risk decision into a `403
SOD_CONFLICT` (a safe error that enumerates neither tenant nor resource).

| Rule key                                         | Owning module        | Conflicting permissions                                                          | Enforcing (high-risk) action | Severity |
| ------------------------------------------------ | -------------------- | -------------------------------------------------------------------------------- | ---------------------------- | -------- |
| `service_catalog.catalog_publish_maker_checker`  | service_catalog      | `service_catalog.offers.publish` ↔ `service_catalog.offers.retire`               | `retire`                     | high     |
| `tenant_entitlement.override_vs_audit_review`    | tenant_entitlement   | `tenant_entitlement.overrides.override` ↔ `logging.audit_trail.read`             | `override`                   | high     |
| `tenant_lifecycle.restore_requester_vs_approver` | tenant_lifecycle     | `tenant_lifecycle.states.schedule` ↔ `tenant_lifecycle.states.restore`           | `restore`                    | high     |
| `subscription_billing.invoice_create_vs_issue`   | subscription_billing | `subscription_billing.invoices.create` ↔ `subscription_billing.invoices.issue`   | `issue`                      | high     |
| `payment_gateway.provider_config_vs_refund`      | payment_gateway      | `payment_gateway.provider_accounts.configure` ↔ `payment_gateway.refunds.create` | `configure`                  | critical |

Each rule is `global_within_tenant` and permits a **bounded, approver-gated
exception** (`identity_access.business_scope_exceptions.approve`, max 7–14
days). The all-powerful setup-wizard owner holds both halves of every rule and
is therefore correctly blocked from the enforcing action **without** an
approved exception — the same effect the shipped
`data_lifecycle.legal_hold_maker_checker` rule already has. This is validated
adversarially in `tests/integration/tenant-entitlement.integration.test.ts`
("Issue #879: … BLOCKED (403 SOD_CONFLICT) with NO approved exception").

Static gate: `bun run identity-access:sod-registry:check` validates every
rule; `checkControlPlaneSoDAndDefaultDisabled` in security-readiness blocks
go-live if any of the five rules is missing.

## 3. Step-up (re-assurance) policy

`src/modules/_shared/control-plane-step-up-registry.ts` is a pure code
registry classifying the high-risk control-plane actions that require a
**current** authentication assurance (a fresh step-up) using the existing
MFA/assurance mechanism (no new IdP/MFA). The ADR-0022 §5/§8 mandatory core:
refund, credit, entitlement override, lifecycle restore, provider
configuration — plus offer retire, usage correction, and invoice issue. Every
policy declares `reasonRequired`, `idempotencyRequired`, a bounded
`maxAssuranceAgeSeconds` (≤ 3600), and is validated against the live module
registry so a renamed/removed permission can never leave a policy pointing at
nothing.

Static gate: `bun run control-plane:step-up:check`;
`checkControlPlaneStepUpPolicyValid` blocks go-live on drift.

## 4. Support access / break-glass SOP

Support operators have **no** default access to tenant data. Cross-tenant
support access is opened only through an explicit grant that is:

- **scope-bound** — one target tenant, never reusable for another tenant
  (RLS `tenant_id` makes a grant physically invisible outside its tenant);
- **time-bound** — auto-expires, reusing the existing
  `identity-access:business-scope:expiry` mechanism (ADR-0022 §6);
- **reason-bound** — a mandatory operator reason recorded on the grant;
- **approved + revocable** — request and approval are a maker/checker pair
  (SoD), and a grant can be revoked before expiry;
- **audited** — every open/approve/revoke/use is a high-severity audit event
  recording operator, tenant scope, reason, result, and correlation, never a
  raw secret or PII.

Break-glass use is exceptional, short-lived, alerted, and followed by review.

> Deferred to #878/#881: the operator-facing support-access grant surface
> (request/approve/revoke UI + expiry worker consuming the existing
> business-scope-expiry job) and the runtime step-up prompt on the admin
> surfaces. The model, SoD pairing, and expiry mechanism are defined here; the
> surfaces are applied in #878 and verified in #881.

## 5. Trust model — no soft super-tenant (ADR-0022 §6 High-1)

Forbidding the `BYPASSRLS` role attribute is necessary but **not sufficient**:
a functionally identical bypass can be smuggled in by widening a tenant-scoped
RLS predicate with a platform-claim disjunction, e.g.
`USING (tenant_id = current_setting('app.current_tenant_id') OR
current_setting('app.is_platform') = 't')`. That slips past a role-attribute
check. `scripts/rls-platform-claim-check.ts` (`bun run
rls:platform-claim:check`, also run inside security-readiness as
`checkNoSoftSuperTenantRlsPredicate`) statically scans every `sql/*.sql`
`CREATE POLICY` predicate and fails when a predicate either references a
platform-claim/bypass token (`is_platform`, `has_platform_claim`, `bypassrls`,
…) or references the tenant GUC yet also contains a boolean `OR` (which catches
novel claim names the token list does not enumerate). Cross-tenant operator
reads must go through an audited per-tenant context or a purpose-built,
permission-gated read-model — never a widened policy predicate.

Secrets (payment provider keys, webhook signing secrets) live only in
`process.env`/the deployment secret store — never in a table, event, log, or
audit record. Rotation is a deployment configuration change.

## 6. Privacy, data classification, retention, legal hold

| Dimension         | Decision                                                                                                                                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Classification    | Published catalog = public-internal; draft/internal price = restricted; entitlement/subscription/usage/invoice = tenant-confidential; billing contact = PII (masked, doc 04); provider secret = restricted, out of DB. No raw PAN stored. |
| Webhook envelope  | Stored payment webhook envelopes pass masking (doc 04) before persist — no raw PII in table/event/log/IndexedDB.                                                                                                                          |
| Retention/purge   | Usage records, webhook envelopes, payment attempts, outbox = high-volume → registered with `data_lifecycle` (retention/archive/purge). Invoices = append-only, long retention per legal obligation.                                       |
| Legal hold        | `data_lifecycle` legal hold pauses purge of disputed invoice/billing data.                                                                                                                                                                |
| Audit             | Every high-risk action → `recordAuditEvent` with redaction; records operator, tenant scope, reason, result, correlation — never a raw secret/PII/token.                                                                                   |
| DSR / tenant data | Tenants see only their own data (RLS); support access to tenant PII is reason/time/tenant-bound (§4).                                                                                                                                     |

## 7. Anomaly / alert signals

The following are surfaced as low-cardinality counters (observability metrics
port) for alerting: repeated cross-tenant denies, refund abuse,
entitlement-override spikes, support-access misuse, webhook failures, and
secret/config errors. The SoD guard already emits `sod_conflicts_detected_total`
keyed by rule and resolution.

## 8. Security-readiness (blocks go-live)

`bun run security:readiness` adds three critical checks under #879:

- `checkNoSoftSuperTenantRlsPredicate` — no platform-claim RLS predicate;
- `checkControlPlaneStepUpPolicyValid` — step-up registry valid, no drift;
- `checkControlPlaneSoDAndDefaultDisabled` — all five SoD rules present and all
  seven control-plane modules default-disabled.

These join the existing `checkAppDbUserNotSuperuser` /
`checkRuntimeRoleGlobalTableGrants` / `checkRlsEnabled` role/grant checks — so
a missing SoD rule, a widened RLS predicate, an unsafe role grant, or a
default-enabled control-plane module all block go-live.

## 9. Control mapping (indicative, not a certification claim)

| Control area                  | OWASP ASVS / Top 10                | ISO/IEC 27001 Annex A                  | Where enforced                                    |
| ----------------------------- | ---------------------------------- | -------------------------------------- | ------------------------------------------------- |
| Default-deny authorization    | A01 Broken Access Control; ASVS V4 | A.5.15 Access control                  | `authorizeInTransaction` chokepoint (ABAC)        |
| Segregation of duties         | A01; ASVS V1.2                     | A.5.3 Segregation of duties            | `sodRules` + `high-risk-sod-guard.ts`             |
| Step-up assurance             | A07 Auth Failures; ASVS V2         | A.8.5 Secure authentication            | step-up registry (surface application #878)       |
| Tenant isolation / no bypass  | A01; ASVS V4.3                     | A.5.15; A.8.3 Info access restriction  | RLS `tenant_id`-only + platform-claim gate        |
| Break-glass / support access  | A01; ASVS V1.2.4                   | A.5.15; A.8.2 Privileged access        | time/reason/tenant-bound grant + audit            |
| Secrets not in data           | A02 Cryptographic Failures         | A.8.24 Use of cryptography             | secrets in env only; no secret in table/log/audit |
| Audit / accountability        | A09 Logging Failures; ASVS V7      | A.8.15 Logging                         | `recordAuditEvent` with redaction                 |
| Data classification/retention | ASVS V8                            | A.5.12 Classification; A.8.10 Deletion | `data_lifecycle` registry + masking (doc 04)      |

This table maps design intent to controls; it is **not** a claim of regulatory
or ISO certification (explicitly out of scope for #879).

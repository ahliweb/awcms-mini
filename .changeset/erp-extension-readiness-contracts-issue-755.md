---
"awcms-mini": minor
---

Define provider-neutral ERP extension readiness contracts (Issue #755,
epic #738 `platform-evolution` Wave 4, ADR-0020) — AWCMS-Mini is a
technical kernel, never a functional ERP; this issue documents and
validates the contract package a future ERP extension (built in a
SEPARATE repository) implements against, without adding any accounting,
inventory, sales/procurement, AR/AP, payroll, tax, asset, or manufacturing
domain table/route to this base repository.

New pure-data/port contracts (`src/modules/_shared/`):
`business-transaction-contract.ts` (business transaction reference/
lifecycle status, accounting posting request/result event payload
shapes), `erp-reference-data-contract.ts` (item/service, currency,
unit-of-measure, inventory movement, and reconciliation reference
shapes), and `ports/period-lock-port.ts` (a fail-closed period-lock
capability port, with a `noPeriodLockAdapterConfigured` default that
always reports `checked: false` — never silently permits posting). Four
of eleven contract families deliberately reuse existing Wave 2/3
mechanisms rather than duplicating them: canonical party
(`party-directory-port.ts`), tenant/legal-entity/organization scope
(`business-scope-hierarchy-port.ts`), document numbering
(`document_infrastructure`), and reporting projection contribution
(`reporting`'s `ProjectionDescriptor`).

A new in-repo fixture (`tests/fixtures/derived-application-example/
modules/example-erp-extension/`) demonstrates all of this end to end —
an idempotent, fail-closed-period-lock, cross-tenant/legal-entity-
mismatch-rejecting posting engine with reversal-as-a-new-transaction
semantics, plus a `reporting` projection contribution that independently
passes `reporting`'s real `validateProjectionRegistry` check — never
composed into the base's real module registry
(`src/modules/index.ts` unchanged). New tests:
`tests/unit/erp-extension-contracts.test.ts` (idempotency, fail-closed
period lock, cross-tenant/legal-entity rejection, reversal, dependency-
direction proof that no base `src/modules/**` file imports the example
extension) and extended `tests/unit/module-composition-fixture.test.ts`
coverage for the third fixture module.

New ADR (`docs/adr/0020-erp-extension-readiness-contracts.md`) and
reference doc (`docs/awcms-mini/erp-extension-contracts.md`, all eleven
contract families with ownership/versioning/failure-semantics/privacy/
examples), plus cross-references added to
`docs/awcms-mini/21_module_admission_governance.md` (a pure contract
package without a new module still requires a full ADR, not the
lightweight module-proposal template), `docs/awcms-mini/derived-
application-guide.md`, `docs/awcms-mini/13_final_master_index_
traceability.md`, and `docs/awcms-mini/19_glossary_terminology.md`. New
skill `.claude/skills/awcms-mini-erp-extension-readiness/SKILL.md` for
future work consuming or evolving these contracts.

Explicitly pinned caveat: Issue #750 (`reference_data`) was still open
with unresolved Critical findings at the time this issue shipped — the
item/currency/unit-of-measure contracts here deliberately avoid a hard
dependency on that module's internal schema.

Two invariants added/hardened after an independent security-auditor pass
on this PR: (3) posted-state uniqueness keyed by `(tenantId,
transactionType, externalTransactionId)`, independent of `requestId` —
the original fixture only deduplicated by `requestId`, letting a new
`requestId` for the same business transaction double-post (Medium); and
(7) reversal-target resolution scoped to the authenticated tenant/legal
entity, in the documented `externalTransactionId` ID space — the
original fixture indexed reversal targets by `requestId` (the wrong ID
space) with no tenant/legal-entity re-verification at all, letting an
attacker who observed/guessed another tenant's identifiers reference
their posted transaction (High). Both are fixed in
`posting-engine.ts`/`business-transaction-contract.ts` and proven by two
new adversarial tests in `tests/unit/erp-extension-contracts.test.ts`.

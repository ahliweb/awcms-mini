# Derived-Application Compatibility, Deprecation, and Support-Window Policy

> **⚠️ DEPRECATED ([ADR-0024](../adr/0024-awcms-family-direct-use-templates-and-derived-pathway-removal.md)).** Mekanisme manifest kompatibilitas aplikasi-turunan (`extension.manifest.json`, `bun run extension:check`, `extension-compatibility.ts`, `extension-manifest-contract.ts`, `capability-contract-versions.ts`) sudah **dihapus** — keluarga AWCMS kini template dipakai-langsung tanpa repo turunan. Dokumen ini dipertahankan sebagai catatan historis.

Issue #741 (epic #738 `platform-evolution`, Wave 1, ADR-0015). This
document is the authoritative policy reference for every SemVer scheme a
derived application's `extension.manifest.json` declares itself against,
how a breaking change to any of them is communicated, and how long a
declared compatible range should be expected to remain valid. `bun run
extension:check` (`scripts/extension-check.ts`) is the machine
enforcement of this policy — this document is the human-readable
explanation of the rules it enforces.

## The seven independent versioning schemes

AWCMS-Mini does not use one version number for everything — each scheme
below changes on its own schedule, for its own reason. Conflating them
(e.g. assuming a package release bump means the module contract changed)
is a common mistake this document exists to prevent.

| #   | Scheme                                                                            | Where it lives                                        | Bumped when…                                                                | Authoritative doc                                                                |
| --- | --------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | Package release (`package.json` `version`)                                        | This repository's own release                         | Any PR that changes application behavior (Changesets-driven)                | [`09_roadmap_repository_commit.md`](09_roadmap_repository_commit.md) §Versioning |
| 2   | REST contract (`openapi/awcms-mini-public-api.openapi.yaml` `info.version`)       | The OpenAPI document                                  | The REST contract SHAPE changes                                             | ADR-0008                                                                         |
| 3   | Event contract (`asyncapi/awcms-mini-domain-events.asyncapi.yaml` `info.version`) | The AsyncAPI document                                 | The event contract SHAPE changes                                            | ADR-0008                                                                         |
| 4   | Module descriptor contract (`MODULE_CONTRACT_VERSION`)                            | `src/modules/_shared/module-contract.ts`              | The `ModuleDescriptor`/`ApplicationModuleRegistry` TYPE shape changes       | ADR-0015 §1                                                                      |
| 5   | Capability contract (`CAPABILITY_CONTRACT_VERSIONS[key]`)                         | `src/modules/_shared/capability-contract-versions.ts` | A specific capability's port interface (`_shared/ports/*.ts`) shape changes | ADR-0015 §1                                                                      |
| 6   | Manifest schema (`EXTENSION_MANIFEST_SCHEMA_VERSION`)                             | `src/modules/_shared/extension-manifest-contract.ts`  | The compatibility manifest's OWN field shape changes                        | ADR-0015 §1                                                                      |
| 7   | SaaS contract (`SAAS_CONTRACT_VERSION`)                                           | `src/modules/_shared/module-contract.ts`              | The SaaS feature/quota/meter/commercial-event descriptor shape changes      | ADR-0022, Issue #874                                                             |

Every scheme uses the same three-tier bump rule:

- **MAJOR** — a field/type is removed, renamed, or an optional field
  becomes required. Breaking. `bun run extension:check` fails a manifest
  whose declared version's MAJOR does not exactly match the actual
  current MAJOR for schemes 4-7, and fails a `compatibleAwcmsMiniRange`
  (scheme 1) or `consumes.*ContractVersion` (schemes 2-3) that excludes
  the actual current version.
- **MINOR** — a new optional field/capability/endpoint/event is added.
  Backward-compatible. A manifest declaring a version whose MINOR is
  **less than or equal to** the actual current MINOR (same MAJOR) is
  always compatible — a derived application built against an OLDER minor
  never breaks against a NEWER one. A manifest declaring a HIGHER minor
  than what is actually shipped fails (`module_contract_version_unsupported`/
  `capability_version_unsupported`/`stale_api_contract_assumption`): it
  assumes a feature that does not exist yet.
- **PATCH** — documentation-only clarification, no shape change. Never
  checked for compatibility (any PATCH is always compatible with any
  other PATCH of the same MAJOR.MINOR).

## Deprecation policy

A scheme element (a module descriptor field, a capability, an API
operation/event channel, a manifest field) being **deprecated** means it
still works today but is scheduled for eventual removal in a future
MAJOR bump of its own scheme:

1. **Announce** — mark the element `deprecated: true` where the schema
   supports it (OpenAPI/AsyncAPI operations/schemas/channels — see
   [`api-reference.md`](api-reference.md) §Compatibility & deprecation
   policy for the current list, auto-generated from the bundled
   contracts) or document the deprecation explicitly in the owning file's
   doc comment (module descriptor fields, capabilities, manifest fields —
   these have no `deprecated` boolean in their own type shape today).
   Always accompanied by a changeset explaining the replacement path.
2. **Coexist** — the deprecated element and its replacement (if any) both
   work for at least one MINOR release cycle of the owning scheme, so a
   derived application has a window to migrate without an emergency
   patch.
3. **Remove** — only in a MAJOR bump of the owning scheme, never a MINOR
   or PATCH. `bun run extension:check` catches a derived application that
   has not migrated before the base moves to that MAJOR version (the
   manifest's declared version for that scheme stops satisfying the
   actual current one).

No fixed calendar SLA (e.g. "deprecated fields are removed after exactly
90 days") is imposed — AWCMS-Mini pre-1.0.0 package release policy
already documents that "minor boleh memuat penyesuaian belum stabil"
(skill `awcms-mini-release` §Aturan). The MAJOR/MINOR/PATCH discipline
above is the actual enforced guarantee; a MINOR release is never a
surprise breaking change regardless of how much or little time passed
since the deprecation announcement.

## Support-window guidance for `compatibleAwcmsMiniRange`

A derived application's manifest should declare the NARROWEST range that
is still practically useful, not the widest one that happens to pass
today:

- **Prefer an open-ended lower bound with an explicit upper bound below
  the next anticipated MAJOR**, e.g. `">=0.23.0 <1.0.0"` — this repo's
  own pre-1.0.0 fixtures use exactly this shape
  (`tests/fixtures/derived-application-example/extension.manifest.json`).
  An upper bound that excludes a future MAJOR means `bun run
extension:check` fails LOUDLY (and early, before build) the moment a
  derived application is actually run against a base release that removed
  something it depends on — the entire point of this mechanism — instead
  of failing silently or subtly at runtime.
- **Widen the range only after actually verifying compatibility** with
  the newer base version (re-run `bun run extension:check` against the
  new checkout, review the relevant CHANGELOG/ADR entries for breaking
  changes, update `moduleContractVersion`/`capabilities.requires[].version`/
  `consumes.*ContractVersion` to match what was actually verified) — never
  widen a range preemptively "just in case it still works."
- **A derived application with NO manifest committed is not exempt from
  compatibility risk** — it simply is not machine-checked. Publishing
  `extension.manifest.json` is how a derived repository opts into this
  protection; this repository's own default build intentionally ships
  without one (see `scripts/extension-check.ts`'s own header for why that
  keeps a default base build green) precisely because the BASE has
  nothing external to be compatible with.

## Where this is enforced (not just documented)

`bun run extension:check` is wired into three real gates, so an
incompatible manifest actually blocks something rather than only
appearing in a report nobody reads (ADR-0015 §6 has the full reasoning
and the specific PR history — #769/#770 — that makes this an explicit,
checked requirement rather than an assumption):

1. `package.json`'s `check` composite (`bun run check`).
2. `.github/workflows/ci.yml`'s `quality` job, as an explicit named step.
3. `scripts/production-preflight.ts`'s stage list — a production
   deployment cannot proceed past an incompatible manifest.

## See also

- [`docs/adr/0015-derived-application-compatibility-manifest.md`](../adr/0015-derived-application-compatibility-manifest.md)
  — the full architectural decision (schema design, wiring, alternatives
  considered).
- [`docs/adr/0008-independent-contract-and-module-versioning.md`](../adr/0008-independent-contract-and-module-versioning.md)
  — the original three-scheme policy this document extends to six.
- [`derived-application-guide.md`](derived-application-guide.md) — the
  practical, step-by-step guide for a derived application author.
- [`docs/adr/0024-awcms-family-direct-use-templates-and-derived-pathway-removal.md`](../adr/0024-awcms-family-direct-use-templates-and-derived-pathway-removal.md)
  — the decision that removed this manifest mechanism (`extension.manifest.json`,
  `bun run extension:check`, and the `tests/fixtures/extension-contract-incompatible/`
  examples this section once linked). This document is retained as a historical note.

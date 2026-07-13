---
"awcms-mini": minor
---

Complete the `profile_identity` module (Issue #748, epic #738
platform-evolution Wave 2) into a full canonical party lifecycle: person/
organization CRUD/list/search/archive/restore, effective-dated identifiers
with provenance/verification/masking, effective-dated addresses/
communication channels, generic (non-hardcoded) party-to-party
relationships and authorized-representative records, deterministic +
heuristic duplicate-candidate detection (always reviewable, never
auto-merging), and an approval-gated, idempotent, concurrency-safe merge
workflow with immutable merge history. Adds a `PartyDirectoryPort`
capability (ADR-0011) and a `profile.merged` domain event (via
`domain_event_runtime`, Issue #742) so future domain modules can reference
parties without importing profile tables directly. Cross-tenant matching/
merge is strictly prohibited, enforced at both RLS and application layers.
New migration `059`, admin UI (`/admin/profile-identity`), OpenAPI/AsyncAPI
updates, and en/id i18n catalogs.

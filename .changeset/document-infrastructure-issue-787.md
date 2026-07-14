---
"awcms-mini": patch
---

Extend `document_infrastructure`'s confidentiality-tier read gating (Issue #751/PR #780) to the module's mutation endpoints and its two remaining read paths (Issue #787, disclosed fast-follow to that Critical fix).

- `void`, `restore`, `reclassify`, `versions.create`, `relations.assign`, and `relations.revoke` now require the caller to hold read clearance for the document's CURRENT confidentiality level (`documents_confidential.read`/`documents_restricted.read`) as a precondition — a caller holding only the action-specific permission (e.g. `documents.void`) can no longer void/restore/reclassify a `confidential`/`restricted` document, append a version to one, or link/unlink a resource relation on one, without also holding the matching tier permission. Denied attempts return the same "not found"-shaped result the read paths already use — never confirming the document's existence to an unauthorized caller.
- `GET .../evidence` and `GET .../reservations` now filter rows tied to a document (`document_id IS NOT NULL`) by that document's confidentiality level, at the SQL level (`LEFT JOIN` + `confidentiality_level = ANY(...)`); rows with no document link (sequence-only evidence, a reservation not yet committed) always pass through, since they have no confidentiality dimension.
- Design decision: reuses the two existing read-tier permissions (`sql/068`) as a precondition rather than introducing separate write-tier permissions — no new migration. See `docs/adr/0017-document-infrastructure-module-admission.md` §7 for the full rationale.
- 2 new integration tests covering all 8 newly-gated endpoints (deny with only the base/action permission, allow once the tier permission is added); ADR-0017, the threat model (doc 20), and the module README's "accepted fast-follow" disclosure updated to reflect this scope now being closed.

---
"awcms-mini": minor
---

feat(control-plane): add the bounded, masked, audited operator evidence export (#930)

`GET /api/v1/control-plane/tenants/{tenantId}/evidence` closes #930's
"operator evidence/export is bounded, masked, and audited" criterion. An
operator investigating a tenant's control-plane health gets shape and timing —
counts, statuses, timestamps, plan keys — and nothing customer-identifying.

**Two gates, because the permission alone would be a standing key to the
fleet.** The obvious design grants an `identity_access.support_access.export`
permission and stops. That would make every tenant's control-plane history
readable by any holder of it, at any time, with no record that anyone decided
the access was warranted. So the route requires that permission (evaluated in
the operator's own platform tenant) **and** an approved, unrevoked, unexpired
support-access grant for that specific target tenant. #879 already built grants
as maker/checker with a second approver, a recorded reason, and auto-expiry, so
the export inherits all of it and cannot outlive the authority that permitted
it. Without a live grant the answer is 403 — and the refusal is audited too,
because "who tried to read a tenant they had no grant for" is the more
interesting line in an investigation.

**Masked by construction, not by redaction.** The collector's row types have no
field capable of carrying a provider reference, envelope, token, secret, or
email address, so a careless `SELECT *` later has nowhere to put one.
Concretely: `last_error_class` (a bounded enum) is selected;
`last_error_message` in the adjacent column is not, because free text is where
identifiers end up. The integration test plants a customer email in exactly
that column and walks the whole package recursively — adding the field to the
output turns it red, which was verified by doing it.

**Bounded, and the bounding is reported.** The window is clamped to 90 days and
each section to 100 rows, with `clamped`/`truncated` in the response. "You
asked for a year and got 90 days" and "this tenant had no activity before then"
look identical in the data and mean opposite things. Sections use `LIMIT n + 1`
so overflow is observed rather than inferred.

Reads happen inside the target tenant's own RLS context (ADR-0022 §6b) —
authorization in the platform tenant, data in the target tenant, no query ever
seeing two tenants at once. Migration 107 seeds the permission on the existing
`support_access` activity rather than inventing a new one, so the existing SoD
rule keeps applying unchanged.

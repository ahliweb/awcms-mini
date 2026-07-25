---
"awcms-mini": minor
---

Payment gateway: make the webhook evidence tables retainable (Issue #932).

Four `payment_gateway` tables — `webhook_inbox`, `normalized_events`,
`processing_attempts`, `reconciliations` — could never have a row deleted at
runtime. Their `BEFORE UPDATE OR DELETE` triggers raised unconditionally, so
the effective boundary was not "the app role may not delete" (which is the
intended one) but "no role may delete, including the migration owner" —
verified empirically on a fresh database. The consequence was that no retention
period could be enforced on stored provider webhook evidence, a legal hold had
nothing to override, no contractual or data-subject erasure was possible, and
the module's highest-volume table grew with provider traffic and could never
shrink.

Migration `102` narrows those four triggers to `BEFORE UPDATE`. Every
in-place-edit protection is unchanged: the webhook inbox still permits exactly
one `received -> normalized` forward advance and freezes every other column,
and the three append-only tables still reject any UPDATE whatsoever. The DELETE
boundary moves from "impossible" to grants, which is the shape `usage_metering`
already uses for the identical tension (migration `087`): `awcms_mini_app` — the
role every HTTP request runs as — keeps no DELETE rights, and only
`awcms_mini_worker` gains them.

`payment-gateway/application/retention-purge.ts` becomes the single delete
path: bounded batches, FK-safe ordering, legal-hold aware, audited. Because a
parent row is always older than the child derived from it, age alone is not a
safe cutoff — each level deletes only rows with no surviving child, so evidence
ages out as a whole chain rather than in fragments that would leave an inbox row
with no outcome. A legal hold on any link of the chain blocks all three of its
tables (fail-closed); `reconciliations` is independent and held separately.

Also adds four `dataLifecycle` descriptors (400-day default, 180–2555 bounds),
retention-scan and child-FK indexes, the `bun run payment-gateway:purge` job,
and PostgreSQL integration tests covering FK-safe ordering, the
surviving-child guard, batch bounding, both legal-hold groupings, the unchanged
UPDATE protections, and the grant boundary — the last asserting SQLSTATE
`42501` specifically, since a bare "it threw" assertion is also satisfied by the
`23503` a seeded chain produces and stays green against a wrongly widened grant.

The stale descriptor tables in `docs/awcms-mini/data-lifecycle.md` are brought
up to date at the same time; they listed 4 of what are now 13 descriptors.

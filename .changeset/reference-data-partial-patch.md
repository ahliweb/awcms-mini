---
"awcms-mini": patch
---

fix(reference-data): `PATCH` on reference codes is now genuinely partial instead of behaving like `PUT`

`PATCH /api/v1/reference-data/tenant-codes/{id}` and
`PATCH /api/v1/reference-data/value-sets/{key}/codes/{code}` parsed their request
body with per-field defaults, so any field omitted from the body was silently
reset instead of preserved: `sortOrder` -> `0`, `metadata` -> `{}` (permanent
data loss), `validFrom` -> `now()` (truncating a code's validity history), and
`validTo` -> `null`. A client sending the normative partial `PATCH` — e.g. only
`labels` to rename a code — lost the other four fields and received a `200` with
no warning. Since reference data is load-bearing for downstream documents and
transactions, a silently rewritten `validFrom`/`validTo` window is a correctness
hazard, not just a cosmetic one.

Both endpoints now merge the parsed patch onto the stored record, with an
explicit and documented null-vs-absent contract:

- **absent** field — the stored value is kept untouched;
- **explicit `null`** — the field is cleared/reset (`sortOrder` -> `0`,
  `metadata` -> `{}`, `validTo` -> `null`);
- `labels` and `validFrom` reject `null` with a `400 VALIDATION_ERROR` (at least
  one label is always required, and `valid_from` is `NOT NULL`) rather than being
  silently defaulted;
- `labels` still replaces all stored labels wholesale, and `metadata` still
  replaces rather than deep-merges, when present.

`labels` is no longer a required property of either request body — an empty
`{}` body is a valid no-op. OpenAPI documents the semantics per field.

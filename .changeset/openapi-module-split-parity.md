---
"awcms-mini": minor
---

Split the public OpenAPI contract into per-module source fragments and enforce route-operation-security parity (Issue #695, epic #679, platform-hardening).

`openapi/awcms-mini-public-api.openapi.yaml` was a single 13,587-line hand-edited file — the existing `scripts/api-spec-check.ts` checker (Issue #685) verified basic shape, route-method parity, and the public-operation allow-list, but nothing proved every route method, operation ID, request schema, and security requirement matched the implementation exhaustively, and nothing stopped the file itself from growing further.

The contract is now split by the spec's own existing `tags` (already a clean 1:1 module boundary — every operation has exactly one tag, and every path's operations share that tag) into `openapi/awcms-mini-public-api.src.yaml` (root: `info`/`servers`/`tags`/`security`, `components.securitySchemes`/`parameters`/`responses`, and any schema shared by 2+ modules) plus one `openapi/modules/<module-key>.openapi.yaml` fragment per module/tag (26 files) owning that module's `paths` and module-exclusive `components.schemas`. New `scripts/openapi-bundle.ts` (`bun run openapi:bundle`) merges every fragment — module files loaded in a fixed alphabetical-by-filename order, paths and schemas re-sorted alphabetically on output — into the SAME published path, `openapi/awcms-mini-public-api.openapi.yaml`, which is now a GENERATED artifact (do not hand-edit). Bundling twice against unchanged sources is byte-identical (`tests/unit/openapi-bundle.test.ts`).

`scripts/api-spec-check.ts` gains five checks, additive to the Issue #685 checks (none removed or rewritten):

- `checkBundleFreshness` — the committed bundle must exactly match what `bun run openapi:bundle` produces right now from the source fragments.
- `checkOperationIdUniqueness` — every `operationId` must be globally unique (names both colliding locations on failure).
- `checkPathParameters` — every `{param}` in a path template must have exactly one matching `in: path, required: true` parameter declaration, and vice versa.
- `checkStandardErrorSchema` — every non-2xx/3xx response must resolve (directly, via `components.responses`, or through `allOf`/`oneOf`/`anyOf`) to the shared `ApiError` schema (`src/modules/_shared/api-response.ts`'s `fail()` envelope) rather than an ad-hoc inline error shape.
- `checkOperationSecurityMetadata` — extends (does not duplicate) the Issue #685 `checkPublicOperationAllowlist`: that check only handles explicit `security: []`; this one fails an operation that omits `security` entirely and isn't allow-listed, and validates every named scheme in a `security` requirement actually exists in `components.securitySchemes`.

`checkRouteParity`'s existing route-file/OpenAPI-operation parity is unchanged, and gains an explicit, reviewed `ROUTE_PARITY_EXEMPTIONS` list (same pattern as `CONFIG_EXEMPTIONS`, Issue #689, and `DYNAMIC_KEY_FAMILIES`, Issue #694) for a route deliberately internal or feature-flag-gated and not part of the public contract — empty today, every existing route already has a matching operation.

**One deliberate, explicitly-called-out API contract change** (not a silent side effect of the split): the top-level `tags` array was missing a "Tenant Domains" entry even though 7 operations already used that tag (`GET/POST/PATCH/DELETE /api/v1/tenant/domains*`, epic #555) — a pre-existing documentation gap this split's tag-usage analysis surfaced. Added the tag declaration (name + description) alongside the existing tags; no path, schema, or security requirement changed. Verified: parsed old vs. newly bundled spec are deep-equal in every respect except this one array insertion (checked programmatically, not by line-diff, given the file's size).

New tests: `tests/unit/openapi-bundle.test.ts` (determinism against the real fragments, freshness against the committed bundle, and synthetic fixtures for ordering/duplicate-path/duplicate-schema detection) and additions to `tests/unit/api-spec-check.test.ts` (fixtures proving each new check fails on the drift shape it targets, including one exercising the intentional overlap between `checkPublicOperationAllowlist` and `checkOperationSecurityMetadata` without duplicating assertions). `openapi/README.md`, `.claude/skills/awcms-mini-new-endpoint/SKILL.md`, `docs/awcms-mini/examples/minimal-domain-module.md`, and `AGENTS.md` document the new edit-fragment-then-bundle workflow.

---
"awcms-mini": minor
---

Run API spec, route parity, module graph, and i18n parity gates in CI (Issue #685, epic #679, platform-hardening).

`.github/workflows/ci.yml`'s `quality` job previously ran only a SUBSET of `bun run check`'s own steps — `api:spec:check` and `modules:dag:check` were missing entirely, so a contract or module-graph regression could merge to `main` with CI green. Both are now explicit named steps, in the same order `bun run check` runs them.

`scripts/api-spec-check.ts` gains two new checks: `checkRouteParity` cross-references every `src/pages/api/v1/**` route file's exported HTTP methods against the OpenAPI spec's `paths` (both directions — undocumented routes and stale documentation), and `checkPublicOperationAllowlist` fails if any OpenAPI operation becomes publicly documented (`security: []`) without a matching entry in a new reviewed `ALLOWED_PUBLIC_OPERATIONS` constant (currently just the 4 genuinely public endpoints: health x2, setup status/initialize) — or if an allow-list entry is no longer actually public.

New `tests/unit/module-boundary-cycles.test.ts` generalizes the single hardcoded blog_content/news_portal forbidden-cross-import check (Issue #681) into a registry-wide gate: for every pair of the 14 registered modules, a source-level circular `application`/`domain` import (A imports B's, B imports A's back) now fails, not just that one pair. Deliberately scoped to cycles, not "any cross-module import must be in `dependencies`" — a probe found several legitimate one-directional imports (e.g. `blog-content -> logging`) that a blanket rule would have flagged as unrelated pre-existing findings.

New `scripts/i18n-parity-check.ts` (`bun run i18n:parity:check`) compares `i18n/en.po`/`id.po`/`messages.pot` key sets using the same `.po` parser the runtime itself loads — a key present in `en.po` but missing from `id.po` was previously a silent, permanent translation gap (falls back to English, never surfaces as a bug). Found and fixed 204 real keys missing from the stale `messages.pot` template as part of wiring this in.

New `e2e-smoke` CI job runs the Playwright suite against a real app + isolated Postgres — previously E2E was documented as "run manually, no CI orchestration exists yet." Runs in two phases with separate server lifecycles: `admin-security-disabled.e2e.ts` and `admin-security-enabled.e2e.ts` assert opposite renders of the same page gated on a boot-time env var, discovered empirically to be unrunnable against one server instance.

CI hardening: Bun's install cache is now cached via `actions/cache` (keyed on `bun.lock`, `--frozen-lockfile` still runs every time — this only skips re-downloading, never skips the integrity check); failure diagnostics upload via `actions/upload-artifact` (build output / Playwright traces+logs, no secrets); every `uses:` action reference in `ci.yml`/`codeql.yml` is now pinned to a full commit SHA instead of a floating major-version tag; every job declares explicit least-required `permissions:` instead of inheriting the top-level default. New `docs/awcms-mini/branch-protection.md` documents the exact required-check names for a maintainer to configure branch protection (not yet enabled on `main` — this PR only documents it, doesn't apply it).

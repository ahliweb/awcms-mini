---
"awcms-mini": minor
---

Add a generated repository inventory and docs CI checks, and reconcile status/version claims (Issue #688, epic #679, platform-hardening).

A 2026-07-11 static repo audit found real docs/reality drift: a GitHub snapshot dated 2026-07-09 claiming 6 open issues while 33+ (now 35, re-verified live) were actually open; `SECURITY.md` still describing a "first target 0.1.0" while `package.json` had already reached `0.23.5` and the base generic backlog was complete; `CONTRIBUTING.md` and doc 08 naming the Docker Compose Postgres service `postgres` while the actual service is `db`; and a stale, mismatched module map in `AGENTS.md` (naming concerns like `localization-ui`/`database-connectivity`/`ui-experience` that don't correspond to any real `src/modules/` directory, and omitting `tenant-domain`/`visitor-analytics`/`news-portal` from the list of domain modules registered directly in this base repo).

New GENERATED artifact `docs/awcms-mini/repo-inventory.md` (`bun run repo:inventory:generate`, read-only freshness gate `bun run repo:inventory:check`, now part of `bun run check`) lists modules (from `listModules()`), migrations (`sql/*.sql`), tables & Row-Level Security (parsed from migrations, cross-checked against a reviewed `RLS_EXEMPT_TABLES` allow-list — zero unexplained gaps found), tests (file counts per `tests/` subdirectory), and a route/operation count summary from the bundled OpenAPI contract. It deliberately does not re-implement GitHub issue/label/milestone snapshotting (`docs/awcms-mini/github/`, `scripts/github-snapshot-refresh.ts`) or route<->contract parity (`scripts/api-spec-check.ts`'s `checkRouteParity`) — both already exist and are linked instead. Same "no embedded timestamp, regenerate-and-diff in CI" pattern as `docs/awcms-mini/api-reference.md` (Issue #700).

`scripts/check-docs.mjs` (`bun run check:docs`, part of `bun run check`) gains a new check: every `docker compose`/`docker-compose` command referenced in a fenced code block or inline code span across all tracked Markdown must use a service name that actually exists in `docker-compose.yml`/`docker-compose.prod.yml` — this is what caught the `postgres` vs `db` drift.

Fixed: `CONTRIBUTING.md` and doc 08's setup walkthrough now say `docker compose up -d db`; `SECURITY.md`'s Supported Versions table now reflects the real released version instead of a stale pre-0.1.0 placeholder; `AGENTS.md`'s module map now lists the actual 14 registered modules and documents where cross-cutting concerns (i18n, observability, pooling, security readiness) actually live (`src/lib/`, `scripts/`) instead of implying they're modules; `docs/awcms-mini/github/` refreshed to the live GitHub state (35 open, 156 closed, 99 labels, 25 milestones).

New skill `.claude/skills/awcms-mini-repo-inventory/SKILL.md` documents the regenerate workflow and how to add a new `RLS_EXEMPT_TABLES` entry when a genuinely global table is added.

Per the issue's own instruction, contract (`info.version`) and module descriptor (`version`/`status`) versioning were left untouched — that policy is ADR-0008/Issue #451's decision, already settled, and not mechanically forced to match the package version here.

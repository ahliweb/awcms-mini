# Branch Protection — Required Status Checks

Issue #685 (epic #679, platform-hardening) acceptance criterion: "Branch
protection documentation identifies required checks." This document is
that reference — it does **not** itself configure GitHub, and as of this
writing `main` has **no branch protection rule at all**
(`gh api repos/ahliweb/awcms-mini/branches/main/protection` returns
`404 Branch not protected`). Every check below already runs and reports
its status on every PR; none of them currently **block** a merge — a PR
with a failing check can still be merged today. Enabling branch protection
is a repo-admin, shared-state change (affects every contributor's merge
flow) and is deliberately left to a maintainer to apply explicitly, not
done automatically by this doc or by CI itself.

## Required status checks (recommended)

These are the exact check names GitHub reports for `.github/workflows/ci.yml`
and `.github/workflows/codeql.yml` — a branch protection rule's "required
status checks" list must reference these names verbatim (GitHub matches on
the job's `name:`, not its internal id):

| Check name (verbatim)                                  | Workflow / job                    | What it gates                                                                                                                                                                                        |
| ------------------------------------------------------ | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Quality (lint + docs + contracts + typecheck + test)` | `ci.yml` / `quality`              | Prettier, docs checks, `api:spec:check` (OpenAPI/AsyncAPI + route parity + public-operation allow-list), `modules:dag:check`, `i18n:parity:check`, typecheck, `bun test` (unit + integration), build |
| `E2E smoke (Playwright)`                               | `ci.yml` / `e2e-smoke`            | Real-browser smoke coverage against a live app + isolated Postgres (login, admin/security both gate states, admin/analytics access control)                                                          |
| `Repo hygiene (Bun-only + no secrets)`                 | `ci.yml` / `hygiene`              | Bun-only tooling convention, no committed `.env`, both `docker-compose*.yml` files parse                                                                                                             |
| `Analyze (actions)`                                    | `codeql.yml` / `analyze`          | CodeQL static analysis of GitHub Actions workflow files                                                                                                                                              |
| `Analyze (javascript-typescript)`                      | `codeql.yml` / `analyze`          | CodeQL static analysis (security-extended + security-and-quality queries) of the TypeScript/Astro source                                                                                             |
| `Changeset required for behavior changes`              | `changesets.yml` / `policy-check` | Issue #692: fails a PR touching non-docs/non-agent-tooling files without a new `.changeset/*.md` — see `release-process.md` §PR-time gate                                                            |

`GitGuardian Security Checks` (a GitHub App check, not a workflow file in
this repo) also already reports on every PR — include it in the required
list too if the org's GitGuardian integration is expected to stay enabled
long-term; it is not configured by anything in `.github/workflows/`, so
it isn't itemized above with the rest.

## Applying this (maintainer action, not automated)

Via the GitHub UI: **Settings → Branches → Add branch protection rule**,
pattern `main`, enable **Require status checks to pass before merging**,
then search for and add each check name from the table above (GitHub only
offers checks that have reported at least once — merge/re-run this PR
first if a check is missing from the picker). Recommended alongside it,
consistent with this repo's existing PR-based workflow (every merge in
this project's history has gone through a PR, never a direct push):
**Require a pull request before merging**, **Require branches to be up to
date before merging**.

Equivalent `gh api` command (run by a repo admin, adjust `required_status_checks.contexts`
if the check list above has since changed):

```bash
gh api -X PUT repos/ahliweb/awcms-mini/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  -f required_status_checks.strict=true \
  -f 'required_status_checks.contexts[]=Quality (lint + docs + contracts + typecheck + test)' \
  -f 'required_status_checks.contexts[]=E2E smoke (Playwright)' \
  -f 'required_status_checks.contexts[]=Repo hygiene (Bun-only + no secrets)' \
  -f 'required_status_checks.contexts[]=Analyze (actions)' \
  -f 'required_status_checks.contexts[]=Analyze (javascript-typescript)' \
  -f 'required_status_checks.contexts[]=Changeset required for behavior changes' \
  -f enforce_admins=true \
  -f required_pull_request_reviews=null \
  -f restrictions=null
```

(`required_pull_request_reviews=null`/`restrictions=null` here mean "don't
additionally require review approvals / don't restrict who can push" —
tighten those separately if desired; they're independent of the status
check requirement this doc is about.)

## Why `bun run check` and CI must stay the same source of truth

`package.json`'s `check` script is intentionally the same ordered list of
steps `.github/workflows/ci.yml`'s `quality` job runs one-by-one (Issue
#685) — `lint`, `check:docs`, `api:spec:check`, `modules:dag:check`,
`i18n:parity:check`, `typecheck`, `test`, `build`. Before this issue, CI
silently ran a SUBSET of `check` (missing `api:spec:check` and
`modules:dag:check` entirely), so a contract or module-graph regression
could pass CI and merge to `main` while `bun run check` would have caught
it locally. Whenever a new step is added to `bun run check`, add the
matching named step to `ci.yml`'s `quality` job in the same PR — the two
drifting apart again is exactly the failure mode this issue exists to
close.

## Lihat juga

- [`06_github_issues_detail.md`](06_github_issues_detail.md) — issue
  #685's own body and epic #679 (platform-hardening).
- [`07_sprint_testing_production_readiness.md`](07_sprint_testing_production_readiness.md)
  — testing pyramid and production readiness checklist this CI
  orchestration serves.
- `.claude/skills/awcms-mini-browser-test/SKILL.md` — E2E spec-writing
  conventions; its own "Status" section previously noted E2E was
  "belum bagian dari CI" (not yet part of CI) — Issue #685 is the issue
  that closed that gap, referenced there.
- `.github/workflows/ci.yml` / `.github/workflows/codeql.yml` — the
  actual workflow definitions this doc describes.
- [`release-process.md`](release-process.md) — Issue #692's
  `changesets.yml` (PR-time changeset policy gate, table row above) and
  `release.yml` (tag-triggered build/SBOM/sign/attest/publish pipeline),
  including its own repo-admin manual step (the `release` GitHub
  Environment's required reviewers) that follows this same "document, don't
  self-apply" pattern.

# AI Workflow Planning Templates

## Purpose

This document provides small, reusable prompt templates for common AI-assisted workflows in AWCMS Mini.

Use these templates as workflow starters, not as authority. The authority order remains:

1. `REQUIREMENTS.md`
2. `AGENTS.md`
3. `README.md`
4. `DOCS_INDEX.md`
5. the focused document for the task

## Rules For Every Template

- Keep AWCMS Mini EmDash-first.
- Start from a GitHub issue or create one before repository modifications.
- Keep changes atomic and dependency-aware.
- Document the real repository state, not aspirational completion.
- Validate with the repo baseline plus any issue-specific checks.

## Current Repository Baseline

Use these as the default current-state assumptions when adapting any template in this document.

- EmDash `0.5.0` remains the canonical host architecture.
- AWCMS Mini remains single-tenant and PostgreSQL-backed.
- PostgreSQL is hosted on a protected VPS managed through Coolify.
- Cloudflare-hosted Worker runtime is the supported app-hosting baseline.
- The public hostname baseline is `SITE_URL=https://awcms-mini.ahlikoding.com`.
- An optional admin hostname baseline is `ADMIN_SITE_URL=https://awcms-mini-admin.ahlikoding.com`, and it remains an entry host for the same EmDash admin surface under `/_emdash/admin`.
- `wrangler.jsonc` currently declares Worker custom domains for the public and admin hostnames plus the `MEDIA_BUCKET` binding for R2 bucket `awcms-mini-s3`.
- Turnstile currently protects the public login, password-reset request, and invite-activation flows when configured.
- Turnstile validation is server-side and supports hostname allowlists through `TURNSTILE_EXPECTED_HOSTNAMES`, with fallback derivation from `SITE_URL` and `ADMIN_SITE_URL`.
- The versioned external/mobile API baseline lives under `/api/v1/*` and currently includes `/api/v1/health`, `/api/v1/token`, and `/api/v1/session`.
- Edge API access tokens are short-lived JWT Bearer tokens and refresh tokens are opaque, hashed, and rotation-backed in PostgreSQL.
- The repository uses issue-driven execution and expects issues to be atomic with explicit validation.
- `pnpm check` is the default baseline validation path for routine implementation work.
- `pnpm lint` covers the maintained docs/config surface with Prettier rather than the full repository.

## Security And Operator Guardrails

- Keep OWASP-aligned server-side validation, least-privilege assumptions, and audit coverage explicit in prompts.
- Treat Cloudflare-managed secrets, Worker bindings, and custom domains as deployment/runtime seams, not as an in-app control plane.
- Keep Turnstile, edge auth, and R2 guidance consistent with the current Cloudflare-hosted runtime docs.
- Keep PostgreSQL recovery, transport, and access-control assumptions aligned with the Coolify-managed VPS baseline.
- Prefer host-only cookies unless a reviewed operator workflow requires cross-host sharing.
- Never describe rollout-only controls such as ABAC audit-only mode as the permanent steady-state policy model.

## Documentation Update Template

Use when the task is primarily documentation or runbook maintenance.

```text
Update AWCMS Mini documentation for the following scoped task:

Task:
<describe the docs task>

Requirements:
- Read `REQUIREMENTS.md`, `AGENTS.md`, `README.md`, `DOCS_INDEX.md`, and the most relevant focused docs first.
- Confirm the current implementation state before editing docs.
- Do not overstate rollout completeness.
- Keep the docs aligned with EmDash-first architecture, the Cloudflare-hosted Worker baseline, and PostgreSQL on a Coolify-managed VPS.
- Reflect the current split-hostname, Turnstile, R2, and edge-auth baselines when they are relevant to the task.
- Update index or cross-reference docs when adding a new maintained document.
- Recommend validation commands and operator impact where relevant.

Output:
- concise summary of the real-state documentation changes
- files to update
- any follow-on issues that should be created if the docs reveal missing implementation work
```

## Feature Planning Template

Use when the task is to create a plan or recommendations before implementation.

```text
Create an issue-driven implementation plan for this AWCMS Mini feature:

Feature:
<describe the feature>

Constraints:
- EmDash remains the host architecture.
- PostgreSQL remains the single system of record.
- Mini work must stay additive in services, plugins, admin extensions, and edge routes.
- Cloudflare-hosted Worker runtime is the supported app runtime baseline.
- The database runs on a Coolify-managed VPS.
- Public and admin hostnames may be split, but they must still terminate on the same EmDash-first app surface unless an issue explicitly scopes a different architecture.

Planning tasks:
- summarize the current repository baseline for this feature
- identify confirmed gaps only
- recommend an execution order with atomic issues
- include security, operator, and validation notes
- align terminology with current EmDash descriptor, plugin, and auth conventions
- call out Cloudflare-specific runtime assumptions such as custom domains, Turnstile hostname validation, Worker bindings, or `/api/v1/*` edge routes when relevant

Output:
- a concise plan section or document outline
- a proposed issue breakdown with acceptance criteria
```

## Implementation Execution Template

Use when the task is to implement an already scoped issue.

```text
Implement the scoped AWCMS Mini issue below.

Issue:
<issue title and scope>

Workflow rules:
- inspect the current code first
- keep the change minimal and issue-scoped
- prefer shared services and existing authorization helpers over ad hoc route logic
- do not create a second platform core beside EmDash
- update tests and focused docs as needed
- run `pnpm check` plus issue-specific checks unless the issue is docs-only
- use `pnpm lint` for docs/config-only changes
- keep Cloudflare-hosted runtime assumptions, Coolify-managed PostgreSQL assumptions, and current hostname/edge-auth behavior accurate in any touched docs
- close the issue only after validation succeeds

Output:
- completed implementation
- validation results
- any residual risks or follow-on issues
```

## Security Review Template

Use when reviewing a proposed change, route, or architecture update.

```text
Review the following AWCMS Mini change with a code-review mindset focused on security and correctness:

Change:
<describe the change>

Review focus:
- authentication and authorization correctness
- EmDash-first architecture compliance
- Cloudflare Worker, custom-domain, Turnstile, R2 binding, and secret-handling assumptions
- PostgreSQL and Coolify trust-boundary implications
- OWASP-aligned error handling, token handling, and audit coverage
- missing tests or validation gaps

Output:
- findings first, ordered by severity
- open questions or assumptions
- only brief summary after findings
```

## Release Or Migration Template

Use when changing deployment, migration, or operator-facing runbooks.

```text
Plan or update the deployment and migration guidance for this scoped AWCMS Mini change:

Change:
<describe deployment-affecting work>

Requirements:
- keep the guidance consistent with the Cloudflare-hosted Worker runtime and PostgreSQL on a Coolify-managed VPS
- call out required runtime variables, bindings, secrets, and migration order
- identify rollback and recovery considerations
- update any checklist or runbook references affected by the change
- keep claims aligned with the current implementation state
- include hostname, Turnstile, R2, or `/api/v1/*` smoke tests when the scoped change touches those surfaces

Output:
- the required docs or checklist updates
- validation or smoke-test commands
- operator-facing risks or sequencing notes
```

## Suggested Validation By Change Type

- docs-only changes: `pnpm lint`
- runtime/config/doc changes that alter deployment assumptions: `pnpm lint` plus focused smoke-test guidance updates
- TypeScript, Astro, runtime, service, auth, or route changes: `pnpm check`
- focused behavioral changes: targeted `node --test ...` or `pnpm test:unit -- ...` in addition to the baseline

## When To Create Follow-On Issues

- Create a follow-on issue if the doc refresh reveals a missing implementation seam, rollout caveat, or operator gap that should not be folded into the current change.
- Do not create follow-on issues for wording-only cleanup that is already resolved by the current scoped edit.
- If Cloudflare account visibility or provisioning capability is unavailable in the current tool session, document that caveat explicitly and create a follow-on issue only if repository changes alone cannot close the operational gap.

## Cross-References

- `docs/process/github-issue-workflow.md`
- `docs/process/cloudflare-hosted-runtime.md`
- `docs/process/runtime-smoke-test.md`
- `docs/process/migration-deployment-checklist.md`
- `docs/process/cloudflare-edge-jwt-permissions-ai-plan-2026.md`
- `docs/process/cloudflare-platform-expansion-plan-2026.md`
- `docs/process/cloudflare-hostname-turnstile-r2-automation-plan-2026.md`
- `awcms_mini_emdash_implementation_planning_prompt.md`

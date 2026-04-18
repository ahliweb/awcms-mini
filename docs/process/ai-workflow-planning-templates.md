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
- Keep the docs aligned with EmDash-first architecture, Cloudflare hosting, and PostgreSQL on a Coolify-managed VPS.
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
- Cloudflare is the supported app runtime baseline.
- The database runs on a Coolify-managed VPS.

Planning tasks:
- summarize the current repository baseline for this feature
- identify confirmed gaps only
- recommend an execution order with atomic issues
- include security, operator, and validation notes
- align terminology with current EmDash descriptor, plugin, and auth conventions

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
- run the baseline validation plus issue-specific checks
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
- Cloudflare edge and secret-handling assumptions
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
- keep the guidance consistent with Cloudflare-hosted runtime and PostgreSQL on a Coolify-managed VPS
- call out required runtime variables, bindings, secrets, and migration order
- identify rollback and recovery considerations
- update any checklist or runbook references affected by the change
- keep claims aligned with the current implementation state

Output:
- the required docs or checklist updates
- validation or smoke-test commands
- operator-facing risks or sequencing notes
```

## Cross-References

- `docs/process/github-issue-workflow.md`
- `docs/process/cloudflare-edge-jwt-permissions-ai-plan-2026.md`
- `docs/process/cloudflare-platform-expansion-plan-2026.md`
- `awcms_mini_emdash_implementation_planning_prompt.md`

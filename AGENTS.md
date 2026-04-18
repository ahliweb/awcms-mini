# AI Agent Guidance

This file provides repository-local guidance to AI coding agents working in AWCMS Mini.

## Documentation Authority

All agent work must respect this order:

1. `REQUIREMENTS.md`
2. `AGENTS.md`
3. `README.md`
4. `DOCS_INDEX.md`
5. focused implementation and operator docs under `docs/**`

If a lower-priority document conflicts with a higher-priority one, follow the higher-priority document.

## Project Shape

AWCMS Mini is:

- EmDash-first
- single-tenant
- PostgreSQL-backed
- Kysely-based
- governance-overlay focused

It is not:

- a multi-tenant platform
- a Supabase-based runtime
- a second admin shell outside EmDash
- a replacement for EmDash core architecture

## Core Execution Rules

1. Extend EmDash; do not recreate a parallel platform core.
2. Keep Mini-specific work in governance overlays, services, plugins, and admin extensions.
3. Prefer explicit service-layer enforcement over UI-only logic.
4. Use shared plugin helpers in `src/plugins/` instead of duplicating permission, auth, audit, or region-scoping logic.
5. Keep jobs, roles, logical regions, and administrative regions as separate concepts.

## Required Reading By Task Type

### Governance Or Security Work

Read:

1. `docs/architecture/constraints.md`
2. `docs/architecture/overview.md`
3. relevant docs under `docs/governance/` and `docs/security/`

### Plugin Work

Read:

1. `docs/plugins/contract-overview.md`
2. `docs/plugins/permission-registration.md`
3. `src/plugins/internal-governance-sample/index.mjs`

### Admin Work

Read:

1. `docs/admin/operations-guide.md`
2. `src/plugins/awcms-users-admin/index.mjs`
3. `src/plugins/awcms-users-admin/admin.tsx`

### Documentation Work

Read:

1. `docs/README.md`
2. `skills/awcms-mini-docs/SKILL.md`

## Current Repository Skills

- `skills/awcms-mini-governance-overlay/SKILL.md`
- `skills/awcms-mini-docs/SKILL.md`

Use them when the task matches their scope.

## Validation Guidance

- Use targeted unit tests first.
- Run `pnpm typecheck` for UI or TypeScript-adjacent work.
- Run `pnpm test:unit` when a change touches shared behavior.
- Review operator impact against:
  - `docs/process/migration-deployment-checklist.md`
  - `docs/security/emergency-recovery-runbook.md`

## Current Accuracy Notes

Agents should not overstate the current implementation.

In particular:

- staged mandatory 2FA rollout configuration exists, but enforcement/persistence should be treated carefully and verified against current runtime behavior before documenting it as fully complete
- ABAC audit-only rollout exists and should be documented as a rollout tool, not a permanent policy mode

## Workflow Note

The repository has historically followed an issue-driven workflow, but there may be moments when no open GitHub issue exists for a new local-docs or housekeeping request. In those cases, still keep changes atomic and well-scoped.

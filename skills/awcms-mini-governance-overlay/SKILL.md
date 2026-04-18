---
name: awcms-mini-governance-overlay
description: Use this skill when implementing or reviewing AWCMS Mini governance features on top of EmDash, including roles, permissions, ABAC, jobs, regions, security controls, admin extensions, and governance-aware plugins.
---

# AWCMS Mini Governance Overlay

AWCMS Mini is EmDash-first. Governance features must be added as overlays, not as a second platform core.

## Use This Skill For

- roles and permission work
- ABAC or route-guard changes
- jobs, logical regions, or administrative regions
- security-hardening flows such as 2FA, lockouts, password reset, and step-up
- admin extensions in `awcms-users-admin`
- governance-aware plugin contract work

## Core Rules

1. EmDash owns the host architecture, admin shell, and plugin model.
2. Mini owns governance overlays only.
3. Prefer explicit service-layer enforcement over UI-only logic.
4. Prefer shared helpers over route-by-route duplication.
5. Keep jobs, roles, and regions as separate concepts.

## Required Reading Order

1. `REQUIREMENTS.md`
2. `docs/architecture/constraints.md`
3. `docs/architecture/overview.md`
4. Relevant domain docs under `docs/governance/`, `docs/security/`, `docs/plugins/`, and `docs/admin/`

## Implementation Guidance

- For authorization work, inspect `src/services/authorization/` first.
- For security-policy work, inspect `src/security/policy.mjs` and `src/plugins/awcms-users-admin/` together.
- For plugin work, use the shared helpers under `src/plugins/` instead of open-coding permission, auth, audit, or region logic.
- For admin work, preserve the EmDash-hosted admin surface and keep changes inside the plugin-admin extension flow.

## Validation Guidance

- Prefer targeted unit tests first.
- Run `pnpm typecheck` for UI or TypeScript-adjacent changes.
- For rollout or security changes, review `docs/process/migration-deployment-checklist.md` and `docs/security/emergency-recovery-runbook.md` for operator impact.

## Related Documents

- `docs/governance/auth-and-authorization.md`
- `docs/governance/roles.md`
- `docs/governance/jobs.md`
- `docs/governance/regions.md`
- `docs/security/operations.md`
- `docs/plugins/contract-overview.md`

---
name: awcms-mini-docs
description: Use this skill when writing or updating repository documentation for AWCMS Mini, especially requirements, architecture, governance, security, plugin, and operator-facing docs.
---

# AWCMS Mini Documentation

This repository now has a compact documentation set that should stay aligned with the implemented system and the EmDash-first architecture.

## Documentation Style

- Keep repository-level docs concise and operational.
- Prefer short sections with explicit headings and bullets.
- Distinguish EmDash core from the Mini overlay whenever a document covers system behavior.
- Cross-reference existing docs instead of duplicating long explanations.

## Primary Documentation Set

- `REQUIREMENTS.md`
- `docs/architecture/overview.md`
- `docs/architecture/constraints.md`
- `docs/governance/*.md`
- `docs/security/*.md`
- `docs/plugins/*.md`
- `docs/admin/*.md`
- `docs/process/*.md`

## Required Checks For Doc Updates

1. Confirm the docs match the current implementation, not just the original plan.
2. Link to operator runbooks or deployment checklists when a feature has operational impact.
3. Keep the EmDash-first rule explicit for architecture or extension topics.
4. Avoid promising behavior that is not actually wired in code.

## When Adding New Docs

- Put architecture guidance in `docs/architecture/`
- Put governance domain docs in `docs/governance/`
- Put security procedures in `docs/security/`
- Put plugin guidance in `docs/plugins/`
- Put admin operating guidance in `docs/admin/`
- Put release and workflow docs in `docs/process/`

## Related Documents

- `REQUIREMENTS.md`
- `docs/architecture/overview.md`
- `docs/security/emergency-recovery-runbook.md`
- `docs/process/migration-deployment-checklist.md`

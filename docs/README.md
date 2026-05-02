# AWCMS Mini Docs

This directory contains the maintained architecture, governance, security, plugin, admin, and process documentation for AWCMS Mini.

## Read In This Order

1. `../REQUIREMENTS.md`
2. `../AGENTS.md`
3. `../README.md`
4. `../DOCS_INDEX.md`
5. the focused document for your task

## Folder Map

- `architecture/` - architecture constraints and repository/runtime guidance
- `governance/` - auth, roles, jobs, and regions guidance
- `security/` - security operations, recovery, and rate-limit strategy
- `plugins/` - plugin governance contract docs
- `admin/` - admin operating guidance
- `process/` - workflow, runtime validation, and deployment docs

Current planning reference:

- `process/repository-docs-and-secret-handling-recommendations-2026.md` - current recommendations and issue breakdown for refreshing docs, skills, planning templates, and secret-handling guidance
- `process/emdash-alignment-and-security-plan-2026.md` - EmDash alignment and security recommendations backlog source
- `process/cloudflare-platform-expansion-plan-2026.md` - next-stage Cloudflare platform and feature expansion recommendations
- `process/cloudflare-edge-jwt-permissions-ai-plan-2026.md` - next-stage JWT edge auth, permission matrix, and AI workflow planning recommendations
- `process/cloudflare-hostname-turnstile-r2-automation-plan-2026.md` - next-stage Cloudflare hostname, Turnstile, and R2 automation recommendations
- `process/secret-hygiene-coolify-cloudflare-topology-plan-2026.md` - secret hygiene, Coolify MCP, and Cloudflare topology recommendations
- `process/secret-hygiene-audit.md` - audit checklist and cleanup rules for scripts, config examples, and operator secret handling
- `process/emdash-ledger-repair-runbook.md` - operator-only inspection and repair flow for the EmDash `_emdash_migrations` ledger during issue-scoped compatibility work
- `process/coolify-mcp-secret-handling.md` - supported local-only secret handling pattern for Coolify MCP access
- `process/coolify-deployment.md` - current deployment guide for Cloudflare Pages plus Hono on Coolify with PostgreSQL on the Coolify-managed VPS
- `process/cloudflare-pages-vs-workers-decision.md` - historical decision context from the earlier Worker-first deployment phase
- `process/ai-workflow-planning-templates.md` - reusable AI workflow templates for docs, planning, implementation, and review tasks

Current active planning and documentation issues reflected by these docs:

- none. The current verification and operator issues are closed.

Current verification note:

- `#260` and `#261` are closed.
- Current Coolify posture audits still show the accepted metadata gaps, but the credential rotation and live runtime validation are complete.

Recently completed operator cleanup:

- `#261` - operator secret rotation and lock verification for Coolify-managed runtime secrets
- `#260` - final verification umbrella for the current architecture sync and runtime acceptance gate
- `#268` - operator removal of Cloudflare Tunnel and cloudflared from the Coolify-managed server

## Accuracy Rule

These docs should describe the real repository state, not just the intended plan. When implementation and planning diverge, update the docs to match the current code and call out rollout caveats explicitly.

## Validation Baseline

- `pnpm check` is the default aggregate validation path for routine local changes.
- `pnpm lint` and `pnpm format` currently use Prettier on the maintained docs/config surface, not the entire repository.
- Keep any issue-specific validation commands in addition to that baseline.

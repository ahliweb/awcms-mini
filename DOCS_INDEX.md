# Documentation Index

This file maps the current documentation set for AWCMS Mini.

## Core Documents

- `README.md` - repository entrypoint and operational summary
- `REQUIREMENTS.md` - baseline product and implementation requirements
- `AGENTS.md` - repo-local AI agent guidance
- `SECURITY.md` - repository security reporting and support policy

## Documentation Folders

### Architecture

- `docs/architecture/overview.md`
- `docs/architecture/constraints.md`
- `docs/architecture/secure-modular-monolith.md` (standar default modular monolith, boundary modul, Bun/TypeScript)
- `docs/architecture/repository-layout.md`
- `docs/architecture/database-access.md` (termasuk Connection Pooler: mode Session/Transaction, ADR-013)
- `docs/architecture/database-migrations.md`
- `docs/architecture/runtime-config.md`
- `docs/architecture/naming-conventions.md`
- `docs/architecture/emdash-touchpoint-inventory.md` (inventaris ketergantungan EmDash; decoupling ADR-020)
- `docs/architecture/ahliweb-architecture-decisions.md` (matriks ADR-013…023 per produk; source of truth: personal-coding)

### Governance

- `docs/governance/auth-and-authorization.md`
- `docs/governance/permission-matrix.md`
- `docs/governance/roles.md`
- `docs/governance/jobs.md`
- `docs/governance/regions.md`

### Security

- `docs/security/operations.md`
- `docs/security/database-concurrency.md` (pencegahan race condition PostgreSQL; helper `src/db/concurrency.mjs`, #360)
- `docs/security/emergency-recovery-runbook.md`
- `docs/security/rate-limit-storage-strategy.md`
- `docs/security/security-baseline.md`
- `docs/security/turnstile-integration.md`
- `docs/security/two-factor-authentication.md`
- `docs/security/abac-rbac-design.md`

### Deployment

- `docs/deployment/coolify.md`
- `docs/deployment/cloudflare-pages.md`
- `docs/deployment/cloudflare-r2.md`
- `docs/deployment/postgresql-docker.md`
- `docs/deployment/environment-variables.md`
- `docs/deployment/production-readiness-checklist.md`

### API

- `docs/api/openapi.md`

### Integrations

- `docs/integrations/mailketing.md`
- `docs/integrations/starsender.md`
- `docs/integrations/notifications.md`

### Database

- `docs/database/migration-workflow.md`
- `docs/database/backup-restore.md`
- `docs/database/schema-overview.md`

### Development

- `docs/development/local-dev-guide.md`

### Plugins

- `docs/plugins/contract-overview.md`
- `docs/plugins/permission-registration.md`

### Admin

- `docs/admin/operations-guide.md`

### Process

- `docs/process/github-issue-workflow.md`
- `docs/process/coolify-deployment.md`
- `docs/process/cloudflare-pages-deployment.md`
- `docs/process/runtime-smoke-test.md`
- `docs/process/migration-deployment-checklist.md`
- `docs/process/cloudflare-coolify-origin-hardening.md`
- `docs/process/cloudflare-hosted-runtime.md`
- `docs/process/cloudflare-pages-vs-workers-decision.md`
- `docs/process/cloudflare-platform-expansion-plan-2026.md`
- `docs/process/cloudflare-edge-jwt-permissions-ai-plan-2026.md`
- `docs/process/cloudflare-hostname-turnstile-r2-automation-plan-2026.md`
- `docs/process/secret-hygiene-coolify-cloudflare-topology-plan-2026.md`
- `docs/process/secret-hygiene-audit.md`
- `docs/process/emdash-ledger-repair-runbook.md`
- `docs/process/coolify-mcp-secret-handling.md`
- `docs/process/ai-workflow-planning-templates.md`
- `docs/process/repository-docs-and-secret-handling-recommendations-2026.md`
- `docs/process/postgresql-vps-hardening.md`
- `docs/process/emdash-alignment-and-security-plan-2026.md`
- `docs/process/emdash-sync-atomic-issue-map-2026.md`
- `docs/process/operator-secret-rotation-checklist-261.md`
- `docs/process/operator-cloudflared-removal-checklist-268.md`
- `docs/process/infrastructure-resource-setup.md`

### Supporting Reference

- `docs/administrative-region-source-data.md`

## Planning Artifacts

- `awcms_mini_implementation_plan.md`
- `awcms_mini_atomic_backlog.md`
- `awcms_mini_emdash_implementation_planning_prompt.md`

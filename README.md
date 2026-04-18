# AWCMS Mini

AWCMS Mini is an EmDash-first, single-tenant governance overlay built on Astro, PostgreSQL, Kysely, and the EmDash CMS integration.

It keeps EmDash as the host architecture and adds Mini-specific governance features for:

- user lifecycle management
- RBAC and ABAC authorization
- protected roles and staff-level rules
- job hierarchy and job assignments
- logical and administrative region governance
- TOTP-based 2FA, recovery, lockouts, and step-up
- audit logs and security events
- governance-aware internal plugin contracts
- EmDash admin extensions for governance operations

## Current Status

This repository is implementation-heavy and now includes:

- the main governance and security schema
- service-layer authorization and rollout helpers
- the `awcms-users-admin` admin extension
- plugin governance contract helpers
- operator documentation for recovery and deployment validation

Known current conditions:

- mandatory 2FA rollout configuration exists in the admin/security policy model
- ABAC audit-only rollout flags exist in the authorization service
- some rollout and persistence hardening work is still needed before treating those controls as fully production-complete across multi-instance deployments

## Tech Stack

- Astro `6.1.6`
- React `19.2.0`
- EmDash `0.5.0`
- PostgreSQL
- Kysely `0.28.16`
- Node adapter via `@astrojs/node`

## Quick Start

1. Install dependencies:

```bash
pnpm install
```

2. Set `DATABASE_URL` if you are not using the local default.

3. Apply migrations:

```bash
pnpm db:migrate
```

4. Start the dev server:

```bash
pnpm dev
```

5. Validate runtime health:

```bash
pnpm healthcheck
```

The EmDash-hosted admin surface runs under `/_emdash/admin`.

## Common Commands

```bash
pnpm typecheck
pnpm test:unit
pnpm build
pnpm healthcheck
pnpm db:migrate
pnpm db:migrate:status
pnpm db:migrate:down
pnpm db:seed:administrative-regions
```

## Repository Structure

```text
src/
  auth/          Mini auth handlers, middleware, and step-up flows
  config/        runtime config parsing
  db/            Kysely client, migrations, repositories, transactions
  integrations/  Astro + EmDash integration wiring
  plugins/       admin extension and plugin governance helpers
  security/      policy and runtime security helpers
  services/      governance, audit, security, and authorization services
tests/unit/      unit coverage for services, plugin helpers, and admin flows
docs/            architecture, governance, security, plugin, admin, and process docs
skills/          local repository skills for recurring AI-assisted tasks
```

## Documentation Authority

Use this order when reading or updating repository guidance:

1. `REQUIREMENTS.md`
2. `AGENTS.md`
3. `README.md`
4. `DOCS_INDEX.md`
5. focused docs under `docs/**`

## Core Documents

- `REQUIREMENTS.md` - repository requirements baseline
- `AGENTS.md` - agent execution rules and repo-specific guidance
- `DOCS_INDEX.md` - documentation map
- `docs/README.md` - docs folder entrypoint
- `docs/architecture/overview.md` - system summary
- `docs/process/migration-deployment-checklist.md` - release checklist
- `docs/security/emergency-recovery-runbook.md` - recovery guidance

## Related Notes

- The repository follows an issue-driven workflow documented in `docs/process/github-issue-workflow.md`.
- The current codebase is intentionally EmDash-first and must not drift toward a second standalone CMS core.

## License

See `LICENSE.md`.

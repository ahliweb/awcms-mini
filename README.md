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
- Cloudflare adapter via `@astrojs/cloudflare`
- Node adapter via `@astrojs/node` kept only as an explicit fallback build target during migration

## Quick Start

1. Install dependencies:

```bash
pnpm install
```

2. Set the runtime environment values you need for the target deployment.

Required production baseline:

- `DATABASE_URL`
- `MINI_RUNTIME_TARGET=cloudflare`
- `SITE_URL`
- `MINI_TOTP_ENCRYPTION_KEY`
- `TRUSTED_PROXY_MODE=cloudflare` for the supported Cloudflare-hosted path

Recommended public abuse-defense settings:

- `TURNSTILE_SITE_KEY`
- `TURNSTILE_SECRET_KEY`
- optional `TURNSTILE_EXPECTED_HOSTNAME`

When configured, Turnstile currently protects the public login, password-reset request, and invite-activation flows.

R2 storage baseline when object storage is enabled:

- `R2_MEDIA_BUCKET_BINDING`
- optional `R2_MEDIA_BUCKET_NAME`
- `R2_MAX_UPLOAD_BYTES`
- `R2_ALLOWED_CONTENT_TYPES`

Edge API baseline:

- `/api/v1/health` for versioned public health checks
- `/api/v1/session` for current-session inspection and self-revocation
- `EDGE_API_ALLOWED_ORIGINS` for any explicit cross-origin browser clients
- `EDGE_API_MAX_BODY_BYTES` for request-size enforcement

For remote PostgreSQL deployments, `DATABASE_URL` should target the protected VPS host and use a non-superuser application role.

`APP_SECRET` should also be set when your host auth/session runtime depends on it. Mini currently falls back to `APP_SECRET` only if `MINI_TOTP_ENCRYPTION_KEY` is not set.

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

Cloudflare-hosted deployment baseline:

- `pnpm build` produces the Worker bundle
- `pnpm deploy:cloudflare` deploys via Wrangler
- `wrangler.jsonc` defines the Worker, assets, observability, and optional Hyperdrive binding placeholders
- Astro's Cloudflare adapter uses the default `SESSION` KV binding for sessions unless you override it explicitly

## Common Commands

```bash
pnpm check
pnpm lint
pnpm format
pnpm typecheck
pnpm test:unit
pnpm build
pnpm healthcheck
pnpm db:migrate
pnpm db:migrate:status
pnpm db:migrate:down
pnpm db:seed:administrative-regions
```

Validation baseline:

- Use `pnpm check` as the default local pre-change validation path.
- `pnpm lint` and `pnpm format` currently cover the maintained docs/config surface with Prettier.
- Keep issue-specific validation commands in addition to the baseline when a task requires them.

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

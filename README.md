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
- optional `ADMIN_SITE_URL` for a dedicated admin hostname that still points to the same EmDash admin surface
- `MINI_TOTP_ENCRYPTION_KEY`
- `TRUSTED_PROXY_MODE=cloudflare` for the supported Cloudflare-hosted path

Recommended public abuse-defense settings:

- `TURNSTILE_SITE_KEY`
- `TURNSTILE_SECRET_KEY`
- optional `TURNSTILE_EXPECTED_HOSTNAME`
- optional `TURNSTILE_EXPECTED_HOSTNAMES` for split public/admin hostnames

When configured, Turnstile currently protects the public login, password-reset request, and invite-activation flows.
For split public/admin hostnames, the runtime now derives the expected Turnstile hostnames from `SITE_URL` and `ADMIN_SITE_URL` unless you set `TURNSTILE_EXPECTED_HOSTNAMES` explicitly.

R2 storage baseline when object storage is enabled:

- `R2_MEDIA_BUCKET_BINDING=MEDIA_BUCKET`
- `R2_MEDIA_BUCKET_NAME=awcms-mini-s3`
- `R2_MAX_UPLOAD_BYTES`
- `R2_ALLOWED_CONTENT_TYPES`

Edge API baseline:

- `/api/v1/health` for versioned public health checks
- `/api/v1/token` for password and refresh-token grants for mobile or external clients
- `/api/v1/session` for current-session inspection and self-revocation
- `EDGE_API_ALLOWED_ORIGINS` for any explicit cross-origin browser clients
- `EDGE_API_MAX_BODY_BYTES` for request-size enforcement
- `EDGE_API_JWT_SECRET` for Bearer-token signing and verification
- optional `EDGE_API_JWT_ISSUER` and `EDGE_API_JWT_AUDIENCE`
- `EDGE_API_ACCESS_TOKEN_TTL_SECONDS` and `EDGE_API_REFRESH_TOKEN_TTL_SECONDS`

Current token behavior:

- `/api/v1/token` supports `password` and `refresh_token` grant types
- access tokens are short-lived JWT Bearer tokens signed with `jose`
- refresh tokens are opaque, hashed at rest in PostgreSQL, and rotated on use
- enrolled 2FA users must satisfy TOTP or recovery-code challenge during the password grant
- protected `/api/v1/*` routes accept Bearer tokens and still keep the host identity session as a compatibility fallback

For remote PostgreSQL deployments, `DATABASE_URL` should target the reviewed SSL hostname `id1.ahlikoding.com`, prefer `sslmode=verify-full` when certificate validation is available, and use a non-superuser application role.

If production must temporarily run before hostname validation is fully ready, keep TLS required with an explicitly reviewed interim mode such as `sslmode=require` and track the follow-on hardening work rather than silently weakening transport defaults.

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

The reviewed browser entry for the EmDash-hosted admin surface is `/_emdash/`, which redirects into the current EmDash admin surface under `/_emdash/admin`.

Current single-host baseline:

- `SITE_URL` remains the canonical public hostname
- `https://awcms-mini.ahlikoding.com/_emdash/` is the reviewed admin entry URL
- the runtime redirects that alias to the current EmDash admin surface under `/_emdash/admin`
- `ADMIN_SITE_URL`, when configured for compatibility, remains only an optional entry host for the same admin surface

Cloudflare-hosted deployment baseline:

- `pnpm build` produces the Worker bundle
- `pnpm deploy:cloudflare` deploys via Wrangler
- non-interactive Cloudflare automation should source `CLOUDFLARE_API_TOKEN` from `.env.local` or CI/CD secret storage, not tracked files; Tunnel provisioning needs `Account > Cloudflare Tunnel > Edit`, DNS provisioning needs zone DNS read/edit permission for the target zone, and Access provisioning needs the relevant Cloudflare Access/Zero Trust scopes
- `wrangler.jsonc` defines the Worker, assets, observability, the reviewed public custom domain for `awcms-mini.ahlikoding.com`, the `MEDIA_BUCKET` R2 binding for `awcms-mini-s3`, and commented Hyperdrive binding placeholders for the follow-on transport decision
- `DATABASE_TRANSPORT=direct` keeps the current reviewed direct PostgreSQL path; switch to `hyperdrive` only with the reviewed binding, reachable origin path, and rollout checks in place
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

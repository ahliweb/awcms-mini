# AWCMS Mini

> ## 🏛️ Architecture Update (2026-06-17)
>
> Penyelarasan dengan fondasi product line AWCMS. Keputusan yang berlaku untuk repo ini:
>
> - **PostgreSQL murni tanpa Supabase** (sudah sesuai; pertahankan) — ADR-014.
> - **RLS wajib (enforced) pada semua tabel** data/ber-`tenant_id` — ADR-015. Tracking: #310.
> - **SIKESRA & SatuSehatKobar dibangun di AWCMS-Mini** — ADR-016. Tracking: #311, #312.
> - Konektivitas DB via **pooler OSS** (Supavisor/PgBouncer); Hyperdrive ditunda — ADR-013.
>
> Backlog penyelarasan: #310 (RLS), #311 (SIKESRA-Mini), #312 (SatuSehatKobar), #313 (2FA/ABAC hardening), #314 (docs).

AWCMS Mini is a single-tenant secure modular monolith built on Astro, Hono, PostgreSQL, Kysely, and Bun.

It uses EmDash as an architecture reference during the decoupling period, with remaining runtime touchpoints isolated behind the `src/cms/` seam. Mini-specific governance features include:

- user lifecycle management
- RBAC and ABAC authorization
- protected roles and staff-level rules
- job hierarchy and job assignments
- logical and administrative region governance
- TOTP-based 2FA, recovery, lockouts, and step-up
- audit logs and security events
- governance-aware internal plugin contracts
- Mini admin/plugin extensions for governance operations

Mini keeps decoupling work gradual and reversible so the repository can move from legacy EmDash touchpoints to the native Mini stack without introducing a second competing core.

Cloudflare Pages and Workers act as clients of the Hono API, while PostgreSQL stays behind that backend boundary.
Remaining legacy-compatible paths are treated as compatibility surfaces until their native replacements are complete.

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
- the current reviewed deployment path uses Hono as the backend API in front of PostgreSQL
- the reviewed Coolify-managed VPS now uses key-only root SSH recovery, and the tunnel token is rotated from root-only VPS-managed secret storage on a monthly timer

## Tech Stack

- Astro `6.1.8`
- React `19.2.5`
- EmDash `0.9.0`
- PostgreSQL
- Kysely `0.28.16`
- Cloudflare adapter via `@astrojs/cloudflare`
- Hono backend API as the bridge between Cloudflare Pages/Workers and Coolify-managed PostgreSQL
- Node adapter via `@astrojs/node` kept only as an explicit fallback build target during migration

## Quick Start

1. Install dependencies:

```bash
bun install
```

2. Set the runtime environment values you need for the target deployment.

Required production baseline:

- `DATABASE_URL`
- `MINI_RUNTIME_TARGET=cloudflare`
- `SITE_URL`
- optional `ADMIN_SITE_URL` for a dedicated admin hostname that still points to the same reviewed admin surface
- `MINI_TOTP_ENCRYPTION_KEY`
- `TRUSTED_PROXY_MODE=cloudflare` for the supported Cloudflare-hosted path

Optional rollout verification inputs for `bun run healthcheck`:

- `HEALTHCHECK_EXPECT_DATABASE_TRANSPORT`
- `HEALTHCHECK_EXPECT_DATABASE_HOSTNAME`
- `HEALTHCHECK_EXPECT_DATABASE_SSLMODE`

These values are non-secret assertion inputs. Keep them unset for normal local development unless you intentionally want health checks to fail fast when the runtime points at the wrong reviewed database target.

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
bun run db:migrate
```

4. Start the dev server:

```bash
bun run dev
```

5. Validate runtime health:

```bash
bun run healthcheck
```

Example direct-path rollout verification:

```bash
HEALTHCHECK_EXPECT_DATABASE_TRANSPORT=direct \
HEALTHCHECK_EXPECT_DATABASE_HOSTNAME=id1.ahlikoding.com \
HEALTHCHECK_EXPECT_DATABASE_SSLMODE=verify-full \
bun run healthcheck
```

The reviewed browser entry for the current compatibility admin surface is `/_emdash/`, which redirects into `/_emdash/admin`.

Current single-host baseline:

- `SITE_URL` remains the canonical public hostname
- `https://awcms-mini.ahlikoding.com/_emdash/` is the reviewed admin entry URL
- the runtime redirects that alias to the current compatibility admin surface under `/_emdash/admin`
- `ADMIN_SITE_URL`, when configured for compatibility, remains only an optional entry host for the same admin surface

Cloudflare Pages plus Hono deployment baseline:

- `bun run build` produces the frontend build output
- Cloudflare Pages serves the frontend and calls the backend through `PUBLIC_API_BASE_URL`
- Hono runs on Coolify and is the only approved database access layer
- non-interactive Cloudflare automation should keep `CLOUDFLARE_API_TOKEN` in `.env.local` or approved CI/CD secret storage rather than tracked files
- local operator wrappers should load `.env.local` and `.env` as environment data, not by sourcing them as shell code
- `wrangler.jsonc` is retained as historical reference only and is not the active backend deployment target
- `wrangler.jsonc` also declares the reviewed required Worker secret names, and the shared local Astro wrapper now fails fast when those required secrets are missing from env-managed local files or process env
- the Mini auth middleware keeps the EmDash setup shell database-lazy so `/_emdash/admin/setup` can render during database transport reconciliation instead of failing early with a Worker exception
- for Coolify-managed resources on the VPS, the reviewed secret surface is Coolify Environment Variables with locked secrets, runtime/build scoping, and Docker Build Secrets for reviewed build-time sensitive inputs

## Common Commands

```bash
bun run smoke:cloudflare-admin
bun run verify:live-runtime
bun run check:secret-hygiene
bun run check
bun run lint
bun run format
bun run typecheck
bun run test:unit
bun run build
bun run healthcheck
bun run db:migrate
bun run db:migrate:status
bun run db:migrate:down
bun run db:migrate:emdash:status
bun run db:migrate:emdash:repair
bun run db:seed:administrative-regions
```

Validation baseline:

- `bun run check:secret-hygiene` is the focused regression check for maintained scripts, config examples, and operator docs that must not gain hardcoded credentials or inline tokens.
- `bun run verify:live-runtime` is the focused combined verification path for the reviewed direct PostgreSQL backend posture, reusing `bun run healthcheck`, `bun run db:migrate:emdash:verify`, and `bun run smoke:cloudflare-admin`.
- `bun run smoke:cloudflare-admin` is the focused live-target smoke check for the reviewed `/_emdash/` admin alias and `/_emdash/admin/setup` shell path.
- Use `bun run check` as the default local pre-change validation path.
- `bun run lint` and `bun run format` currently cover the maintained docs/config surface with Prettier.
- Keep issue-specific validation commands in addition to the baseline when a task requires them.

## Repository Structure

```text
src/
  auth/          Mini auth handlers, middleware, and step-up flows
  config/        runtime config parsing
  db/            Kysely client, migrations, repositories, transactions
  integrations/  Astro/runtime integration wiring
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
- `docs/architecture/secure-modular-monolith.md` - module boundary and Bun/toolchain standard
- `docs/process/migration-deployment-checklist.md` - release checklist
- `docs/security/emergency-recovery-runbook.md` - recovery guidance

## Related Notes

- The repository follows an issue-driven workflow documented in `docs/process/github-issue-workflow.md`.
- The current codebase is intentionally a native Mini secure modular monolith in transition; new work must not add direct `emdash` imports outside `src/cms/`.

## License

See `LICENSE.md`.

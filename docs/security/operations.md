# Security Operations

## EmDash Core Vs Mini Overlay

### EmDash Core

EmDash provides the host runtime and baseline auth boundary.

### Mini Overlay

Mini owns the security-hardening layer:

- login security events
- shared lockout counter handling
- TOTP enrollment and verification
- recovery codes
- forced password reset flows
- step-up requirements for high-risk admin actions
- security settings for staged mandatory 2FA rollout
- audit and security-event coverage for privileged recovery paths

## Current Controls

- password login with failure tracking
- Cloudflare Turnstile enforcement on public login, password-reset request, and invite-activation flows when configured
- lockout response for repeated failures
- mandatory password reset support
- public password-reset requests return a generic acceptance response and do not expose live reset tokens in JSON
- versioned edge API routes under `/api/v1/*` with explicit JSON, CORS, and security-header handling
- `/api/v1/token` password and refresh-token grants for external or mobile clients
- TOTP-based 2FA and recovery codes
- admin-triggered 2FA reset with step-up enforcement
- active session inspection and revocation
- staged mandatory 2FA rollout modes: `none`, `protected_roles`, `custom`

## Current Implementation Notes

- Mandatory 2FA rollout controls are persisted in the database-backed security policy and managed through the admin settings surface.
- Treat rollout behavior as an operator-managed control that still requires verification against the live auth path before claiming full enforcement in production.
- ABAC audit-only flags are intended for controlled rollout safety, not permanent steady-state policy behavior.
- Public password-reset issuance is a generic request-acceptance surface. Live reset tokens should be delivered through an operator-controlled or other out-of-band recovery channel, not returned to the caller.
- Turnstile validation is server-side only and uses Siteverify with action and hostname checks when configured.
- Turnstile currently protects login, password-reset request, and invite-activation handlers. It complements, rather than replaces, lockouts and edge rate limiting.
- For the reviewed single-host baseline, Turnstile hostname validation should allow only `awcms-mini.ahlikoding.com` unless an explicit compatibility hostname is still enabled and reviewed.
- The current edge API baseline includes a public health endpoint, JWT-backed token issuance and refresh under `/api/v1/token`, and session self-inspection/self-revocation under `/api/v1/session`.
- Edge API access tokens are short-lived JWT Bearer tokens signed with `jose` using an explicit issuer, audience, expiration, and algorithm allowlist.
- Edge API refresh tokens are opaque random values, hashed at rest in PostgreSQL, rotated on use, and revoked when the backing session is revoked.
- Password-based token issuance does not bypass current account-state or enrolled-2FA checks.
- Admin and plugin APIs remain isolated under `/_emdash/api/*` and should not be treated as external-client APIs.
- The reviewed browser entry for the EmDash admin surface is `/_emdash/`, which redirects to the current `/_emdash/admin` route on the same host.
- If a dedicated admin hostname is configured for compatibility, it should remain only an entry host for the same EmDash admin surface.

## Deployment Expectations

For the intended deployment model:

- Cloudflare is the public edge.
- Cloudflare hosts the supported application runtime.
- PostgreSQL runs as a protected remote dependency on a VPS.
- Coolify manages the PostgreSQL host lifecycle and related operator environment.

Security operations should treat those as separate trust boundaries.

## Edge And Origin Guidance

- The supported baseline production path is a Cloudflare-hosted runtime serving the public hostname directly.
- If `ADMIN_SITE_URL` is configured for compatibility, treat it as a second trusted browser hostname for operator entry only, not as a second app origin with separate auth rules.
- In the supported Cloudflare-hosted path, trust `CF-Connecting-IP` and configure `TRUSTED_PROXY_MODE=cloudflare`.
- Do not treat arbitrary `X-Forwarded-For` values as authoritative unless a deployment explicitly opts into a different trusted proxy mode.
- Add Cloudflare rate limiting or managed challenge rules for login and other abuse-prone auth endpoints.
- Store `TURNSTILE_SECRET_KEY` as a Cloudflare-managed secret or equivalent server-only runtime secret.
- Prefer `TURNSTILE_EXPECTED_HOSTNAMES` when multiple reviewed hostnames are enabled so Siteverify accepts only the intended hostname set.
- Store `EDGE_API_JWT_SECRET` as a Cloudflare-managed secret or equivalent server-only runtime secret.
- Keep deployed Worker secrets in Cloudflare-managed secret storage such as `wrangler secret put`, not in local `.dev.vars` files or Wrangler `[vars]`.
- Keep `EDGE_API_ALLOWED_ORIGINS` empty unless a reviewed browser-based external client explicitly needs cross-origin access.
- Prefer host-only cookies unless a reviewed operator workflow requires public/admin cross-host session sharing.
- Keep local Cloudflare and operator secret files such as `.env.local`, `.env.<environment>.local`, `.dev.vars`, and `.dev.vars.<environment>` untracked; tracked env-style files should stay limited to reviewed placeholder examples such as `.env.example`.
- Treat break-glass credentials such as `VPS_ROOT_PASSWORD` as password-manager-only secrets with audit trail and rotation history, not as developer-local env values.

See `docs/process/cloudflare-hosted-runtime.md` for the supported Cloudflare runtime and deployment checks.

The older `docs/process/cloudflare-coolify-origin-hardening.md` runbook should be treated as an alternative or historical app-on-Coolify deployment path, not the current baseline.

## PostgreSQL Guidance

- Prefer TLS-enabled PostgreSQL connections for remote app-to-database traffic.
- Restrict database ingress to the application host or private network path.
- Prefer stronger authentication methods such as `scram-sha-256` for application access.
- Avoid using superuser credentials for the application runtime.
- Prefer `hostssl` rules for remote app access on operator-managed PostgreSQL hosts.
- Keep `pg_hba.conf` allow rules narrow and ordered intentionally.

See `docs/process/postgresql-vps-hardening.md` for the supported PostgreSQL VPS posture.

## Operator Surfaces

Operators currently use:

- user `Security` tab
- user `Sessions` tab
- `Security Settings`
- `Audit Logs`

## Rollout Safety

Mini now supports:

- staged mandatory 2FA rollout controls
- ABAC audit-only rollout flags for selected authorization deny paths

These are rollout tools, not permanent substitutes for full enforcement.

## Cross-References

- `docs/security/emergency-recovery-runbook.md`
- `docs/process/migration-deployment-checklist.md`
- `docs/process/cloudflare-hosted-runtime.md`
- `docs/process/postgresql-vps-hardening.md`

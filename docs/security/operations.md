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
- lockout response for repeated failures
- mandatory password reset support
- public password-reset requests return a generic acceptance response and do not expose live reset tokens in JSON
- TOTP-based 2FA and recovery codes
- admin-triggered 2FA reset with step-up enforcement
- active session inspection and revocation
- staged mandatory 2FA rollout modes: `none`, `protected_roles`, `custom`

## Current Implementation Notes

- Mandatory 2FA rollout controls are persisted in the database-backed security policy and managed through the admin settings surface.
- Treat rollout behavior as an operator-managed control that still requires verification against the live auth path before claiming full enforcement in production.
- ABAC audit-only flags are intended for controlled rollout safety, not permanent steady-state policy behavior.
- Public password-reset issuance is a generic request-acceptance surface. Live reset tokens should be delivered through an operator-controlled or other out-of-band recovery channel, not returned to the caller.

## Deployment Expectations

For the intended deployment model:

- Cloudflare is the public edge.
- Cloudflare hosts the supported application runtime.
- PostgreSQL runs as a protected remote dependency on a VPS.
- Coolify manages the PostgreSQL host lifecycle and related operator environment.

Security operations should treat those as separate trust boundaries.

## Edge And Origin Guidance

- The supported baseline production path is a Cloudflare-hosted runtime serving the public hostname directly.
- In the supported Cloudflare-hosted path, trust `CF-Connecting-IP` and configure `TRUSTED_PROXY_MODE=cloudflare`.
- Do not treat arbitrary `X-Forwarded-For` values as authoritative unless a deployment explicitly opts into a different trusted proxy mode.
- Add Cloudflare rate limiting or managed challenge rules for login and other abuse-prone auth endpoints.

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

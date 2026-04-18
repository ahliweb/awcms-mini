# Security Operations

## EmDash Core Vs Mini Overlay

### EmDash Core

EmDash provides the host runtime and baseline auth boundary.

### Mini Overlay

Mini owns the security-hardening layer:

- login security events
- runtime-backed lockout handling
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
- TOTP-based 2FA and recovery codes
- admin-triggered 2FA reset with step-up enforcement
- active session inspection and revocation
- staged mandatory 2FA rollout modes: `none`, `protected_roles`, `custom`

## Current Implementation Notes

- Mandatory 2FA rollout controls are present in the policy and admin settings surface.
- Treat rollout behavior as an operator-managed control that still requires verification against the live auth path before claiming full enforcement in production.
- ABAC audit-only flags are intended for controlled rollout safety, not permanent steady-state policy behavior.

## Deployment Expectations

For the intended deployment model:

- Cloudflare is the public edge.
- Coolify manages the application deployment and reverse proxy path.
- PostgreSQL runs as a protected remote dependency on a VPS.

Security operations should treat those as separate trust boundaries.

## Edge And Origin Guidance

- Prefer proxied Cloudflare DNS for public app traffic.
- Prefer Cloudflare Tunnel when it is operationally acceptable.
- If not using Tunnel, restrict direct origin access as much as possible and keep the origin reachable only through the intended path.
- Document and enforce trusted forwarded-header behavior; do not rely on arbitrary client-supplied proxy headers.
- Add Cloudflare rate limiting or managed challenge rules for login and other abuse-prone auth endpoints.

## PostgreSQL Guidance

- Prefer TLS-enabled PostgreSQL connections for remote app-to-database traffic.
- Restrict database ingress to the application host or private network path.
- Prefer stronger authentication methods such as `scram-sha-256` for application access.
- Avoid using superuser credentials for the application runtime.

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

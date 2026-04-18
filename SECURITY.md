# Security Policy

## Supported Version

This repository currently supports the active `main` branch only.

There is no multi-release maintenance policy at this time.

## Reporting A Vulnerability

Do not open a public GitHub issue for an unpatched security vulnerability.

Instead:

1. Contact the repository owner privately through GitHub-maintainer channels.
2. Include a clear description, impact, reproduction steps, and any known affected areas.
3. If the issue affects governance, authorization, recovery, or plugin boundaries, include that context explicitly.

## Repository Security Scope

Security-relevant areas in this repo include:

- authentication and sessions
- RBAC and ABAC authorization
- step-up and protected-action enforcement
- TOTP, recovery codes, and password reset flows
- lockouts, audit logs, and security events
- plugin permission, authorization, audit, and region-awareness helpers

## Operational References

- `docs/security/operations.md`
- `docs/security/emergency-recovery-runbook.md`
- `docs/process/migration-deployment-checklist.md`

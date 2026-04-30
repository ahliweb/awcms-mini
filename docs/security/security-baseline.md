# Security Baseline

This repository applies a layered baseline aligned to OWASP-style web/API controls and the current Mini runtime constraints.

Implemented controls include:

- password hashing with optional `PASSWORD_PEPPER`
- JWT access + rotation-backed refresh token flow
- Turnstile verification on sensitive public-auth flows
- TOTP enrollment/challenge/recovery workflows
- ABAC/RBAC route enforcement
- security headers and CORS allowlist behavior
- request-size and API rate-limit middleware
- signed file upload/download flows and file validation
- notification idempotency, webhook-signature checks, and recipient masking

Operational security runbooks:

- `docs/security/emergency-recovery-runbook.md`
- `docs/security/operations.md`
- `docs/process/postgresql-vps-hardening.md`

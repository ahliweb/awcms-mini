# Two-Factor Authentication

Current mechanism:

- TOTP with encrypted secret storage
- one-time recovery codes (hashed at rest)
- setup, confirm, disable, and regeneration APIs

Privileged-account posture:

- login path enforces 2FA enrollment requirement for privileged role-rank accounts

Reference implementation:

- `src/services/security/two-factor.mjs`
- `server/routes/api-v1-security.mjs`

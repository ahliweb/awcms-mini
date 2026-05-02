# Turnstile Integration

Turnstile flows:

- frontend renders widget using `PUBLIC_TURNSTILE_SITE_KEY`
- backend verifies tokens using `TURNSTILE_SECRET_KEY`
- expected action/hostname checks are enforced by runtime config

Implemented route usage includes login, activation, and password-reset flows.

Reference:

- `src/security/turnstile.mjs`
- `docs/architecture/runtime-config.md`

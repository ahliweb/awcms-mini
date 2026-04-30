# Operator Secret Rotation Checklist (#261)

## Scope

Operator-side rotation and lock verification for production/runtime secrets managed outside repository code.

## Canonical References

- OWASP Secrets Management Cheat Sheet: rotate secrets on compromise suspicion and validate rollout before finalizing.
- Current repo deployment posture: `docs/process/coolify-deployment.md`, `docs/process/postgresql-vps-hardening.md`.

## Excluded From Rotation

- `COOLIFY_ACCESS_TOKEN` — management-plane credential, not a runtime secret.
- `CLOUDFLARE_API_TOKEN` — management-plane credential, not a runtime secret.

## Cloudflare-Managed Secrets (Auto-Set Via Cloudflare MCP)

These secrets are provisioned and rotated via Cloudflare MCP automation, not manual Coolify entry:

- `TURNSTILE_SECRET_KEY` — provisioned via Cloudflare Turnstile APIs.
- `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` — provisioned via Cloudflare R2 APIs.

## Coolify-Managed Secrets (Sync Via Coolify API/MCP)

1. Inventory current runtime secrets in Coolify for backend services.
2. Rotate backend auth and crypto secrets:
   - `APP_SECRET`
   - `EDGE_API_JWT_SECRET`
   - `MINI_TOTP_ENCRYPTION_KEY`
   - `PASSWORD_PEPPER`
3. Rotate provider/integration secrets:
   - `MAILKETING_API_KEY`
   - `STARSENDER_API_KEY`
4. Rotate database runtime credential used by `DATABASE_URL`.
5. Ensure secrets are runtime-scoped and locked in Coolify storage.
6. Sync Coolify API-side env vars for the rotated keys.
7. Remove stale secrets from shell history, notes, and issue comments.
8. Validate application health and auth flows after rotation.

## Required Evidence To Attach On #261

- Redacted Coolify API output or console screenshot showing updated secret timestamps for rotated values.
- Redacted proof that old database credential no longer authenticates.
- Runtime validation outputs:
  - `pnpm healthcheck`
  - `pnpm test:unit` (optional in deployment window)
  - `pnpm verify:live-runtime -- <site-url>` when applicable

## Rollback Rule

If rotation breaks production, roll back only the affected secret to last known-good value, then re-run validation and rotate again with staged testing.

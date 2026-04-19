# EmDash Ledger Repair Runbook

## Purpose

This runbook defines the operator-only path for inspecting and, when safe, repairing the EmDash `_emdash_migrations` ledger in AWCMS Mini.

Use it only for issue-scoped work such as `#180`, where the live Cloudflare Worker runtime must stay aligned with the current EmDash host architecture while PostgreSQL remains the system of record on the Coolify-managed VPS.

## When To Use It

- `pnpm db:migrate:emdash:status` reports `repairable`
- the current issue is explicitly about EmDash migration compatibility or runtime bootstrap repair
- the team has reviewed the current deployment state and captured rollback notes

Do not use this runbook for routine releases that do not touch EmDash runtime compatibility.

## Preconditions

- the current database target is the intended environment
- `DATABASE_URL` is sourced from `.env.local`, deployment-managed secrets, or another reviewed server-only source
- `DATABASE_CONNECT_TIMEOUT_MS` is set to a reviewed value such as `10000` so operator commands fail fast if the PostgreSQL path is unreachable
- no credentials are pasted into tracked scripts, docs, issue bodies, or shell history exports
- `pnpm test:unit` has passed for the current branch
- `pnpm db:migrate:emdash:status` has been run and its output recorded

## Safety Rules

- treat `_emdash_migrations` edits as operator work, not routine application behavior
- do not run repair when the status is `unsafe`
- do not run repair blindly on multiple environments; inspect each target first
- prefer a transaction-backed rewrite only through the repo-owned CLI command
- keep production Cloudflare, Coolify, and PostgreSQL credentials in server-only secret storage or `.env.local`, not in tracked files

## Status Meanings

- `empty`: the `_emdash_migrations` table is missing or has no rows
- `compatible`: the current ledger already matches the expected Mini-owned EmDash prefix ordering
- `repairable`: the current ledger rows are the expected Mini-owned EmDash prefix but out of order for Kysely's timestamp-based validation
- `unsafe`: the current ledger contains unexpected names or another out-of-scope shape that should be investigated manually

## Repair Flow

1. Inspect the ledger state:

```bash
pnpm db:migrate:emdash:status
```

2. If the state is `repairable`, apply the repair:

```bash
pnpm db:migrate:emdash:repair
```

3. Re-run the status check:

```bash
pnpm db:migrate:emdash:status
```

4. Confirm the state is now `compatible`.

5. Re-run the current release validation path:

```bash
pnpm healthcheck
```

6. For Cloudflare-hosted validation, confirm the current setup path still responds:

```bash
curl -i https://awcms-mini.ahlikoding.com/_emdash/api/setup/status
```

## Rollback Guidance

- if `pnpm db:migrate:emdash:status` reports `unsafe`, stop and investigate instead of forcing a repair
- if the repair command fails, capture the output and stop the release
- if the target environment is production, keep the current setup-status compatibility handler in place until runtime initialization is proven stable
- if post-repair smoke tests fail, restore from the reviewed database backup or transactionally revert using the incident runbook rather than ad hoc SQL edits

## Security Notes

- keep this flow aligned with OWASP least-privilege and secure-secrets guidance
- keep `DATABASE_URL`, `CLOUDFLARE_API_TOKEN`, Coolify tokens, Turnstile secrets, and JWT secrets out of tracked files
- prefer `sslmode=verify-full` for the Coolify-managed PostgreSQL target when the reviewed certificate/hostname path is available end to end
- keep Hyperdrive validation explicit when the Worker is running with `DATABASE_TRANSPORT=hyperdrive`

## Related Docs

- `docs/architecture/database-migrations.md`
- `docs/process/migration-deployment-checklist.md`
- `docs/process/runtime-smoke-test.md`
- `docs/process/secret-hygiene-audit.md`
- `docs/security/emergency-recovery-runbook.md`

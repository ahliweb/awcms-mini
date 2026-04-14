# Runtime Smoke Test

## Purpose

This document defines the baseline smoke-test path for the current scaffold.

## Validation Path

Use the CLI runtime validation path:

```bash
pnpm healthcheck
```

The command reports:

- runtime validation execution
- database connectivity
- timestamped status output

## Manual Smoke Test

1. Start a PostgreSQL database reachable by `DATABASE_URL`.
2. Build the app with `pnpm build`.
3. Run `pnpm healthcheck`.
4. Confirm:
   - `ok` is `true`
   - `checks.app.ok` is `true`
   - `checks.database.ok` is `true`

## Failure Modes

- if the runtime build is broken, `pnpm build` fails
- if the database is unreachable, `pnpm healthcheck` exits non-zero
- database failures return a classified `kind` to make startup issues easier to identify

## Validation

- `pnpm typecheck`
- `pnpm build`
- `pnpm healthcheck`

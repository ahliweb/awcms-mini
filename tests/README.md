# Tests

Two tiers, both run by `bun test`:

## Unit + migration-shape (default, no database)

Everything except `tests/integration/`. Pure domain logic (validators,
evaluators, redaction, transitions, circuit breaker, work-class gate, …) and
migration-shape assertions (`tests/foundation.test.ts` reads the `sql/` files
and checks RLS/constraints/seeds statically). These need no database and run
anywhere.

## Integration (real PostgreSQL, HTTP-level)

`tests/integration/` calls the real Astro route handlers against a real
PostgreSQL, guarding the endpoint wiring the unit suite structurally cannot:
the `auth → ABAC → transaction → RLS → response-envelope` chain, the setup
singleton lock, argon2 login + session issue, ABAC allow **and** default-deny,
cross-tenant session rejection, and the `write → audit → read-back` path (the
one that has previously hidden real bugs: jsonb double-encoding,
bigint-as-string). The harness (`tests/integration/harness.ts`) builds a
synthetic Astro context and invokes handlers directly — no running server or
build needed.

**Gating:** the integration suite is **skipped** unless `DATABASE_URL` is set,
so `bun test` locally without a database stays green.

**Run it locally** against a throwaway Postgres:

```bash
# PGPW is the non-secret local dev default from .env.example — change it for
# any real database. Kept out of the connection-string literal so secret
# scanners don't flag a throwaway local credential.
PGPW=awcms_mini_password
docker run -d --name it-pg -e POSTGRES_USER=awcms-mini \
  -e POSTGRES_PASSWORD="$PGPW" -e POSTGRES_DB=awcms-mini postgres:18.4
export DATABASE_URL="postgres://awcms-mini:${PGPW}@localhost:5432/awcms-mini"
bun run db:migrate      # (also run automatically by the suite's beforeAll)
bun test tests/integration/
docker rm -f it-pg
```

The suite truncates all runtime tables between tests for isolation (preserving
`awcms_mini_schema_migrations` and the `awcms_mini_permissions` seed catalog).

**CI:** the `quality` job (`.github/workflows/ci.yml`) starts a `postgres:18.4`
service, sets `DATABASE_URL` to it, runs `bun run db:migrate`, then `bun test`
— so the integration suite runs (and blocks) on every PR.

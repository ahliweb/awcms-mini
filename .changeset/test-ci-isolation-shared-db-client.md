---
"awcms-mini": patch
---

test: make the shared database client independent of test file order

`getDatabaseClient()` memoizes its pool for the whole `bun test` process, so
whichever test first reached it while `DATABASE_URL` still held the privileged
migration-owner URL decided which role every later test connected as. RLS and
grants do not apply to that role, so the RLS-isolation and least-privilege
tests (MFA, module management, OIDC, visitor analytics, payment-gateway
retention grants and others) passed or failed on file order alone. The
integration harness now drops the memoized app pool when it repoints
`DATABASE_URL` to `awcms_mini_app` (new test seam
`resetDatabaseClientsForTests`, never called by production code). No RLS or
authorization assertion was weakened or skipped.

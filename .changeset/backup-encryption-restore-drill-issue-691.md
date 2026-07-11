---
"awcms-mini": minor
---

Add encrypted backup, checksum-before-restore, off-site copy, and a
scheduled restore drill (Issue #691, epic #679 platform-hardening).

`deploy/backup/backup-postgres.sh` now streams `pg_dump` directly into
`openssl enc -aes-256-cbc -pbkdf2` — the plaintext dump never touches disk
— and writes a signed manifest (filename, size, sha256, an HMAC-SHA256
over those fields, timestamp) using the same `HMAC(secret,
"<timestamp>.<body>")` construction as skill `awcms-mini-sync-hmac`. Both
the encryption key and the (separate) HMAC key are required from a FILE
(`BACKUP_ENCRYPTION_KEY_FILE`/`BACKUP_HMAC_KEY_FILE`), never a CLI
argument or an env var holding the key content.

`deploy/backup/restore-postgres.sh` now verifies, in order, before any
mutation: the manifest's own HMAC (rejects a tampered/missing manifest),
the dump file's actual sha256/size against the manifest (rejects a
tampered/incomplete dump), then decrypts to a private `mktemp` file
(removed on exit) and runs `pg_restore --list` to validate archive
structure. `DATABASE_URL` is parsed into `PGHOST`/`PGPORT`/`PGUSER`/
`PGPASSWORD`/`PGDATABASE` and never passed as a positional argument to
`pg_dump`/`pg_restore`/`psql`, so it never appears in `ps`/
`/proc/<pid>/cmdline`. `--target` now validates the database identifier
(rejects quote/semicolon/whitespace injection) and, in override mode,
requires `--acknowledge-target=<dbname>` matching `--target` exactly
(mirroring `scripts/production-preflight.ts`'s `--acknowledge-target`). A
shared `flock` lock in `BACKUP_DIR` stops concurrent backup/restore jobs.

New `deploy/backup/offsite-copy.sh` — a generic, provider-agnostic 3-2-1
off-site copy hook (`OFFSITE_COPY_COMMAND`, no-op if unset, so offline/LAN
deployments stay fully local). New `deploy/backup/restore-drill.sh` — runs
backup → restore into a disposable database → verifies the schema
migrations ledger, tenant isolation (RLS, via the real `awcms_mini_app`
role when available), and a sample record → writes a timestamped JSON
report with RTO (drill duration) and RPO (backup age) proxies.

`deploy/backup/README.md` documents all of the above plus key rotation,
the lost-key failure mode (no backdoor — losing a key makes backups
encrypted/signed with it permanently unrecoverable/unverifiable), and
PITR prerequisites (WAL archiving) as an out-of-scope next step.
`docs/awcms-mini/production-preflight-runbook.md`,
`production-readiness.md`, `deployment-profiles.md`, and skill
`awcms-mini-production-preflight` updated to the new command shapes.

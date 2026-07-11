# deploy/backup — PostgreSQL backup & restore

Issue 12.2 (doc 07 §"Backup SOP ringkas" / "Restore SOP ringkas", doc 18
§Topologi deployment LAN-first, skill `awcms-mini-production-preflight`
§"Backup & restore"), hardened by Issue #691 (epic #679
platform-hardening): encrypted backups, a signed manifest, checksum
verification before any restore mutation, credential-safe invocation,
mutual-exclusion locking, an off-site copy hook, and a scheduled restore
drill. Five OS-level shell scripts wrapping Postgres's own client binaries
(`pg_dump`, `pg_restore`, `psql`), `openssl`, and coreutils — not
TypeScript. AGENTS.md rule 14 ("Backend Bun-only") governs application
code, scripts, tests, migration, build, and repository tooling; it does
not apply to standard shell ops scripts that only orchestrate Postgres's
own binaries, `openssl`, and coreutils. See the header comment in each
script for the full reasoning.

| Script                | Purpose                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `backup-common.sh`    | Shared helpers (`source`d, not run directly) — secret-from-file loading, locking, DATABASE_URL parsing, identifier validation, checksums/HMAC. |
| `backup-postgres.sh`  | Encrypted backup + signed manifest.                                                                                                            |
| `restore-postgres.sh` | Verify-then-restore.                                                                                                                           |
| `offsite-copy.sh`     | Generic 3-2-1 off-site copy hook (optional).                                                                                                   |
| `restore-drill.sh`    | Scheduled backup → restore → verify → RTO/RPO report.                                                                                          |

## Required keys

Two **separate** keys, each in its own file (never a CLI argument, never an
env var holding the key's content — only a _path_ to it):

| Env var                      | Purpose                                              |
| ---------------------------- | ---------------------------------------------------- |
| `BACKUP_ENCRYPTION_KEY_FILE` | Symmetric key for `openssl enc -aes-256-cbc -pbkdf2` |
| `BACKUP_HMAC_KEY_FILE`       | HMAC-SHA256 key that signs the backup manifest       |

```bash
mkdir -p /etc/awcms-mini
openssl rand -base64 48 > /etc/awcms-mini/backup-encryption.key
openssl rand -base64 48 > /etc/awcms-mini/backup-hmac.key
chmod 600 /etc/awcms-mini/backup-*.key
```

Store both files **outside** `BACKUP_DIR` (e.g. in a secret manager, or at
least a separate path with separate access controls) — anyone who can read
both `BACKUP_DIR` and the key files can decrypt every backup in it. See
"Key rotation" and "Lost key" below.

## `backup-postgres.sh`

Dumps the database with `pg_dump --format=custom`, **streamed directly
into `openssl enc -aes-256-cbc -pbkdf2 -salt -pass file:...`** — the
plaintext dump is never written to disk, only the encrypted `.dump.enc`
file is. Writes a **signed JSON manifest** alongside it (`.manifest.json`):
filename, size, sha256, an HMAC-SHA256 over those fields (keyed by
`BACKUP_HMAC_KEY_FILE`, using the same `HMAC(secret, "<timestamp>.<body>")`
construction as skill `awcms-mini-sync-hmac` — reused here, not
reinvented), and the timestamp. Then prunes dumps/manifests older than
`BACKUP_RETENTION_DAYS`.

`DATABASE_URL` is parsed into `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/
`PGDATABASE` and never passed as a positional argument to `pg_dump` — it
never appears in `ps`/`/proc/<pid>/cmdline`. A shared `flock` lock in
`BACKUP_DIR` (`.awcms-mini-backup-restore.lock`) stops a backup and a
restore (or two of either) from running concurrently against the same
directory.

```bash
DATABASE_URL=postgres://user:pass@host:5432/dbname \
BACKUP_DIR=/var/backups/awcms-mini \
BACKUP_ENCRYPTION_KEY_FILE=/etc/awcms-mini/backup-encryption.key \
BACKUP_HMAC_KEY_FILE=/etc/awcms-mini/backup-hmac.key \
BACKUP_RETENTION_DAYS=14 \
./deploy/backup/backup-postgres.sh
```

| Env var                      | Required | Default                   | Purpose                           |
| ---------------------------- | -------- | ------------------------- | --------------------------------- |
| `DATABASE_URL`               | Ya       | –                         | Koneksi PostgreSQL yang di-dump   |
| `BACKUP_ENCRYPTION_KEY_FILE` | Ya       | –                         | File kunci enkripsi dump          |
| `BACKUP_HMAC_KEY_FILE`       | Ya       | –                         | File kunci HMAC manifest          |
| `BACKUP_DIR`                 | –        | `/var/backups/awcms-mini` | Direktori tujuan dump + manifest  |
| `BACKUP_RETENTION_DAYS`      | –        | `14`                      | Retensi dump lama sebelum dihapus |

Output per run: `awcms_mini_<UTC timestamp>.dump.enc` (AES-256-CBC
encrypted custom-format dump) + `awcms_mini_<UTC timestamp>.manifest.json`
(signed manifest).

## `restore-postgres.sh`

Restores a dump produced by `backup-postgres.sh`. **Every verification
step below runs, in order, before any mutation happens:**

1. **Manifest HMAC verification** — recomputes the HMAC over the
   manifest's own fields and compares it to the manifest's
   `hmac_sha256`. A missing or tampered manifest is rejected here,
   before the dump file's bytes are even read.
2. **Dump file integrity** — the `.dump.enc` file's actual size and
   sha256 on disk are compared against what the (now-verified) manifest
   recorded. A truncated/incomplete/tampered dump file is rejected here.
3. **Decrypt to a private temp file** (`mktemp`, removed via a `trap ...
EXIT` regardless of success or failure) using
   `BACKUP_ENCRYPTION_KEY_FILE`.
4. **`pg_restore --list`** against the decrypted file, to validate the
   archive's internal structure. AES-CBC has no built-in authentication,
   so a wrong key or corrupted ciphertext will not necessarily error on
   decrypt — this step is what actually proves decryption produced a
   structurally valid dump.

Only after all four steps pass does the script even look at the restore
**target**:

- By default (no `--target`), this **never touches the live database** —
  it restores into a disposable database named `awcms_mini_restore_test`
  (matching doc 07's own example), which the script drops and recreates
  itself every run.
- `--target=<dbname>` is an explicit override for a real recovery target.
  The name must be a safe database identifier (letters/digits/underscore/
  hyphen, starting with a letter or underscore, max 63 chars — rejects
  quote/semicolon/whitespace-based identifier injection). In override
  mode the script does **not** create/drop the database itself (it must
  already exist), and requires **both**:
  - `--acknowledge-target=<dbname>` matching `--target` exactly (a
    typo-catcher, the same idea as `scripts/production-preflight.ts`'s
    `--acknowledge-target=<APP_ENV>`), and
  - typing the database name back at an interactive prompt, unless
    `--yes` is passed (for non-interactive/automated use — this does
    **not** remove the `--acknowledge-target` requirement).
- The script refuses to run if `--target` names the same database
  `DATABASE_URL` already points at (the live/source database).

`DATABASE_URL` is parsed the same way as in `backup-postgres.sh` — no
connection string ever appears as a positional argument to `psql`/
`pg_restore`. The same shared `flock` lock in the dump file's own
directory applies here too.

```bash
DATABASE_URL=postgres://user:pass@host:5432/dbname \
BACKUP_ENCRYPTION_KEY_FILE=/etc/awcms-mini/backup-encryption.key \
BACKUP_HMAC_KEY_FILE=/etc/awcms-mini/backup-hmac.key \
./deploy/backup/restore-postgres.sh /var/backups/awcms-mini/awcms_mini_20260705_020000.dump.enc
```

```bash
# Explicit override — only ever point this at a database you intend to
# overwrite:
DATABASE_URL=postgres://user:pass@host:5432/dbname \
BACKUP_ENCRYPTION_KEY_FILE=/etc/awcms-mini/backup-encryption.key \
BACKUP_HMAC_KEY_FILE=/etc/awcms-mini/backup-hmac.key \
./deploy/backup/restore-postgres.sh /var/backups/awcms-mini/awcms_mini_20260705_020000.dump.enc \
  --target=awcms_mini_recovery --acknowledge-target=awcms_mini_recovery
```

After restoring, verify the data actually came back, e.g.:

```bash
PGHOST=host PGPORT=5432 PGUSER=user PGPASSWORD=pass PGDATABASE=awcms_mini_restore_test \
  psql -c 'SELECT count(*) FROM awcms_mini_tenants;'
```

## `offsite-copy.sh` — off-site copy hook, and the 3-2-1 rule

Doc 18's backup guidance follows the standard **3-2-1** rule: keep **3**
copies of your data, on **2** different media, with **1** copy off-site.
`backup-postgres.sh`'s encrypted local dump covers copies on the backup
host's own disk (plus whatever that host's own OS/disk backup already
covers) — `offsite-copy.sh` is the generic "get a copy off-site" step.

It has **no built-in cloud/provider integration on purpose** — set
`OFFSITE_COPY_COMMAND` to whatever transfer tool your environment already
trusts (`rclone`, `rsync`, `aws s3 cp`, an internal script, ...). If
`OFFSITE_COPY_COMMAND` is unset, this script is a documented no-op (exit 0) — **off-site copy is entirely optional**, so offline/LAN deployments
(doc 18) never fail their backup job over it and can stay fully local.

```bash
OFFSITE_COPY_COMMAND="rclone copy --config /etc/awcms-mini/rclone.conf -" \
./deploy/backup/offsite-copy.sh \
  /var/backups/awcms-mini/awcms_mini_20260705_020000.dump.enc \
  /var/backups/awcms-mini/awcms_mini_20260705_020000.manifest.json
```

Chain it after `backup-postgres.sh` in cron (see below) if you want
off-site copy on every backup run.

## `restore-drill.sh` — scheduled restore drill (RTO/RPO evidence)

Doc 07's restore SOP already says a backup that was never test-restored is
not verified evidence. `restore-drill.sh` automates that proof on a
schedule, separate from the daily backup job: it runs `backup-postgres.sh`
→ `restore-postgres.sh` into a dedicated disposable database
(`DRILL_TARGET_DB`, default `awcms_mini_restore_drill` — deliberately
different from `restore-postgres.sh`'s own manual-use default so a
scheduled drill never collides with an operator's own manual restore
test) → verifies:

- **Schema migrations ledger** — `awcms_mini_schema_migrations` has rows.
- **Sample record** — `awcms_mini_tenants` has rows.
- **Tenant isolation (RLS)** — if the `awcms_mini_app` role exists and the
  connecting (superuser/owner) role can `SET ROLE` to it, this runs a real
  cross-tenant query with `app.current_tenant_id` set to one tenant and
  asserts another tenant's rows are invisible. If the role/privilege isn't
  available, or the backup doesn't have at least two tenants with data to
  test cross-tenant visibility with, this check is reported as `skip` (not
  `fail`) with a reason — see the JSON report.

...then measures **RTO** (wall-clock duration of the whole drill — a
proxy for how long a real recovery would take) and **RPO** (age of the
backup used at the moment the drill finished — a proxy for how much data a
real recovery would lose), and writes a timestamped JSON report
(`restore-drill-<UTC timestamp>.json`) to `DRILL_REPORT_DIR` (default
`BACKUP_DIR`). Exits non-zero if `schema_migrations` or `tenant_isolation`
comes back `fail`.

```bash
DATABASE_URL=postgres://user:pass@host:5432/dbname \
BACKUP_DIR=/var/backups/awcms-mini \
BACKUP_ENCRYPTION_KEY_FILE=/etc/awcms-mini/backup-encryption.key \
BACKUP_HMAC_KEY_FILE=/etc/awcms-mini/backup-hmac.key \
./deploy/backup/restore-drill.sh
```

Report shape:

```json
{
  "drill_started_at": "2026-07-11T02:00:00Z",
  "drill_finished_at": "2026-07-11T02:00:42Z",
  "duration_seconds": 42,
  "backup_file": "awcms_mini_20260711_020000.dump.enc",
  "backup_created_at": "2026-07-11T02:00:01Z",
  "backup_age_seconds": 41,
  "target_database": "awcms_mini_restore_drill",
  "checks": {
    "schema_migrations": { "status": "pass", "count": 45, "detail": "..." },
    "sample_record": { "status": "pass", "count": 4, "detail": "..." },
    "tenant_isolation": { "status": "pass", "detail": "..." }
  },
  "overall": "pass"
}
```

## Scheduling (plain crontab)

Doc 07/doc 18's LAN-first topology expects a scheduled backup on the same
host that runs the application (see
[`../systemd/awcms-mini.service.example`](../systemd/awcms-mini.service.example)
for the application unit). Schedule `backup-postgres.sh` with a plain
crontab entry, and `restore-drill.sh` separately (e.g. weekly, not on
every backup run — a full restore is more expensive than a dump) — this
repo intentionally does **not** also ship a systemd timer for the same
jobs, since running both would be two redundant scheduling mechanisms for
one task:

```cron
# /etc/cron.d/awcms-mini-backup (or `crontab -e` for the service user)
# Daily at 02:00 local time — backup, then (optionally) copy off-site.
0 2 * * * DATABASE_URL=postgres://user:pass@host:5432/dbname BACKUP_DIR=/var/backups/awcms-mini BACKUP_ENCRYPTION_KEY_FILE=/etc/awcms-mini/backup-encryption.key BACKUP_HMAC_KEY_FILE=/etc/awcms-mini/backup-hmac.key BACKUP_RETENTION_DAYS=14 /opt/awcms-mini/deploy/backup/backup-postgres.sh >> /var/log/awcms-mini-backup.log 2>&1

# Weekly restore drill, Sunday 03:00 local time.
0 3 * * 0 DATABASE_URL=postgres://user:pass@host:5432/dbname BACKUP_DIR=/var/backups/awcms-mini BACKUP_ENCRYPTION_KEY_FILE=/etc/awcms-mini/backup-encryption.key BACKUP_HMAC_KEY_FILE=/etc/awcms-mini/backup-hmac.key /opt/awcms-mini/deploy/backup/restore-drill.sh >> /var/log/awcms-mini-restore-drill.log 2>&1
```

Prefer keeping the environment variables in an `EnvironmentFile`-style
`.env` sourced by a small wrapper if you don't want secrets inline in
crontab (crontab files are usually readable only by root/the owning user,
but treat them the same as any other place secrets can leak from). The
two key files themselves should live outside the crontab entirely (see
"Required keys" above).

## Key rotation

`BACKUP_ENCRYPTION_KEY_FILE` and `BACKUP_HMAC_KEY_FILE` can be rotated
independently of each other:

1. Generate a new key file (`openssl rand -base64 48 > new-key`).
2. Point future `backup-postgres.sh`/`restore-postgres.sh`/
   `restore-drill.sh` runs at the new key file.
3. **Existing backups keep working with the OLD key** — nothing re-encrypts
   them automatically. Two options:
   - Keep the old key file archived (in your secret manager, clearly
     labeled with the date range it was used for) until every backup
     encrypted/signed with it has aged out past `BACKUP_RETENTION_DAYS`,
     then discard it. Simplest, no extra work, but you must still have
     the old key on hand to restore anything from before the rotation.
   - Or, immediately after rotating, run `restore-postgres.sh` with the
     OLD keys to decrypt each retained backup, then `backup-postgres.sh`
     equivalent (re-dump, or re-encrypt the already-decrypted plaintext
     with the NEW key using `openssl enc` directly) to re-encrypt/re-sign
     it under the new keys. More work, but means only one key pair is
     ever needed to restore anything currently retained.
4. Rotate the HMAC key the same way, independently — a manifest signed
   with an old HMAC key will fail verification against a new
   `BACKUP_HMAC_KEY_FILE`, by design (that's what "tampered manifest"
   detection is; an unrotated key file for an old backup is
   indistinguishable from tampering unless you keep the matching old key
   around for it).

## Lost key

If `BACKUP_ENCRYPTION_KEY_FILE` is lost, **every backup encrypted with it
is permanently unrecoverable** — there is no backdoor, no master key, and
no way to brute-force AES-256. If `BACKUP_HMAC_KEY_FILE` is lost, every
manifest signed with it can no longer be verified, so `restore-postgres.sh`
will refuse to restore those backups (by design — it cannot distinguish
"the HMAC key was lost" from "the manifest was tampered with", and
refusing is the safe default in both cases).

**This is why both key files must be stored in a secret manager (or
equivalent) that is itself backed up and access-controlled separately from
`BACKUP_DIR`** — losing `BACKUP_DIR` costs you the backups since the last
off-site copy; losing a key file costs you every backup ever encrypted/
signed with it, regardless of how many copies of the encrypted bytes still
exist.

## Point-in-time recovery (PITR) — prerequisites, out of scope here

`backup-postgres.sh` produces a single point-in-time custom-format dump
(a "backup as of now"), not continuous WAL archiving. Full PITR (restore
to any arbitrary timestamp between backups, not just to the moment a dump
was taken) needs PostgreSQL's own WAL archiving set up on the server —
out of scope for these shell scripts, but documented here as the natural
next step for a production deployment that needs tighter RPO than "since
the last dump":

- `wal_level = replica` (or `logical`) in `postgresql.conf`.
- `archive_mode = on`.
- `archive_command` set to a command that copies each completed WAL
  segment somewhere durable (a separate disk, off-site storage, ...).
- A retained **base backup** (`pg_basebackup`, not `pg_dump`) to restore
  from before replaying archived WAL up to the target timestamp.

See the official PostgreSQL documentation, ["Continuous Archiving and
Point-in-Time Recovery (PITR)"](https://www.postgresql.org/docs/current/continuous-archiving.html),
for the authoritative setup and restore procedure — this repo does not
implement or wrap WAL archiving.

## See also

- [`../../docs/awcms-mini/deployment-profiles.md`](../../docs/awcms-mini/deployment-profiles.md)
  — which profile needs backups, and how this fits with the rest of
  `deploy/`.
- [`../../docs/awcms-mini/production-preflight-runbook.md`](../../docs/awcms-mini/production-preflight-runbook.md)
  §"Stage 2 — Backup evidence" — the go-live evidence trail this feeds.
- [`../../docs/awcms-mini/07_sprint_testing_production_readiness.md`](../../docs/awcms-mini/07_sprint_testing_production_readiness.md)
  §"Backup SOP ringkas" / "Restore SOP ringkas" — the source SOP these
  scripts implement.
- `.claude/skills/awcms-mini-production-preflight/SKILL.md` §"Backup &
  restore" — go-live checklist requiring a tested restore.
- `.claude/skills/awcms-mini-sync-hmac/SKILL.md` — the HMAC signature
  pattern reused here for the manifest.

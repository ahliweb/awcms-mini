# deploy/backup — PostgreSQL backup & restore

Issue 12.2 (doc 07 §"Backup SOP ringkas" / "Restore SOP ringkas", doc 18
§Topologi deployment LAN-first, skill `awcms-mini-production-preflight`
§"Backup & restore"). Two OS-level shell scripts wrapping Postgres's own
client binaries (`pg_dump`, `pg_restore`, `psql`, `sha256sum`) — not
TypeScript. AGENTS.md rule 14 ("Backend Bun-only") governs application
code, scripts, tests, migration, build, and repository tooling; it does
not apply to standard shell ops scripts that only orchestrate Postgres's
own binaries and coreutils. See the header comment in each script for the
full reasoning.

## `backup-postgres.sh`

Creates a custom-format `pg_dump` of the database, writes a `sha256sum`
checksum file alongside it, then prunes dumps (and their checksum files)
older than `BACKUP_RETENTION_DAYS`.

```bash
DATABASE_URL=postgres://user:pass@host:5432/dbname \
BACKUP_DIR=/var/backups/awcms-mini \
BACKUP_RETENTION_DAYS=14 \
./deploy/backup/backup-postgres.sh
```

| Env var                 | Required | Default                   | Purpose                           |
| ----------------------- | -------- | ------------------------- | --------------------------------- |
| `DATABASE_URL`          | Ya       | –                         | Koneksi PostgreSQL yang di-dump   |
| `BACKUP_DIR`            | –        | `/var/backups/awcms-mini` | Direktori tujuan dump + checksum  |
| `BACKUP_RETENTION_DAYS` | –        | `14`                      | Retensi dump lama sebelum dihapus |

Output per run: `awcms_mini_<UTC timestamp>.dump` + `awcms_mini_<UTC
timestamp>.dump.sha256`.

## `restore-postgres.sh`

Restores a dump produced by `backup-postgres.sh` (or any compatible
`pg_dump --format=custom` file). By default it **never touches the live
database** — it restores into a disposable database named
`awcms_mini_restore_test` (matching doc 07's own restore SOP example),
which the script creates fresh (drop-if-exists, then create) on every run.

```bash
DATABASE_URL=postgres://user:pass@host:5432/dbname \
./deploy/backup/restore-postgres.sh /var/backups/awcms-mini/awcms_mini_20260705_020000.dump
```

To restore into a different, already-existing database (e.g. a genuine
disaster-recovery target), pass `--target=<dbname>` explicitly — the
script then requires typing the database name back to confirm (or `--yes`
to skip that prompt for non-interactive use) before running `pg_restore
--clean --if-exists`, which drops every object currently in that database.
The script refuses to run if `--target` names the same database
`DATABASE_URL` already points at (the live/source database).

```bash
# Explicit override — only ever point this at a database you intend to
# overwrite:
DATABASE_URL=postgres://user:pass@host:5432/dbname \
./deploy/backup/restore-postgres.sh /var/backups/awcms-mini/awcms_mini_20260705_020000.dump \
  --target=awcms_mini_recovery
```

After restoring, verify the data actually came back, e.g.:

```bash
psql "postgres://user:pass@host:5432/awcms_mini_restore_test" \
  -c 'SELECT count(*) FROM awcms_mini_tenants;'
```

## Scheduling the backup (plain crontab)

Doc 07/doc 18's LAN-first topology expects a scheduled backup on the same
host that runs the application (see
[`../systemd/awcms-mini.service.example`](../systemd/awcms-mini.service.example)
for the application unit). Schedule `backup-postgres.sh` with a plain
crontab entry — this repo intentionally does **not** also ship a systemd
timer for the same job, since running both would be two redundant
scheduling mechanisms for one task:

```cron
# /etc/cron.d/awcms-mini-backup (or `crontab -e` for the service user)
# Daily at 02:00 local time.
0 2 * * * DATABASE_URL=postgres://user:pass@host:5432/dbname BACKUP_DIR=/var/backups/awcms-mini BACKUP_RETENTION_DAYS=14 /opt/awcms-mini/deploy/backup/backup-postgres.sh >> /var/log/awcms-mini-backup.log 2>&1
```

Prefer keeping the environment variables in an `EnvironmentFile`-style
`.env` sourced by a small wrapper if you don't want secrets inline in
crontab (crontab files are usually readable only by root/the owning user,
but treat them the same as any other place secrets can leak from).

## See also

- [`../../docs/awcms-mini/deployment-profiles.md`](../../docs/awcms-mini/deployment-profiles.md)
  — which profile needs backups, and how this fits with the rest of
  `deploy/`.
- [`../../docs/awcms-mini/07_sprint_testing_production_readiness.md`](../../docs/awcms-mini/07_sprint_testing_production_readiness.md)
  §"Backup SOP ringkas" / "Restore SOP ringkas" — the source SOP these
  scripts implement.
- `.claude/skills/awcms-mini-production-preflight/SKILL.md` §"Backup &
  restore" — go-live checklist requiring a tested restore.

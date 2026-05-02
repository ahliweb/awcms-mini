# Database Backup And Restore

## Overview

AWCMS Mini PostgreSQL backups are managed through Coolify's built-in backup system,
with dual retention: local server storage (short-term) and Cloudflare R2/S3 (long-term).

## Current Configuration

| Setting                | Value                                     |
| ---------------------- | ----------------------------------------- |
| Backup config UUID     | `r3tr47lhqhoz9pd8m49stln2`                |
| Database UUID          | `kbzbui977dnkhdzl8xcw6v90`                |
| Database               | `awcms_mini`                              |
| Schedule               | Daily at 03:00 UTC (`0 3 * * *`)          |
| Local retention        | 7 copies / 7 days                         |
| S3 retention (planned) | 30 copies / 90 days                       |
| S3 enabled             | No (pending S3 storage destination setup) |

## Backup Automation

### Coolify API Management

The backup schedule is managed through the Coolify API. The setup script is at
`scripts/backup-coolify-setup.mjs`. Run:

```bash
pnpm audit:coolify-backup
```

This script reports the current backup posture (schedule, last execution, retention).

### Backup Execution

Coolify executes `pg_dump` on the PostgreSQL container, writes the dump file to
`/data/coolify/backups/databases/` on the VPS, and optionally uploads to S3.

Backup files follow the naming pattern:

```
pg-dump-<database_name>-<unix_timestamp>.dmp
```

## R2/S3 Backup Destination

The target R2 bucket is `coolify-backup-awcms-mini`. S3 storage must be configured
in the Coolify dashboard before `save_s3` can be enabled on the backup schedule.

See the GitHub issue tracking this setup for step-by-step instructions.

## Restore Procedure

### From Local Backup

1. Locate the desired backup file on the VPS under `/data/coolify/backups/databases/`
2. Use the Coolify dashboard database management terminal, or SSH to the VPS:

```bash
# On the Coolify VPS, restore via docker exec
docker exec -i <postgres_container> pg_restore \
  -U awcms_mini_app -d awcms_mini \
  --clean --if-exists --no-owner \
  /path/to/pg-dump-awcms_mini-<timestamp>.dmp
```

### From R2/S3

1. Download the backup from the R2 bucket `coolify-backup-awcms-mini`
2. Transfer to the VPS
3. Follow the local restore procedure above

### Emergency Recovery

For full recovery procedures, see `docs/security/emergency-recovery-runbook.md`.
For PostgreSQL-specific hardening and recovery, see `docs/process/postgresql-vps-hardening.md`.

## Validation

```bash
# Check backup posture
pnpm audit:coolify-backup

# Check database health on VPS
pnpm healthcheck
```

## Cross-References

- `docs/process/coolify-deployment.md` — deployment topology
- `docs/process/postgresql-vps-hardening.md` — PostgreSQL hardening
- `docs/security/emergency-recovery-runbook.md` — emergency recovery
- `docs/process/coolify-mcp-secret-handling.md` — Coolify credential management

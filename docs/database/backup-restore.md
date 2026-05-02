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

### Bucket

- **Name**: `coolify-backup-awcms-mini`
- **Location**: APAC
- **S3 endpoint**: `https://5255727b7269584897c8c97ebdd3347f.r2.cloudflarestorage.com`
- **Region**: `auto`

### Setup (manual — no public API for R2 token creation)

1. **Create R2 API token** in Cloudflare Dashboard → R2 → Manage R2 API Tokens:
   - Permission: **Object Read & Write**
   - Scope: restrict to bucket `coolify-backup-awcms-mini`
   - Save the **Access Key ID** and **Secret Access Key** immediately

2. **Add S3 storage** in Coolify Dashboard → Storage → S3 Storages → Add:
   - Name: `coolify-backup-awcms-mini`
   - Endpoint: `https://5255727b7269584897c8c97ebdd3347f.r2.cloudflarestorage.com`
   - Bucket: `coolify-backup-awcms-mini`
   - Region: `auto`
   - Access Key: from R2 API token
   - Secret Key: from R2 API token
   - Click **Validate Connection & Continue**

3. **Enable S3 on backup config** from the database Backups page, or via CLI:

   ```bash
   pnpm coolify:backup-setup --s3-storage-uuid <s3_storage_uuid_from_coolify>
   ```

4. **Verify** by triggering a manual backup and checking the R2 bucket:
   ```bash
   pnpm audit:coolify-backup
   ```

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

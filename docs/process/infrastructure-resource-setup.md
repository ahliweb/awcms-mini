# Infrastructure Resource Setup

## Purpose

This document lists the three principal infrastructure resources AWCMS Mini depends on and the operator steps to provision them. Once provisioned, the codebase `.env.local` and Coolify/Cloudflare-managed secrets must reference them.

## 1. Cloudflare R2 Bucket — `awcms-mini-s3`

### Provision

Create the bucket in the Cloudflare dashboard:

- Cloudflare Dashboard → R2 → Create bucket
- Name: `awcms-mini-s3`
- Location: automatic (or choose the nearest region)
- Default storage class: Standard

### Credentials

Generate S3-compatible API credentials so the Hono backend can access R2:

- R2 → Manage R2 API Tokens → Create API Token
- Permissions: Object Read & Write
- Scope: bucket `awcms-mini-s3` only
- Set TTL appropriate for your rotation policy
- Record `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`

### Environment Variables (Backend Only)

```
R2_MEDIA_BUCKET_BINDING=MEDIA_BUCKET
R2_MEDIA_BUCKET_NAME=awcms-mini-s3
R2_ACCESS_KEY_ID=<generated-access-key>
R2_SECRET_ACCESS_KEY=<generated-secret-key>
R2_MAX_UPLOAD_BYTES=5242880
R2_ALLOWED_CONTENT_TYPES=image/jpeg,image/png,image/webp,application/pdf
```

Store these as Coolify locked runtime secrets for the Hono backend service. Do not expose them in Cloudflare Pages public variables.

## 2. Domain — `awcms-mini.ahlikoding.com`

### Provision

The domain must be in the Cloudflare account `5255727b7269584897c8c97ebdd3347f` and registered as a Cloudflare Pages custom domain:

- Cloudflare Pages → awcms-mini → Custom domains → Add custom domain
- Domain: `awcms-mini.ahlikoding.com`
- Cloudflare will auto-configure DNS if the zone is managed

### Frontend Environment (Cloudflare Pages)

```
PUBLIC_API_BASE_URL=https://<hono-backend-origin>
```

### Backend Environment (Hono / Coolify)

```
SITE_URL=https://awcms-mini.ahlikoding.com
EDGE_API_ALLOWED_ORIGINS=https://awcms-mini.ahlikoding.com
TRUSTED_PROXY_MODE=cloudflare
```

### Validation

```
pnpm verify:live-runtime -- https://awcms-mini.ahlikoding.com
pnpm smoke:cloudflare-admin -- https://awcms-mini.ahlikoding.com
```

## 3. PostgreSQL — Coolify Resource `kbzbui977dnkhdzl8xcw6v90`

### Current Inventory (`.env.local`)

```
COOLIFY_POSTGRES_RESOURCE_UUID='kbzbui977dnkhdzl8xcw6v90'
COOLIFY_POSTGRES_SERVER_UUID='z7mcy4r3ejl6kno5neellf1f'
COOLIFY_POSTGRES_SERVER_IP='202.10.45.224'
```

### Provision

The PostgreSQL database is managed as a Coolify Docker service. Ensure:

- The PostgreSQL Docker service is running on the Coolify-managed VPS
- The database is private - not exposed to the public internet
- SSL/TLS is enabled on the PostgreSQL server
- The certificate covers `id1.ahlikoding.com`
- An application user (non-superuser) exists

### Connection String (Coolify Locked Secret)

```
DATABASE_URL=postgres://awcms_mini_app:<password>@id1.ahlikoding.com:5432/awcms_mini?sslmode=verify-full
```

Store as a Coolify locked runtime secret in the Hono backend service. The Hono backend is the only approved layer that reads this value.

### Validation

```
HEALTHCHECK_EXPECT_DATABASE_TRANSPORT=direct \
HEALTHCHECK_EXPECT_DATABASE_HOSTNAME=id1.ahlikoding.com \
HEALTHCHECK_EXPECT_DATABASE_SSLMODE=verify-full \
pnpm healthcheck
```

### Setup Recovery

If the EmDash setup wizard reports `Failed to run database migrations` on a partially bootstrapped database, the current setup flow skips replaying core migrations once the `options` table already exists. Retry the setup POST after confirming the backend is pointed at the intended PostgreSQL resource.

## Architecture Boundary

```
Cloudflare Pages (frontend) — awcms-mini.ahlikoding.com
        |
        v (calls Hono backend via PUBLIC_API_BASE_URL)
Hono Backend API — Coolify-managed VPS
        |
        +--> PostgreSQL Docker → awcms_mini (kbzbui977dnkhdzl8xcw6v90)
        |
        +--> Cloudflare R2 → awcms-mini-s3
```

- Cloudflare Pages/Workers are API clients of Hono, NOT direct database clients.
- PostgreSQL is behind Hono; not exposed to the public internet.
- EmDash architecture is preserved — upstream updates remain mergeable.

## Cross-References

- `docs/process/coolify-deployment.md`
- `docs/process/cloudflare-pages-deployment.md`
- `docs/process/secret-hygiene-coolify-cloudflare-topology-plan-2026.md`
- `docs/process/cloudflare-hostname-turnstile-r2-automation-plan-2026.md`
- `docs/architecture/runtime-config.md`

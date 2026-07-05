---
name: awcms-mini-production-preflight
description: Jalankan preflight & go-live readiness AWCMS-Mini sebelum production. Gunakan menjelang deploy/go-live, saat menyiapkan release, atau saat diminta cek production readiness. Sesuai doc 07 & 12.
---

# AWCMS-Mini — Production Preflight & Go-Live

Ikuti `docs/awcms-mini/07_sprint_testing_production_readiness.md` dan `docs/awcms-mini/12_generator_prompt.md`.

## Command preflight

```bash
bun install
bun run config:validate
bun run db:migrate
bun run api:spec:check
bun test
bun run build
bun run db:pool:health
bun run security:readiness
bun run production:preflight
```

`bun run production:preflight` (Issue 12.2) runs `config:validate` as its
first stage, before `db:migrate` — configuration must be valid before
anything else attempts to connect to a database or run migrations (doc 18
§Prinsip konfigurasi #5).

## Checklist go-live

**Application:** build pass · migration pass · OpenAPI valid · setup wizard locked · role default ada · ABAC default deny tested · RLS tested · soft delete default filter tested · logging aktif.

**Database:** versi sesuai target · PostgreSQL tidak public · least-privilege user · backup aktif · restore tested · index utama ada · partial index soft delete ada bila relevan · pool sehat · slow query monitoring.

**Security:** no hardcoded secret · `.env` aman & tidak dikomit · password hash modern · login lockout · RLS aktif · ABAC aktif · audit aktif · restore/purge berizin dan diaudit · tax data masked · CRM opt-out respected · AI read-only · sync HMAC bila hybrid · error tanpa stack trace · **no critical finding**.

**Runtime platform:** backend, script, test, migration, build, dan preflight berjalan dengan Bun. Tidak ada `node`, `npm`, `npx`, `pnpm`, `yarn`, adapter server Node.js, atau dependency yang memaksa runtime Node.js kecuali pengecualian tertulis sudah disetujui dan dicatat di docs/audit.

## Gate

```mermaid
flowchart LR
  C[Jalankan preflight] --> F{Critical finding?}
  F -- Ya --> Block[GO-LIVE DIBLOKIR]
  F -- Tidak --> Ready([Go-Live diizinkan])
```

## Backup & restore (wajib teruji)

```bash
pg_dump --format=custom --file=/backup/awcms_mini_$(date +%Y%m%d_%H%M%S).dump "$DATABASE_URL"
createdb awcms_mini_restore_test
pg_restore --dbname=awcms_mini_restore_test --clean --if-exists /backup/awcms_mini_YYYYMMDD_HHMMSS.dump
```

Validasi restore: tenant/user/produk/stok/transaksi terbaca · login test · POS smoke test · report smoke test.

Sejak Issue 12.2, kedua command di atas sudah diimplementasikan sebagai
skrip siap pakai: `deploy/backup/backup-postgres.sh` dan
`deploy/backup/restore-postgres.sh` (lihat `deploy/backup/README.md`).

## Output

Laporan production readiness: status tiap gate, temuan (severity), rollback plan, keputusan go/no-go. Critical control fail **memblokir** go-live.

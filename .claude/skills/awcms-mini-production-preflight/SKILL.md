---
name: awcms-mini-production-preflight
description: Jalankan preflight & go-live readiness AWCMS-Mini sebelum production. Gunakan menjelang deploy/go-live, saat menyiapkan release, atau saat diminta cek production readiness. Sesuai doc 07 & 12.
---

# AWCMS-Mini — Production Preflight & Go-Live

Ikuti `docs/awcms-mini/07_sprint_testing_production_readiness.md` dan `docs/awcms-mini/12_generator_prompt.md`.

## Command preflight

```bash
bun install
bun run db:migrate
bun run api:spec:check
bun test
bun run build
bun run db:pool:health
bun run security:readiness
bun run production:preflight
```

## Checklist go-live

**Application:** build pass · migration pass · OpenAPI valid · setup wizard locked · role default ada · ABAC default deny tested · RLS tested · soft delete default filter tested · logging aktif.

**Database:** versi sesuai target · PostgreSQL tidak public · least-privilege user · backup aktif · restore tested · index utama ada · partial index soft delete ada bila relevan · pool sehat · slow query monitoring.

**Security:** no hardcoded secret · `.env` aman & tidak dikomit · password hash modern · login lockout · RLS aktif · ABAC aktif · audit aktif · restore/purge berizin dan diaudit · tax data masked · CRM opt-out respected · AI read-only · sync HMAC bila hybrid · error tanpa stack trace · **no critical finding**.

## Gate

```mermaid
flowchart LR
  C[Jalankan preflight] --> F{Critical finding?}
  F -- Ya --> Block[GO-LIVE DIBLOKIR]
  F -- Tidak --> Ready([Go-Live diizinkan])
```

## Backup & restore (wajib teruji)

```bash
pg_dump --format=custom --file=/backup/awcms-mini_$(date +%Y%m%d_%H%M%S).dump "$DATABASE_URL"
createdb awcms-mini_restore_test
pg_restore --dbname=awcms-mini_restore_test --clean --if-exists /backup/awcms-mini_YYYYMMDD_HHMMSS.dump
```

Validasi restore: tenant/user/produk/stok/transaksi terbaca · login test · POS smoke test · report smoke test.

## Output

Laporan production readiness: status tiap gate, temuan (severity), rollback plan, keputusan go/no-go. Critical control fail **memblokir** go-live.

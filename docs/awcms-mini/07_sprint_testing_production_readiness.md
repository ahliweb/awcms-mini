# Bagian 7 — Sprint, Testing, dan Production Readiness

## Sprint plan base

| Sprint | Isi                                                            | Status     |
| ------ | -------------------------------------------------------------- | ---------- |
| S1     | Foundation: skeleton, runner, kontrak, health, readiness       | ✅ selesai |
| S2     | Setup wizard, login+lockout, auth middleware, profile resolver | rencana    |
| S3     | Katalog permission, evaluator ABAC, assignment API             | rencana    |
| S4     | Audit/log repository, pool gate work-class                     | rencana    |
| S5     | Workflow approval, admin shell                                 | rencana    |
| S6     | Sync opsional, readiness gates penuh, deployment profile       | rencana    |

Setiap sprint menjaga repository **buildable**; skeleton diberi TODO jelas dan tidak diklaim production-ready.

## Lapisan testing

| Lapisan     | Alat                          | Contoh                                                        |
| ----------- | ----------------------------- | ------------------------------------------------------------- |
| Unit        | `bun test tests/`             | Helper `_shared`, config, redaction, registry, plan migration |
| Integration | `bun test` + PostgreSQL nyata | Runner migration, repository, RLS isolation                   |
| Contract    | `bun run api:contract:test`   | Envelope endpoint publik terhadap server berjalan             |
| Fitness     | `api:spec:check`, registry    | Kontrak ↔ modul konsisten; dependency modul valid             |
| Statis      | `security:readiness`          | Env hygiene, RLS coverage, validitas migration                |

## Pola RLS isolation test (wajib untuk schema tenant-scoped baru)

Gunakan role **non-superuser** (superuser bypass RLS):

```sql
CREATE ROLE app_rls LOGIN PASSWORD '...';
GRANT USAGE ON SCHEMA public TO app_rls;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO app_rls;
```

Verifikasi tiga hal (sudah dibuktikan pada schema 001–004):

1. Insert tanpa `app.current_tenant_id` → **ditolak** policy.
2. Insert baris tenant lain dalam konteks tenant A → **ditolak**.
3. Select dalam konteks tenant B tidak melihat baris tenant A.

## Definition of Done per issue

- Scope sesuai issue; tanpa unrelated change.
- Migration bila schema berubah; OpenAPI bila API berubah; AsyncAPI bila event berubah.
- Input validation, Auth/ABAC/RLS, audit high-risk, sensitive masking.
- Test relevan pass; build pass; docs diperbarui; changeset ditambahkan.

## Pre-deploy checklist (doc 09)

```bash
bun install
bun run db:migrate
bun run api:spec:check
bun test
bun run build
bun run db:pool:health
bun run security:readiness
# atau sekaligus:
bun run production:preflight
```

## Go-live gates

| Gate | Kriteria                                                    |
| ---- | ----------------------------------------------------------- |
| G1   | `production:preflight` PASS (semua langkah)                 |
| G2   | RLS isolation test lulus pada semua tabel tenant-scoped     |
| G3   | ABAC default deny teruji; deny high-risk masuk decision log |
| G4   | Audit high-risk aktif; redaction teruji                     |
| G5   | Backup + restore PostgreSQL teruji (doc 08)                 |
| G6   | Tidak ada critical security finding terbuka                 |

**Critical finding = BLOCKED** — go-live tidak boleh dilanjutkan; perbaiki lalu evaluasi ulang.

## Insiden & rollback

- Migration gagal → runner berhenti otomatis (transaction per file, tidak tercatat di ledger); perbaiki lewat migration baru.
- Deploy bermasalah → rollback artefak build sebelumnya; database hanya maju (roll-forward).

---
name: awcms-mini-pr-review
description: Review pull request AWCMS-Mini terhadap Definition of Done dan kontrak proyek. Gunakan saat diminta review PR/diff AWCMS-Mini. Memeriksa scope atomic, migration/OpenAPI/AsyncAPI sinkron, tenant/ABAC/RLS, idempotency, audit, masking, test, dan docs sesuai doc 09, 10, 12.
---

# AWCMS-Mini — PR Review

Ikuti `docs/awcms-mini/12_generator_prompt.md` (Prompt Review PR), `docs/awcms-mini/09_roadmap_repository_commit.md` (PR checklist), dan `docs/awcms-mini/10_template_kode_coding_standard.md`.

## Fokus review

1. Scope sesuai issue; **tidak ada unrelated change**.
2. No secret / data customer asli / dump DB / `.env`.
3. Schema berubah → ada migration berurutan (`awcms-mini-new-migration`).
4. API berubah → OpenAPI diperbarui (`awcms-mini-new-endpoint`).
5. Event berubah → AsyncAPI diperbarui (`awcms-mini-new-event`).
6. Tenant context + ABAC + RLS untuk data tenant-scoped.
7. Idempotency untuk mutation high-risk.
8. Audit high-risk + redaction.
9. Soft delete policy untuk resource deletable; posted/append-only entity tidak dihapus.
10. Input validation lengkap; error response standar.
11. Sensitive data masked.
12. Test relevan ada & pass; build pass.
13. Docs diperbarui; commit mengikuti convention `<type>(<scope>): <summary>`.

## Konsistensi kontrak

- Migration ↔ ERD (doc 04) ↔ matrix migration (doc 13).
- Endpoint ↔ OpenAPI ↔ tabel error/header (doc 05).
- Event ↔ AsyncAPI ↔ `module.ts` publishes/subscribes.
- Soft delete ↔ ERD kolom/index ↔ OpenAPI DELETE/restore/includeDeleted ↔ audit event.
- Gate baru di script `check` ↔ **step tersendiri di `.github/workflows/ci.yml`**.
- Job baru ↔ descriptor `jobs` di `module.ts` ↔ `JOB_WORK_CLASS_REGISTRY` ↔ dua test daftar job.
- Descriptor family baru ↔ bump `MODULE_CONTRACT_VERSION` ↔ validator + gate.
- OpenAPI diedit di `openapi/modules/*.yaml` (BUKAN file bundle) lalu `openapi:bundle`.

## Cara test lolos padahal salah (tanyakan ini tiap review)

- **Assertion "pokoknya throw" pada batas GRANT.** Pada baris ter-seed, DELETE
  induk juga gagal `23503` (FK) — jadi test-nya membuktikan foreign key, bukan
  izin. Minta assert SQLSTATE `42501`. (Nyata: #932 mutation tetap hijau.)
- **Test DB yang memakai koneksi admin/superuser.** Superuser melewati GRANT
  DAN RLS → grant yang hilang dan kebocoran lintas-tenant sama-sama tak
  terdeteksi. Operasi yang diuji harus jalan sebagai `getTestSql()`/
  `getWorkerTestSql()`. (Nyata: #930, worker kurang SELECT di 4 tabel.)
- **Gate/validator yang cuma menegaskan "state sekarang valid".** Tetap hijau
  di hadapan validator yang selalu `{valid:true}` atau graf input tak lengkap.
  Minta bukti mutasi: satu hal dirusak → MERAH.
- **Assertion count non-diskriminatif** (`0 vs 0` karena nama action karangan).
- **Job/kolektor fleet-wide** yang tidak menerbitkan apa pun saat dibatalkan
  separuh jalan — total dari sebagian tenant terbaca sebagai penurunan
  fleet-wide dan memadamkan alert yang masih harus menyala.

## Output

```text
Verdict: Approve / Request changes / Comment only
Critical issues:
Security issues:
Functional issues:
Data/migration issues:
API/event contract issues:
Testing gaps:
Documentation gaps:
Suggested patch:
```

Untuk modul sensitif, jalankan juga `awcms-mini-security-review`.

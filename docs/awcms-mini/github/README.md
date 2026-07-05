# Dokumentasi GitHub AWCMS-Mini

Dokumen ini mencatat snapshot live repository GitHub `ahliweb/awcms-mini`. Folder ini adalah **snapshot state GitHub**, bukan backlog rencana; backlog rencana tetap berada di `docs/awcms-mini/06_github_issues_detail.md`. Metadata label/milestone di folder ini adalah salinan faktual dari GitHub saat refresh; bila ada deskripsi lama yang berbeda dari arsitektur Bun + Astro 7 + PostgreSQL, ikuti `README.md`, `AGENTS.md`, dan dokumen utama `docs/awcms-mini/`.

| Metadata     | Nilai                           |
| ------------ | ------------------------------- |
| Repository   | `ahliweb/awcms-mini`            |
| Snapshot     | 2026-07-05T03:38:53Z            |
| Total issue  | 38                              |
| Open issue   | 12                              |
| Closed issue | 26                              |
| Labels       | 98 (25 doc 06 + 73 peninggalan) |
| Milestones   | 24 (5 doc 06 + 19 peninggalan)  |

## File snapshot

| State           | File                                         |                                         Jumlah issue |
| --------------- | -------------------------------------------- | ---------------------------------------------------: |
| OPEN            | [issues-open-001.md](issues-open-001.md)     |                                                   12 |
| CLOSED          | [issues-closed-001.md](issues-closed-001.md) |                                                   26 |
| LABEL/MILESTONE | [labels-milestones.md](labels-milestones.md) |                             98 labels, 24 milestones |
| SECURITY        | [security.md](security.md)                   | Security policy, Dependabot, secret scanning, CodeQL |

## Aturan pencatatan

1. Snapshot issue GitHub disimpan di folder ini, bukan menggantikan `06_github_issues_detail.md` yang tetap menjadi template issue rencana.
2. File issue dipisah berdasarkan state: `issues-open-NNN.md` dan `issues-closed-NNN.md`.
3. Satu file issue tidak boleh berisi lebih dari 100 issue.
4. Jangan menyalin token, secret, dump database, atau data customer asli ke issue maupun snapshot docs.
5. Saat issue, label, atau milestone berubah di GitHub, refresh snapshot ini agar docs tetap sinkron dengan state GitHub terbaru.

## Proses refresh snapshot

```bash
gh auth status
gh issue list --repo ahliweb/awcms-mini --state all --limit 1000 --json number,title,state,createdAt,updatedAt,closedAt,author,labels,assignees,milestone,url,body,comments
gh label list --repo ahliweb/awcms-mini --limit 500 --json name,description,color
gh api 'repos/ahliweb/awcms-mini/milestones?state=all&per_page=100'
```

Setelah data diambil, regenerate file di folder ini dengan pembagian state dan batas 100 issue per file, lalu update metadata di `README.md`, `docs/awcms-mini/README.md`, `06_github_issues_detail.md`, `09_roadmap_repository_commit.md`, `13_final_master_index_traceability.md`, dan `CHANGELOG.md` bila struktur dokumentasi berubah.

## Ringkasan state saat snapshot

| State  | Jumlah | Catatan                                                                                                                                |
| ------ | -----: | -------------------------------------------------------------------------------------------------------------------------------------- |
| OPEN   |     12 | Backlog generik base `docs/awcms-mini/06_github_issues_detail.md` (Epic 2, 6, 8, 9, 10, 11, 12).                                       |
| CLOSED |     26 | 20 issue domain ditutup `not planned`; #371-#373, #376, #377, dan #378 ditutup `completed` setelah Issue 0.1-0.3, 2.1, 2.2, 2.3 merge. |

### Identity login schema 2.3 completed (2026-07-05)

Issue [#378](https://github.com/ahliweb/awcms-mini/issues/378) ditutup `completed` setelah migrasi `sql/004_awcms_mini_identity_login_schema.sql` menambahkan `awcms_mini_identities` (login per tenant, password hash argon2id via `Bun.password`, lockout), `awcms_mini_tenant_users` (status keanggotaan), dan `awcms_mini_sessions` (token opaque, hanya hash disimpan). Endpoint live pertama yang menyentuh database: `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`. Infrastruktur baru: `src/lib/database/client.ts`, `src/lib/database/tenant-context.ts` (`withTenant`/`assertUuid`, `SET LOCAL app.current_tenant_id`), `src/lib/auth/password.ts`, `src/lib/auth/session-token.ts`. Domain logic murni `evaluateLoginAttempt` (anti user-enumeration, lockout otomatis). Diverifikasi langsung terhadap PostgreSQL 16 + server Astro SSR berjalan: login sukses/gagal, tenant inactive ditolak, lockout setelah 5 percobaan gagal, logout benar-benar mencabut sesi. Label `#379` (2.4) `status:blocked` → `status:ready` (Sprint 2 tuntas).

### Central profile schema 2.2 completed (2026-07-05)

Issue [#377](https://github.com/ahliweb/awcms-mini/issues/377) ditutup `completed` setelah migrasi `sql/003_awcms_mini_central_profile_management_schema.sql` menambahkan `awcms_mini_profiles`, `awcms_mini_profile_identifiers` (dedup + masking, identifier type digenerikkan dari NPWP/NIK/"customer code" di doc 03), `awcms_mini_profile_channels`, `awcms_mini_profile_addresses`, `awcms_mini_profile_entity_links`, `awcms_mini_profile_merge_requests` (constraint source ≠ target), dan `awcms_mini_profile_audit_logs` (append-only), plus domain logic murni (`normalizeIdentifier`/`hashIdentifier`/`maskIdentifier`/`assertMergeRequestIsValid`) dan modul `profile-identity` terdaftar. Diverifikasi langsung terhadap container PostgreSQL 16: migration apply bersih, dedup identifier menolak duplikat aktif namun mengizinkan reuse setelah soft delete, dan constraint merge source=target ditolak database.

### Tenant/office schema 2.1 completed + koreksi sprint (2026-07-05)

Issue [#376](https://github.com/ahliweb/awcms-mini/issues/376) ditutup `completed` setelah migrasi `sql/002_awcms_mini_tenant_office_schema.sql` menambahkan `awcms_mini_tenants`, `awcms_mini_offices`, `awcms_mini_physical_locations`, `awcms_mini_tenant_settings` dengan RLS tenant isolation dan soft delete pada tabel office-scoped, plus modul `tenant-admin` terdaftar. Diverifikasi langsung terhadap container PostgreSQL 16 (bukan hanya build/test): migration apply bersih, RLS mengisolasi role non-superuser per tenant, duplicate `office_code` aktif ditolak, dan kode bisa dipakai ulang setelah soft delete.

Saat scoping issue ini, ditemukan Issue [#407](https://github.com/ahliweb/awcms-mini/issues/407) (12.1 — Setup Wizard) salah sequencing: butuh skema tenant/identity/RBAC dari #376/#378/#379 (Sprint 2/3), tapi sebelumnya di Sprint 1 sejajar 0.1-0.3. Label disesuaikan: `#376`/`#377`/`#378` `status:blocked` → `status:ready`; `#407` `status:ready` → `status:blocked` (komentar penjelasan ditambahkan di issue). Detail: `docs/awcms-mini/06_github_issues_detail.md` §Koreksi urutan sprint, `AUDIT_STANDAR_PENGEMBANGAN_2026-07-04.md`.

### API contract 0.3 completed (2026-07-05)

Issue [#373](https://github.com/ahliweb/awcms-mini/issues/373) ditutup `completed` setelah commit `f7f66e7` menambahkan baseline OpenAPI (`openapi/awcms-mini-public-api.openapi.yaml`), baseline AsyncAPI (`asyncapi/awcms-mini-domain-events.asyncapi.yaml`), validator `scripts/api-spec-check.ts`, script `bun run api:spec:check`, shared response/error schema, pola soft delete/restore/purge, header HMAC sync, domain event envelope, dan test validator.

### Migration runner 0.2 completed (2026-07-05)

Issue [#372](https://github.com/ahliweb/awcms-mini/issues/372) ditutup `completed` setelah commit `9bbbae4` menambahkan runner migrasi PostgreSQL Bun-native (`scripts/db-migrate.ts`), script `bun run db:migrate`, checksum SHA-256, skip applied migration, deteksi checksum drift, advisory lock, transaction boundary runner, redaksi `DATABASE_URL`, test helper, dan panduan `docs/awcms-mini/database-migrations.md`.

### Foundation 0.1 completed (2026-07-05)

Issue [#371](https://github.com/ahliweb/awcms-mini/issues/371) ditutup `completed` setelah commit `f09a5a1` menambahkan Astro foundation build, health endpoint `/api/v1/health`, module contract/registry, API response helper, soft-delete convention, `.env.example`, foundation SQL schema, folder standar, unit test foundation, dan CI build gate.

### Reconciliation #2 (2026-07-04, lanjutan)

Audit menyeluruh (bandingkan **setiap field** tiap issue — Problem/Scope/Out of Scope/Acceptance Criteria/Security Notes/Testing/Reference Docs — terhadap `docs/awcms-mini/06_github_issues_detail.md` per issue, plus label & milestone terhadap tabel rekomendasi doc 06) menemukan 14 dari 18 issue open masih drift dari doc 06 saat ini. **Tidak ada perubahan jumlah/label/milestone** (tetap 18 open, 20 closed, 98 label, 24 milestone — semua label doc 06 terverifikasi ada di GitHub, semua milestone issue terverifikasi cocok tabel rekomendasi). Perbaikan hanya pada **body issue**:

- **2 konflik konten nyata** (leftover bahasa domain dari sebelum genericization, belum ikut ter-update saat itu):
  - **#371** (0.1): "Out of Scope" masih menyebut "POS, inventory, provider eksternal" → diganti "modul domain aplikasi turunan (katalog, transaksi, dsb.)" sesuai doc 06.
  - **#377** (2.2): "Acceptance Criteria" masih menyebut "user/customer/tax/CRM" → diganti "entitas modul lain" sesuai doc 06.
- **12 issue dengan Reference Docs basi** (dibuat sebelum `docs/adr/` dan doc 20 ada, tidak ikut diperbarui saat #379/#405 direconcile sebelumnya): #371, #372, #373 (Epic 0 → +ADR 0001-0002, 0007), #376, #377, #378 (Epic 2 → +ADR 0003-0004), #391, #392, #393 (Epic 6 → +ADR 0006), #403, #404 (Epic 10 → +doc 20 +ADR 0003-0005, menyamakan pola #405), #406 (Epic 11 → +ADR 0004).
- Issue yang **sudah cocok** tanpa perubahan: #379, #398, #401, #405, #407, #408 (Reference Docs sudah sesuai tabel doc 06 — epic 8/9/12 memang tidak punya ADR spesifik di tabel).

### Reconciliation #1 (2026-07-05)

Setelah penambahan standar profesional repo publik (lisensi MIT, governance/community files, ADR `docs/adr/`, doc 20 threat model, CI kualitas dokumentasi), issue GitHub diselaraskan dengan kondisi terbaru saat itu:

- **#405** (10.3 — Production Security Readiness): Reference Docs ditambah doc 20 (threat model) + ADR 0003–0005; readiness wajib memverifikasi kontrol pada threat model dan konsisten dengan ADR.
- **#379** (2.4 — RBAC and ABAC): Reference Docs ditambah doc 20 + `docs/adr/0004-rbac-abac-default-deny.md`.

Backlog `docs/awcms-mini/06_github_issues_detail.md` §Dokumen acuan per epic juga diselaraskan untuk merujuk ADR + doc 20 per epic. (Reconciliation #1 ini ternyata tidak lengkap — 12 issue lain baru menyusul di Reconciliation #2 di atas.)

### Genericization (2026-07-04)

Repository awcms-mini adalah **contoh repo pengembangan umum** (base modular monolith reusable), bukan aplikasi domain. Backlog awal (38 issue, aktivasi pertama pada hari yang sama) ternyata memuat epic domain POS/retail yang salah tempat. Perbaikan yang dilakukan:

- **20 issue ditutup** (`not planned`, dengan komentar penjelasan): Legacy Migration (1.1-1.2), POS MVP (3.1-3.4), Warehouse Management (4.1-4.4), CRM Receipt Delivery (5.1-5.3), Accounting/Coretax (7.1-7.4), POS UI (8.2), Receipt Portal (8.3), AI Business Analyst (9.2).
- **2 issue digeneralisasi**: 8.1 "Build Admin/Petugas Layout Shell" → "Build Admin Layout Shell"; 9.1 scope diubah dari view POS/tax/warehouse-specific menjadi view generik (tenant activity, access/audit summary, sync health, module usage).
- **7 label dihapus** (dibuat keliru pada aktivasi pertama, tidak relevan untuk base generik): `area:pos`, `area:warehouse`, `area:tax`, `area:crm`, `area:ai`, `area:migration`, `area:inventory`.
- **4 milestone dihapus** (jadi kosong setelah issue domain ditutup): `M1 — Legacy Migration & Data Model`, `M3 — POS MVP`, `M4 — Inventory & Warehouse`, `M6 — Tax/Coretax Readiness`.
- **2 milestone di-rename**: `M5 — CRM, Receipt, Sync` → `M5 — Sync Storage` (drop CRM); `M7 — Reporting, AI, UI/UX` → `M7 — UI/UX & Reporting` (drop AI).
- **Docs diperbaiki** agar konsisten dengan base generik: `docs/awcms-mini/06_github_issues_detail.md` ditulis ulang (backlog 18 issue), `docs/awcms-mini/01_canvas_induk.md` ditulis ulang (hapus modul/fase domain), `AGENTS.md` §Peta modul dan `docs/awcms-mini/09_roadmap_repository_commit.md` §Struktur source diperbaiki (hapus daftar modul domain).
- **Label/milestone peninggalan** SIKESRA/governance-overlay era (73 label, 19 milestone) **tidak disentuh** — bukan buatan sesi ini, di luar wewenang untuk dihapus.

## Hubungan dengan dokumen utama

- `docs/awcms-mini/06_github_issues_detail.md` adalah rencana/template issue atomic generik; sebagian issue sudah selesai dan sisanya tercatat di snapshot open.
- `docs/awcms-mini/github/` adalah snapshot state GitHub aktual.
- `docs/awcms-mini/github/security.md` mencatat setup GitHub Security dan alert count saat refresh.
- `docs/awcms-mini/09_roadmap_repository_commit.md` mengatur urutan branch, commit, PR, release, dan changeset.
- `AGENTS.md` tetap menjadi kontrak kerja agent dan developer.
- Metadata GitHub tidak menjadi otoritas arsitektur; arsitektur target tetap Bun + Astro 7 + PostgreSQL sesuai dokumen utama.

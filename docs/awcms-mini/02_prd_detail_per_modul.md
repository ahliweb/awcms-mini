# Bagian 2 — PRD Detail per Modul Base

## Tujuan PRD

Menjelaskan kebutuhan produk tiap modul base: problem, scope, dan acceptance criteria. Modul domain (POS, inventory, dsb.) berada di PRD aplikasi turunan (contoh: paket AWPOS doc 02).

## Persona utama base

| Persona                    | Kebutuhan                                              |
| -------------------------- | ------------------------------------------------------ |
| Owner                      | Setup aplikasi, kontrol penuh akses, approval, go-live |
| Admin                      | Kelola user, role, office, konfigurasi                 |
| Staff                      | Menggunakan modul domain sesuai permission             |
| Auditor                    | Membaca audit trail, log, decision log (read-only)     |
| Developer aplikasi turunan | Base yang konsisten, terdokumentasi, aman by default   |

## Modul 1 — Tenant Admin (`tenant_admin`)

### Problem

Aplikasi butuh unit kepemilikan data (tenant) + struktur office, dengan setup awal yang aman dan sekali jalan.

### Scope

- Tenant, office (hierarkis: head_office/branch/store/warehouse/other), tenant settings.
- Setup wizard: buat tenant pertama + owner + seed default (doc 17), lalu terkunci.

### Acceptance criteria

- Setup hanya bisa dijalankan sekali (idempotent, locked setelah sukses).
- Office unik per tenant (`tenant_id, office_code`).
- Semua data tenant-scoped ter-RLS.

## Modul 2 — Identity & Access (`identity_access`)

### Problem

Akses harus default deny, terpusat, dan bisa diaudit; login harus tahan brute force.

### Scope

- Identity login (lockout setelah N gagal), tenant user membership.
- RBAC: role per tenant → permission `module.activity.action` (katalog global).
- ABAC: policy allow/deny per tenant, evaluator default deny, deny overrides allow, decision log.

### Acceptance criteria

- Tanpa allow eksplisit semua akses ditolak; deny selalu menang.
- Deny high-risk tercatat di `awcms_abac_decision_logs`.
- `password_hash` tidak pernah keluar response/log; lockout aktif.

## Modul 3 — Profile Identity (`profile_identity`)

### Problem

Data orang/organisasi tersebar dan duplikat; identifier sensitif (email, phone, NPWP, NIK) butuh perlindungan sejak disimpan.

### Scope

- Central profile per tenant (user/customer/supplier/contact).
- Identifier: normalisasi → `value_hash` (lookup/dedup) + `masked_value` (tampilan).
- Resolver idempotent, entity link, merge request (butuh approval).

### Acceptance criteria

- Identifier unik per `(tenant, type, value_hash)`; nilai mentah tidak pernah tampil.
- Resolve dengan identifier sama mengembalikan profile sama (idempotent).
- Merge butuh approval dan meninggalkan jejak `merged_into_profile_id`.

## Modul 4 — Localization UI (`localization_ui`)

- Locale id/en/ms/ar (ar = RTL), fallback chain, preferensi per tenant (`default_locale`, `default_theme`).
- Acceptance: teks UI tidak hardcode; penambahan locale tidak mengubah kode modul lain.

## Modul 5 — Observability Logging (`observability_logging`)

- Log event, audit event, security event — tenant-scoped, ber-`correlation_id`.
- Redaction wajib sebelum simpan; auditor bisa baca via API read-only.
- Acceptance: high-risk action selalu menghasilkan audit event dalam transaction yang sama.

## Modul 6 — Database Connectivity (`database_connectivity`)

- Pool per work class, antrean + timeout → `503 DATABASE_BUSY`, circuit breaker, PgBouncer opsional.
- Acceptance: saturasi memicu event `database.pool.saturated`; health endpoint melaporkan status.

## Modul 7 — Workflow Approval (`workflow_approval`)

- Approval generik untuk high-risk action modul lain; self-approval ditolak.
- Acceptance: decision idempotent; task approve/reject menghasilkan event + audit.

## Modul 8 — Management Reporting (`management_reporting`)

- Kontrak laporan read-only (DTO projection, pagination keyset); sumber data view/materialized view.
- Acceptance: laporan tidak pernah mengekspos kolom sensitif.

## Modul 9 — UI Experience (`ui_experience`)

- Admin shell + navigation registry yang membaca module registry dan permission user.
- Acceptance: modul baru muncul di navigasi hanya lewat registry + permission, tanpa hardcode.

## Modul 10 — Production Security Readiness (`production_security_readiness`)

- Readiness assessment, finding, go-live gates; `scripts/security-readiness.ts` adalah pemeriksa statisnya.
- Acceptance: critical finding = BLOCKED; go-live gate tidak bisa dilewati manual.

## Modul 11 — Sync Storage (`sync_storage`, opsional)

- Sync push/pull HMAC-signed anti-replay, conflict manual, object queue (R2 opsional).
- Acceptance: duplicate event idempotent; provider off tidak menghentikan aplikasi.

## Out of scope base

- Logika bisnis domain (katalog, transaksi, pajak, CRM) — milik aplikasi turunan.
- Integrasi provider spesifik — hanya kontrak adapter + feature flag yang disediakan base.

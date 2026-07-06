# Panduan Implementasi Aplikasi Turunan

> **Dokumen base (bukan contoh domain).** Dokumen ini menjelaskan cara membangun aplikasi turunan **di atas** AWCMS-Mini setelah base generik selesai (v0.23.5, seluruh 18 issue backlog doc06 + peningkatan pasca-backlog M9 tuntas — lihat [`README.md`](README.md) §Langkah berikutnya dan [`AGENTS.md`](../../AGENTS.md) §Mulai dari sini). Lima contoh aplikasi di §Contoh aplikasi turunan adalah **ilustrasi**, bukan modul yang ditambahkan ke base ini.

## Base reusable vs domain-specific extension

Sebelum menulis kode apa pun, pahami batasnya: base menyediakan infrastruktur dan kontrak yang **dipakai ulang tanpa diubah**; aplikasi turunan hanya menambah **modul domain baru** di atasnya.

| Reusable (base — jangan diubah)                                                                                                      | Domain-specific (aplikasi turunan — Anda tambahkan)                                |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Modular monolith + module contract (`src/modules/_shared/module-contract.ts`, doc 10/11)                                             | Modul domain baru di `src/modules/<domain>/`                                       |
| RBAC + ABAC default-deny + RLS (ADR-0003/0004, `src/modules/identity-access/`)                                                       | Permission/role/policy spesifik domain (doc 17 pola, bukan isinya)                 |
| Migration runner checksum-based, konvensi `NNN_awcms_mini_<area>_<desc>.sql`                                                         | Skema tabel domain (skill `awcms-mini-new-migration`)                              |
| Kontrak OpenAPI/AsyncAPI wajib + `api:spec:check` (ADR-0007/0008)                                                                    | Endpoint/event domain (skill `awcms-mini-new-endpoint`/`awcms-mini-new-event`)     |
| Soft delete + immutability posted (ADR-0005)                                                                                         | Kebijakan resource domain mana yang boleh restore/purge                            |
| Audit trail generik (`awcms_mini_audit_events`) + retensi/purge + correlation ID (Issue 10.1/#447, skill `awcms-mini-observability`) | Aksi high-risk spesifik domain yang wajib diaudit (skill `awcms-mini-audit-log`)   |
| Idempotency ledger generik (`awcms_mini_idempotency_keys`)                                                                           | Mutation high-risk domain mana yang wajib `Idempotency-Key`                        |
| Server-side form draft persistence generik (`awcms_mini_form_drafts`, `/api/v1/form-drafts`, Issue #484)                             | Apa isi `payload` draft dan `moduleKey`/`wizardKey`/`resourceType` spesifik domain |
| Structured logger + extension point (`setLogSink`/`setAuditExportHook`)                                                              | Consumer log/audit nyata (SIEM, alerting) — base hanya sediakan titik pasang       |
| Design system, token, state pattern, i18n (doc 14, skill `awcms-mini-i18n`)                                                          | Layar admin/operator/portal domain (skill `awcms-mini-ui-screen`)                  |
| Offline-first sync (outbox/inbox, HMAC, conflict tracking, object queue dispatcher — Issue 6.1-6.3/#436)                             | Payload event domain yang disinkronkan lewat outbox yang sama                      |
| Connection pooling + work-class backpressure + circuit breaker (Issue 10.2, per-provider sejak #436)                                 | Provider eksternal domain (WA/email/AI/pajak) di belakang flag + outbox            |
| Production readiness tooling (`db:pool:health`, `security:readiness`, `production:preflight`)                                        | Item checklist domain tambahan (mis. tax data masking untuk aplikasi pajak)        |
| Skill proyek `.claude/skills/`                                                                                                       | —                                                                                  |

Prinsip: **pertahankan** kolom kiri apa adanya; **tambahkan** kolom kanan mengikuti pola yang sudah mapan. Jangan menulis ulang RLS/ABAC/audit/idempotency Anda sendiri — base sudah menyediakannya, cukup dipakai.

## Alur membangun aplikasi turunan (9 langkah)

Setiap langkah dipetakan ke skill nyata (`.claude/skills/`) — panggil skill itu, jangan menebak polanya sendiri.

1. **Definisikan PRD/SRS domain** — pola doc 02/03 (isi generik-nya sudah base; entitas retail/POS di dalamnya adalah contoh AWPOS, ganti dengan domain Anda). Tentukan entitas, aktor, dan alur bisnis inti.
2. **Scaffold modul domain** — `src/modules/<domain-key>/` dengan struktur `domain/application/infrastructure/api` + `module.ts` + `README.md`. Skill: `awcms-mini-new-module`. Modul baru mulai `version: "0.1.0"`, `status: "experimental"` (ADR-0008) — naik ke `active`/`1.0.0` setelah matang (lihat §Definisi "matang" di bawah).
3. **Migration PostgreSQL + RLS** — tabel tenant-scoped **wajib** `tenant_id`, `ENABLE`+`FORCE ROW LEVEL SECURITY`, policy `app.current_tenant_id`, index berprefiks `(tenant_id, …)`. Skill: `awcms-mini-new-migration`.
4. **Seed RBAC/ABAC domain** — permission/role/policy baru mengikuti pola doc 17 (bukan menyalin isi ilustratifnya); evaluator ABAC yang sudah ada (`evaluateAccess`, default-deny) dipakai ulang, bukan ditulis ulang. Skill: `awcms-mini-abac-guard`.
5. **Endpoint REST + OpenAPI, domain event + AsyncAPI** — route tipis (auth → tenant context → ABAC guard → validasi → idempotency bila high-risk → service+transaction → response helper standar). Skill: `awcms-mini-new-endpoint` (REST), `awcms-mini-new-event` (event domain). Mutation high-risk wajib `Idempotency-Key` — skill `awcms-mini-idempotency`.
6. **UI/admin screen** — token desain, 4-state pattern (loading/empty/error/ready), a11y WCAG 2.1 AA, string via katalog `.po` (bukan hardcode). Skill: `awcms-mini-ui-screen` (layar baru), `awcms-mini-i18n` (katalog terjemahan), `awcms-mini-ux-review` (audit layar yang sudah jadi). Untuk input panjang/bertahap (identitas → detail → lampiran → review) — skill `awcms-mini-wizard-form` (reusable wizard pattern, Issue #479).
7. **Audit & observability** — aksi high-risk domain (approve, price change, transaksi posted/cancel, dst.) wajib `recordAuditEvent`. Skill: `awcms-mini-audit-log` (apa yang diaudit), `awcms-mini-observability` (correlation ID otomatis, retensi/purge, extension point bila aplikasi turunan butuh forward ke SIEM eksternal).
8. **Test berlapis + security review** — unit (domain logic murni), integration (endpoint terhadap Postgres nyata), kontrak (`api:spec:check`), keamanan (ABAC default-deny, RLS FORCE, redaksi). Skill: `awcms-mini-testing`, `awcms-mini-security-review` (checklist DoD per modul), `awcms-mini-security-hardening` (audit OWASP/ASVS/ISO bila menjelang audit eksternal/go-live besar).
9. **Deployment & go-live** — `bun run production:preflight` (orkestrasi migrate → api:spec:check → test → build → db:pool:health → security:readiness). Skill: `awcms-mini-production-preflight`. Pilih & jalankan profil deployment (doc `deployment-profiles.md`): LAN-first (`docker-compose.yml`) atau registry-based (`Dockerfile.production`, Issue #454; panduan Coolify di [`deploy-coolify.md`](deploy-coolify.md), Issue #462) — skill `awcms-mini-deploy`.

Orkestrasi satu unit kerja penuh (baca docs → implementasi → migration/OpenAPI/AsyncAPI/test/docs → laporan): skill `awcms-mini-implement-issue`.

### Kapan modul dianggap "matang" (`active`, ADR-0008)

Modul naik dari `experimental` ke `active` ketika: endpoint/domain logic-nya nyata dipakai (bukan scaffold kosong), RLS+ABAC terpasang dan diuji, test berlapis lulus, dan sudah melalui `awcms-mini-security-review`. Jangan tandai `active` sebelum itu — status ini metadata deskriptif yang dibaca kontributor lain untuk menilai kematangan modul, bukan gerbang runtime.

## Contoh aplikasi turunan (ilustratif — bukan bagian base)

Lima contoh berikut menunjukkan bagaimana base yang sama melayani domain yang sangat berbeda. **Tidak satu pun** dari modul/entitas di bawah ada di `src/modules/` base ini — ini murni ilustrasi untuk membantu Anda memetakan domain Anda sendiri ke pola di atas.

| Aplikasi                                  | Domain                                                 | Modul domain ilustratif (bukan bagian base)             | Contoh entitas tenant-scoped                          |
| ----------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------- | ----------------------------------------------------- |
| **AWPOS** (retail/POS)                    | Penjualan ritel, gudang, pajak, CRM                    | `sales`, `inventory`, `tax-coretax`, `crm`              | Produk, transaksi, stok, pelanggan                    |
| **Satu Sehat Kobar** (internal kesehatan) | Integrasi data kesehatan internal per fasilitas        | `health-records`, `satu-sehat-sync`                     | Rekam kunjungan, faskes, petugas                      |
| **Sistem Manajemen Mutu Faskes**          | Audit mutu, insiden, akreditasi                        | `quality-audit`, `incident-report`, `accreditation`     | Temuan audit, insiden keselamatan, dokumen akreditasi |
| **Smart School Portal**                   | Akademik, kehadiran, nilai, komunikasi ortu            | `academic`, `attendance`, `grading`, `parent-portal`    | Siswa, kelas, jadwal, nilai                           |
| **Sistem Pengaduan Publik**               | Pengaduan warga, disposisi, tindak lanjut lintas dinas | `complaint-intake`, `disposition`, `follow-up-tracking` | Pengaduan, unit penerima, status tindak lanjut        |

Setiap aplikasi di atas **tetap** memakai identity/login, RBAC/ABAC, RLS, audit trail, i18n, dan admin shell base yang sama — modul domain di atas hanya menambah entitas + endpoint + layar yang spesifik pada domainnya, mengikuti 9 langkah di atas.

## Checklist keamanan & kepatuhan praktis

Wajib dipenuhi modul domain baru sebelum dianggap siap produksi (turunan dari doc 10/12/13, skill `awcms-mini-security-review`):

- [ ] **Tenant context** — setiap query tenant-scoped lewat `withTenant()`/`SET LOCAL app.current_tenant_id`; tidak ada `WHERE tenant_id` yang dilewati manual dari input.
- [ ] **ABAC default-deny** — endpoint non-public dicek `evaluateAccess()`; permission baru diseed eksplisit, tidak ada grant implisit.
- [ ] **RLS** — tabel tenant-scoped baru `ENABLE`+`FORCE ROW LEVEL SECURITY` + policy isolasi; index berprefiks `(tenant_id, …)`.
- [ ] **Audit** — aksi high-risk domain (soft delete/restore/purge, approval, perubahan harga/status kritis, dst.) menghasilkan `awcms_mini_audit_events` row via `recordAuditEvent`.
- [ ] **Idempotency** — mutation high-risk domain menerima `Idempotency-Key`, aman diulang.
- [ ] **Redaksi/masking** — identifier sensitif domain (NIK, nomor rekam medis, dst. — pola sama seperti NPWP/NIK/email di base) di-hash+mask sebelum disimpan/ditampilkan/di-log.
- [ ] **Kontrak sinkron** — `bun run api:spec:check` hijau untuk setiap endpoint/event domain baru.
- [ ] **Test berlapis** — unit (domain logic), integration (Postgres nyata), keamanan (RLS/ABAC dipaksa gagal untuk membuktikan gate benar-benar memblokir, bukan hanya "pass" diam-diam).
- [ ] **`bun run production:preflight`** hijau sebelum go-live.

## Referensi

- [`examples/minimal-domain-module.md`](examples/minimal-domain-module.md)
  — contoh konkret satu modul domain minimal (struktur folder, descriptor,
  migration+RLS, seed permission, endpoint, OpenAPI/AsyncAPI snippet, dan
  checklist test/keamanan) — Issue #463.
- [`derived-app-pilot-plan.md`](derived-app-pilot-plan.md) — rencana
  pilot aplikasi turunan pertama (matriks kandidat, rekomendasi AWPOS,
  boundary modul, initial issue breakdown) — Issue #465.
- [`AGENTS.md`](../../AGENTS.md) §Mulai dari sini — entry point kontributor.
- [`README.md`](README.md) §Langkah berikutnya — ringkasan alur yang sama, versi singkat.
- [`docs/adr/`](../adr/README.md) — keputusan arsitektural base (ADR-0001 s.d. 0008).
- `docs/awcms-mini/01` s.d. `20` — paket dokumen master (§Peta dokumen di README ini).
- [`deployment-profiles.md`](deployment-profiles.md) — profil deployment (development/staging/production/offline-LAN, LAN-first compose vs registry image).
- `.claude/skills/README.md` — katalog skill lengkap + peta pemakaian.

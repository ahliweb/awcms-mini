# Dokumentasi GitHub AWCMS-Mini

Dokumen ini mencatat snapshot live repository GitHub `ahliweb/awcms-mini`. Folder ini adalah **snapshot state GitHub**, bukan backlog rencana; backlog rencana tetap berada di `docs/awcms-mini/06_github_issues_detail.md`. Metadata label/milestone di folder ini adalah salinan faktual dari GitHub saat refresh; bila ada deskripsi lama yang berbeda dari arsitektur Bun + Astro 7 + PostgreSQL, ikuti `README.md`, `AGENTS.md`, dan dokumen utama `docs/awcms-mini/`.

| Metadata     | Nilai                           |
| ------------ | ------------------------------- |
| Repository   | `ahliweb/awcms-mini`            |
| Snapshot     | 2026-07-04T14:15:43Z            |
| Total issue  | 38                              |
| Open issue   | 18                              |
| Closed issue | 20                              |
| Labels       | 98 (25 doc 06 + 73 peninggalan) |
| Milestones   | 24 (5 doc 06 + 19 peninggalan)  |

## File snapshot

| State           | File                                         |                                         Jumlah issue |
| --------------- | -------------------------------------------- | ---------------------------------------------------: |
| OPEN            | [issues-open-001.md](issues-open-001.md)     |                                                   18 |
| CLOSED          | [issues-closed-001.md](issues-closed-001.md) |                                                   20 |
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

| State  | Jumlah | Catatan                                                                                                     |
| ------ | -----: | ----------------------------------------------------------------------------------------------------------- |
| OPEN   |     18 | Backlog generik base `docs/awcms-mini/06_github_issues_detail.md` (Epic 0, 2, 6, 8, 9, 10, 11, 12).         |
| CLOSED |     20 | Ditutup `not planned` — konten domain POS/retail dipindahkan ke aplikasi turunan contoh, bukan bagian base. |

### Reconciliation (2026-07-05)

Setelah penambahan standar profesional repo publik (lisensi MIT, governance/community files, ADR `docs/adr/`, doc 20 threat model, CI kualitas dokumentasi), issue GitHub diselaraskan dengan kondisi terbaru. **Tidak ada perubahan pada jumlah/label/milestone** (tetap 18 open, 20 closed, 98 label, 24 milestone — snapshot penuh terakhir 2026-07-04T14:15:43Z tetap akurat untuk metadata). Perubahan hanya pada **body issue**:

- **#405** (10.3 — Production Security Readiness): Reference Docs ditambah doc 20 (threat model) + ADR 0003–0005; readiness wajib memverifikasi kontrol pada threat model dan konsisten dengan ADR.
- **#379** (2.4 — RBAC and ABAC): Reference Docs ditambah doc 20 + `docs/adr/0004-rbac-abac-default-deny.md`.

Backlog `docs/awcms-mini/06_github_issues_detail.md` §Dokumen acuan per epic juga diselaraskan untuk merujuk ADR + doc 20 per epic.

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

- `docs/awcms-mini/06_github_issues_detail.md` adalah rencana/template issue atomic generik sekaligus sumber isi 18 issue yang aktif di GitHub.
- `docs/awcms-mini/github/` adalah snapshot state GitHub aktual.
- `docs/awcms-mini/github/security.md` mencatat setup GitHub Security dan alert count saat refresh.
- `docs/awcms-mini/09_roadmap_repository_commit.md` mengatur urutan branch, commit, PR, release, dan changeset.
- `AGENTS.md` tetap menjadi kontrak kerja agent dan developer.
- Metadata GitHub tidak menjadi otoritas arsitektur; arsitektur target tetap Bun + Astro 7 + PostgreSQL sesuai dokumen utama.

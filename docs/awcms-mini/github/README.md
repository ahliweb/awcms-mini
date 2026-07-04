# Dokumentasi GitHub AWCMS-Mini

Dokumen ini mencatat snapshot live repository GitHub `ahliweb/awcms-mini`. Folder ini adalah **snapshot state GitHub**, bukan backlog rencana; backlog rencana tetap berada di `docs/awcms-mini/06_github_issues_detail.md`. Metadata label/milestone di folder ini adalah salinan faktual dari GitHub saat refresh; bila ada deskripsi lama yang berbeda dari arsitektur Bun + Astro 7 + PostgreSQL, ikuti `README.md`, `AGENTS.md`, dan dokumen utama `docs/awcms-mini/`.

| Metadata     | Nilai                                |
| ------------ | ------------------------------------ |
| Repository   | `ahliweb/awcms-mini`                 |
| Snapshot     | 2026-07-04T13:58:45Z                 |
| Total issue  | 38                                   |
| Open issue   | 38                                   |
| Closed issue | 0                                    |
| Labels       | 105 (32 doc 06 + 73 peninggalan)     |
| Milestones   | 28 (9 doc 06 M0-M8 + 19 peninggalan) |

## File snapshot

| State           | File                                         |                                         Jumlah issue |
| --------------- | -------------------------------------------- | ---------------------------------------------------: |
| OPEN            | [issues-open-001.md](issues-open-001.md)     |                                                   38 |
| CLOSED          | [issues-closed-001.md](issues-closed-001.md) |                                                    0 |
| LABEL/MILESTONE | [labels-milestones.md](labels-milestones.md) |                            105 labels, 28 milestones |
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

| State  | Jumlah | Catatan                                                                                                                                                       |
| ------ | -----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OPEN   |     38 | Backlog `docs/awcms-mini/06_github_issues_detail.md` (Issue 0.1-12.2) diaktifkan penuh sebagai issue GitHub nyata, lengkap dengan label dan milestone doc 06. |
| CLOSED |      0 | Belum ada issue yang selesai dikerjakan.                                                                                                                      |

### Aktivasi backlog (2026-07-04)

Backlog rencana di doc 06 diaktifkan menjadi 38 issue GitHub nyata (`#371`-`#408`):

- **Label baru**: 29 label ditambahkan sesuai taksonomi doc 06 (`type:*`, `priority:p0/p1/p2`, `area:*`, `status:*`); 3 label (`type:task`, `area:auth`, `area:security`) sudah cocok persis dengan label lama sehingga dipakai ulang tanpa duplikasi.
- **Milestone baru**: 9 milestone `M0 — Repository Foundation` s/d `M8 — Security, Performance, Production` dibuat mengikuti tabel "Milestone rekomendasi" doc 06.
- **Status awal**: hanya Sprint 1 (Issue 0.1, 0.2, 0.3, 12.1) diberi `status:ready`; 34 issue lain diberi `status:blocked` karena dependency milestone-nya belum selesai (sesuai instruksi doc 06 §Status: backlog aktif di GitHub).
- **Label/milestone peninggalan** (SIKESRA/governance-overlay era — 73 label, 19 milestone) **tidak diubah/dihapus**; dipisahkan di `labels-milestones.md` agar tidak tercampur dengan taksonomi base saat ini.

## Hubungan dengan dokumen utama

- `docs/awcms-mini/06_github_issues_detail.md` adalah rencana/template issue atomic sekaligus sumber isi 38 issue yang sudah aktif di GitHub.
- `docs/awcms-mini/github/` adalah snapshot state GitHub aktual.
- `docs/awcms-mini/github/security.md` mencatat setup GitHub Security dan alert count saat refresh.
- `docs/awcms-mini/09_roadmap_repository_commit.md` mengatur urutan branch, commit, PR, release, dan changeset.
- `AGENTS.md` tetap menjadi kontrak kerja agent dan developer.
- Metadata GitHub tidak menjadi otoritas arsitektur; arsitektur target tetap Bun + Astro 7 + PostgreSQL sesuai dokumen utama.

# Dokumentasi GitHub AWCMS-Mini

Dokumen ini mencatat snapshot live repository GitHub `ahliweb/awcms-mini`. Folder ini adalah **snapshot state GitHub**, bukan backlog rencana; backlog rencana tetap berada di `docs/awcms-mini/06_github_issues_detail.md`. Metadata label/milestone di folder ini adalah salinan faktual dari GitHub saat refresh; bila ada deskripsi lama yang berbeda dari arsitektur Bun + Astro 7 + PostgreSQL, ikuti `README.md`, `AGENTS.md`, dan dokumen utama `docs/awcms-mini/`.

| Metadata | Nilai |
|---|---|
| Repository | `ahliweb/awcms-mini` |
| Snapshot | 2026-07-04T11:16:36Z |
| Total issue | 0 |
| Open issue | 0 |
| Closed issue | 0 |
| Labels | 76 |
| Milestones | 19 |
| Max issue per file | 100 |

## File snapshot

| State | File | Jumlah issue |
|---|---|---:|
| OPEN | [issues-open-001.md](issues-open-001.md) | 0 |
| CLOSED | [issues-closed-001.md](issues-closed-001.md) | 0 |
| LABEL/MILESTONE | [labels-milestones.md](labels-milestones.md) | 76 labels, 19 milestones |
| SECURITY | [security.md](security.md) | Security policy, Dependabot, secret scanning, CodeQL |

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

| State | Jumlah | Catatan |
|---|---:|---|
| OPEN | 0 | Tidak ada issue terbuka di GitHub saat snapshot ini dibuat. |
| CLOSED | 0 | Tidak ada issue historis yang tersisa di GitHub issue list saat snapshot ini dibuat. |

## Hubungan dengan dokumen utama

- `docs/awcms-mini/06_github_issues_detail.md` adalah rencana/template issue atomic.
- `docs/awcms-mini/github/` adalah snapshot state GitHub aktual.
- `docs/awcms-mini/github/security.md` mencatat setup GitHub Security dan alert count saat refresh.
- `docs/awcms-mini/09_roadmap_repository_commit.md` mengatur urutan branch, commit, PR, release, dan changeset.
- `AGENTS.md` tetap menjadi kontrak kerja agent dan developer.
- Metadata GitHub tidak menjadi otoritas arsitektur; arsitektur target tetap Bun + Astro 7 + PostgreSQL sesuai dokumen utama.

---
"awcms-mini": patch
---

docs(epic-818): rekonsiliasi doc 01/02/13/21 dengan 23 modul nyata + gate anti-drift (Issue #828)

Dokumen perencanaan tertinggal jauh dari registry. Doc 01 §"Modul utama
(base)" memuat 11 baris untuk registry 23 modul dan menegaskan _"modul
domain ... bukan bagian base ini"_ padahal `src/modules/index.ts`
mendaftarkan `blog_content`/`news_portal`/`social_publishing` sebagai base;
doc 13 memuat tabel traceability yang menunjuk tabel/endpoint/ID issue yang
tak pernah ada; doc 21 §8 berjudul "Peta 23 modul" tapi memuat 22 baris.

Yang diperbaiki:

- **Doc 01**: tabel modul ditulis ulang ke 23 modul nyata (kolom `key` +
  kategori doc 21), klaim "modul domain bukan bagian base" **dicabut**, dan
  4 kapabilitas base non-modul (Localization UI, UI Experience, Database
  Connectivity, Production Security) dinyatakan eksplisit — mereka hidup di
  `src/lib/`+`i18n/`+`scripts/`, tak terlihat oleh `modules:dag:check`.
- **Doc 13**: dua tabel traceability utama ditulis ulang terhadap tabel/
  endpoint/issue yang **diverifikasi ke sumbernya**; matrix migration
  diperluas `055` → `077` (+7 modul yang hilang); versi hardcoded dihapus
  (sumber kebenaran `package.json`/`CHANGELOG.md`).
- **Doc 13**: keputusan eksplisit — production security readiness
  **script-only & ephemeral**; janji `awcms_mini_security_*` +
  `/security/go-live-gates/evaluate` (nol hit di `sql/`+`src/`) dicabut,
  bukan diimplementasikan.
- **Doc 02**: ditambah PRD Management Reporting (modul base nyata,
  `key: reporting`) dan Localization UI (ditandai kapabilitas non-modul).
- **Doc 21 §8** + **AUDIT_STANDAR_PENGEMBANGAN_2026-07-17.md**: baris
  `idn_admin_regions` yang hilang ditambahkan; klaim audit "24 modul (22
  `active`, 2 `experimental`)" dikoreksi ke **23 modul (22 `active`, 1
  `experimental`)** — 24 adalah jumlah **direktori** `src/modules/*/` yang
  ikut menghitung `_shared` (bukan modul terdaftar).

Perubahan berperilaku: **gate CI baru**
`tests/unit/module-doc-reconciliation.test.ts` mem-parse baris tabel doc
01/13/21 dan menegakkannya terhadap `listBaseModules()` + isi `sql/` —
dua arah (baris hilang **dan** modul/migration fiktif), termasuk setiap
migration wajib terpetakan tepat satu kali. Sengaja mem-parse **baris
tabel**, bukan `source.includes(key)`, sehingga prosa yang menyebut sebuah
modul tidak bisa memuaskan gate. Ini drift ke-6 kelas yang sama;
perbaikan doc tanpa pagar akan kambuh ke-7.

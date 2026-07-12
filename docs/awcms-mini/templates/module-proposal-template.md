# Module proposal template

Lightweight — bukan RFC panjang. Isi di body issue GitHub sebelum sebuah
modul **System** atau **Official Optional Module** baru mulai di-scaffold
di repo base ini. Baca dulu
`docs/awcms-mini/21_module_admission_governance.md` (kategori, pohon
keputusan §3, kriteria admission §4) sebelum mengisi.

Untuk kebutuhan spesifik satu domain bisnis (POS, gudang, pajak, CRM,
dll.) — **jangan** isi template ini, buat issue di repo aplikasi turunan
yang relevan (lihat `docs/awcms-mini/derived-application-guide.md`).

---

## 1. Nama & key modul yang diusulkan

- Nama:
- `key` (`snake_case`):
- Kategori yang diusulkan (**System** / **Official Optional Module** —
  lihat doc 21 §2 untuk definisi; bila ragu, isi "Tidak yakin" dan
  jelaskan di §2 di bawah):

## 2. Masalah / kebutuhan

Apa yang tidak bisa dilakukan hari ini tanpa modul ini? Untuk siapa
(semua aplikasi turunan, atau sebagian besar)?

## 3. Mengapa ini bukan modul Derived Application

Buktikan modul ini generik lintas domain bisnis (doc 21 §3 node Q3),
bukan spesifik satu vertikal.

## 4. Dependency

- Lifecycle dependency (`ModuleDescriptor.dependencies`, wajib berupa
  modul yang HARUS aktif duluan):
- Capability dependency (`ModuleDescriptor.capabilities.consumes`, tandai
  `required` atau `optional` per entri — lihat doc 21 §5):

## 5. Kompatibilitas offline/LAN vs full-online-only

- Kelas kompatibilitas yang diusulkan (`offline-lan-safe` /
  `full-online-only` — doc 21 §6):
- Bila `full-online-only`: bagaimana profil `offline-lan` tetap 100%
  fungsional saat fitur ini off?

## 6. Provider eksternal (bila ada)

Bila modul ini membungkus provider eksternal (kategori External
Integration di dalamnya), lihat dan lampirkan hasil
`docs/awcms-mini/templates/module-admission-decision-checklist.md`
§Provider eksternal.

## 7. Security & data governance

Ringkas: data apa yang disentuh (termasuk PII), siapa yang boleh akses
(ABAC awal), dan aksi high-risk apa yang perlu audit log.

## 8. Ownership

Siapa yang akan memelihara modul ini pasca-merge (mengisi
`ModuleDescriptor.maintainers` bila tim sudah lebih dari satu maintainer;
default `.github/CODEOWNERS` bila belum)?

## 9. Rencana deprecation (bila relevan)

Apakah modul ini menggantikan modul/fitur lain yang ada? Bila ya, lihat
doc 21 §4.4/§8 untuk pola deprecation notice.

## 10. Alternatif yang dipertimbangkan

Kenapa tidak dilakukan sebagai bagian dari modul yang sudah ada?

---

Setelah issue ini didiskusikan dan disetujui maintainer, lanjutkan ke
`docs/awcms-mini/templates/module-admission-decision-checklist.md` sebagai
checklist review PR, dan tulis ADR terpisah bila keputusannya mengikat
lintas dokumen (GOVERNANCE.md §Perubahan standar).

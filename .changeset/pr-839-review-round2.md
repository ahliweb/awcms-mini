---
"awcms-mini": patch
---

Perbaiki tiga temuan review PR #839.

**`prepareModuleHealthContext` menjalankan 4 query lewat `Promise.all` di atas
satu `tx`.** Satu koneksi Postgres melayani satu query pada satu waktu, dan pola
persis ini pernah menyebabkan hang nyata di repo ini (lihat catatan di
`reporting/application/projection-reconciliation.ts` — koneksi yang tersangkut
lalu merusak `resetDatabase()` setiap test sesudahnya). Regresi dari perbaikan
Issue #824; kemenangannya memang bukan konkurensi melainkan meruntuhkan fan-out
per-modul menjadi empat query total, dan itu tetap utuh dengan await berurutan.

**`readJsonBody(...) ?? {}` mengubah body yang absen/rusak/bukan-objek menjadi
patch kosong yang sah** pada kedua route PATCH reference-data, sehingga body
sampah lolos otorisasi + idempotency dan mendarat sebagai write sungguhan.
Ditambahkan `readJsonObjectBody` + `invalidJsonObjectBodyResponse` di
`lib/security/request-body-limit.ts`: `{}` tetap `ok` (objek kosong itu body
sungguhan), sedangkan absen/malformed/`null`/array/skalar ditolak `400`.

**`PATCH {}` — no-op yang terdokumentasi — tetap menjalankan `update*` tanpa
syarat**, membuat `updated_at` naik, menulis ulang baris translation, memancarkan
audit event dan domain event untuk request yang tidak mengubah apa pun. Kini
di-short-circuit dan mengembalikan representasi saat ini. Refusal
`managed_by_descriptor` (Issue #750) tetap diperiksa di jalur no-op agar jawaban
endpoint tidak bergantung pada berapa field yang kebetulan dikirim pemanggil.

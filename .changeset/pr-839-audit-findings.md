---
"awcms-mini": patch
---

Perbaiki tiga temuan security-auditor pada PR #839 (epic #818).

**Gate `requiredPermission` deskriptor kini ditegakkan di halaman admin
(HIGH).** `src/pages/admin/data-exchange/imports/[id].astro` tidak melewati
route API mana pun — ia melakukan query dan proyeksi staged row sendiri — dan
mereplikasi gate raw-value dengan benar tapi **tidak pernah** memutuskan
`ExchangeDescriptor.requiredPermission`, izin milik modul pemilik yang
ditegakkan keenam route API. Deskriptor dengan `requiredPermission:
"hr.payroll.read"` karenanya ditegakkan di seluruh permukaan API dan nol di
UI: pemegang `data_exchange.imports.read` generik bisa membaca konten staged
modul lain (natural key, validation error, laporan rekonsiliasi) langsung dari
halaman. Halaman kini memanggil `isDescriptorPermissionGranted` — keputusan
yang sama dengan route, dibagi dari satu tempat — dan deskriptor yang tidak
lagi resolve (modul pemilik dinonaktifkan setelah staging) kini **deny**, bukan
sekadar `maskAllFields`.

**`AUTH_JWT_SECRET` tidak lagi deprecated, dan tidak lagi merosot senyap
(HIGH).** Sejak Issue #821 variabel ini adalah kunci HMAC nyata untuk pseudonim
IP (`ipHash`) di audit log, tapi registry menandainya `deprecated` dengan
`removalVersion: "1.0.0"` ("terverifikasi mati / nol konsumen") sementara
`client-fingerprint.ts` mem-fallback ke `?? ""`. Saat variabel itu benar-benar
dihapus sesuai jadwal, `hashClientIp` akan merosot jadi SHA-256 tanpa garam —
ruang IPv4 hanya 2^32, jadi **setiap `ipHash` di audit trail menjadi
reversibel**, tanpa satu pun error. Dipilih **Opsi A** (mencabut deprecation)
di atas Opsi B (var baru `AUTH_IP_HASH_KEY`): key separation di sini tidak
membeli apa pun karena `AUTH_JWT_SECRET` terverifikasi tidak menandatangani
apa pun (sesi = token opaque; `jwt-verify.ts` RS256 lewat JWKS penyedia), jadi
tidak ada risiko cross-protocol — sementara var wajib baru memaksa perubahan
pada setiap deployment yang sudah berjalan tanpa keuntungan keamanan. Fallback
`?? ""` dihapus (lempar, jangan merosot senyap), dan `validate-env` kini
menolak placeholder `.env.example` lewat `checkAuthJwtSecretNotDefault`
(memakai ulang pola `checkSyncHmacSecretNotDefault`; `checkRequiredVars` hanya
mengecek non-kosong, dan placeholder itu non-kosong).

**Teks bebas tidak lagi meloloskan nilai yang di-mask (MEDIUM).**
`maskSensitiveFields` mempertahankan `validationWarnings` utuh, padahal
`maskAllFields` membuangnya dengan alasan eksplisit "warning adalah teks bebas
yang mungkin diinterpolasi adapter dengan nilai mentah" — alasan yang berlaku
identik di kedua jalur. Sebuah warning `"email x@y.com sudah terdaftar"`
mengembalikan nilai yang baru saja di-mask dari `fields.email`. `commitError`
(= `outcome.reason` adapter) dipertahankan utuh di **kedua** jalur termasuk
default-deny. Keduanya kini dibuang/di-mask di kedua jalur; `commitStatus`
tetap, jadi baris masih melaporkan BAHWA ia gagal, hanya bukan dengan nilai
apa.

Selain itu: komentar `login.ts` yang mengklaim respons login "byte-identical
regardless of whether the identity exists" diperbaiki — klaim itu salah
(`locked` dan `password_login_disabled` dapat dibedakan dan hanya tercapai bila
identity ada). Oracle enumerasinya sendiri pre-existing dan dilacak di Issue
#840; perilakunya sengaja tidak diubah di sini.

---
"awcms-mini": patch
---

Sertakan state module-enabled dalam keputusan gate SSR data-exchange (temuan
review bot pada PR #839).

Gate SSR yang ditambahkan PR #839 hanya melakukan `permissions.has(key)`.
Jalur API tidak begitu: `authorizeInTransaction` memanggil `resolveModuleEnabled`
dan menolak `403 MODULE_DISABLED` **sebelum** RBAC dievaluasi, sementara
`fetchGrantedPermissionKeys` — yang membangun permission set SSR — **tidak**
memfilter modul yang disabled. Subject karenanya tetap memegang setiap
permission key milik modul yang sudah dimatikan tenant, jadi
`/admin/data-exchange/imports/[id]` **tetap merender staged row** sementara
route preview/commit menjawab 403. SSR lebih longgar daripada API: kelas
paritas yang sama dengan temuan `requiredPermission` asli, kambuh di sumbu
berbeda.

Cek module-enabled kini berada **di dalam** `isDescriptorPermissionGranted`
(bukan di call site) sehingga tak ada pemanggil yang bisa melupakannya, dengan
urutan yang sama seperti route: modul dulu, baru RBAC. Berlaku untuk
`requiredPermission` **dan** `rawValuePermission` — jalur raw-value route
adalah `authorizeDescriptorPermissionKey`, yang juga meresolusi state modul,
jadi `permissions.has()` telanjang di halaman akan membuka nilai yang di-mask
route begitu modul pendeklarasinya disabled. Halaman juga kini memeriksa
`data_exchange` sendiri: konstanta `CAN_*`-nya semua tetap true untuk tenant
yang mematikan modul itu.

Test paritas SSR-vs-route diperluas ke sumbu ini — **terbukti merah** tanpa
perbaikan (route menolak 403, SSR mengizinkan), hijau dengan. Test paritas
sebelumnya lolos padahal celahnya ada karena ia hanya membandingkan satu sumbu
(apakah caller memegang key), bukan setiap sumbu yang benar-benar dikonsultasi
guard route.

Celah yang sama ada di **54 halaman admin lain** (survei menyeluruh: 1 dari 55
halaman pemuat data yang memeriksa module-enabled; middleware dan AdminLayout
tidak memitigasi — filter nav layout hanya kosmetik dan bisa dilewati dengan
mengetik URL). Di luar scope PR ini, dilacak di Issue #841 beserta opsi
struktural, karena menambal 54 halaman satu per satu akan hanyut lagi.

---
"awcms-mini": patch
---

Tutup celah keamanan #841 (halaman admin SSR merender data modul yang di-disable)
dan batch sejumlah N+1 lintas modul #835 (epic #818).

**#841 — gate module-enabled untuk seluruh 54 halaman admin SSR, di satu tempat.**
Jalur API sudah menolak `403 MODULE_DISABLED` (`resolveModuleEnabled` di
`authorizeInTransaction`) SEBELUM RBAC, tetapi ke-54 halaman admin yang memuat
data hanya menggerbang lewat `context.permissions.has(permissionKey(...))`, dan
`context.permissions` tidak pernah membuang key milik modul yang disabled. Akibat:
men-disable modul membuat route-nya 403 tapi halaman admin-nya tetap merender
baris data tenant. Perbaikan ditaruh **di dalam helper bersama** — `resolveSsrContext`
(`src/lib/auth/ssr-session.ts`) kini membuang setiap permission key yang modulnya
`awcms_mini_tenant_modules.enabled = false`, jadi ke-54 halaman ikut tergerbang
tanpa menyentuh satu pun call site. `fetchGrantedPermissionKeys` yang dipakai jalur
API **tidak** diubah (beberapa endpoint sengaja mengandalkannya untuk TIDAK
memfilter modul disabled). Role tidak ikut difilter (identitas subject tetap;
hanya kapabilitas modul yang disabled yang hilang dari SSR).

**#835 §7 — `resolveSsrContext` 5 query serial → 2.** Lookup sesi tetap satu query
(menghasilkan `identity_id`), lalu SATU query gabungan menyelesaikan tenant-user +
`default_locale` + roles + permission (sudah tergerbang modul). `LEFT JOIN`
mempertahankan role tanpa permission dan tenant tanpa baris `tenants`, persis
perilaku query terpisah sebelumnya. Query `roles` TIDAK digabung ke query
permission (menggabungnya akan menghilangkan role tanpa permission).

**#835 §1 — `resolveMediaReferences` batch nyata.** Signature sudah batch-shaped
tapi implementasinya query per-id; kini satu `id = ANY(...)` untuk seluruh batch
(`fetchNewsMediaObjectsByIds`), tanpa mengubah satu pun caller.

**#835 §2 — `contribution-sync` bulk read + diff translasi.** Kode yang sudah ada
dibaca sekali (`code = ANY(...)`) alih-alih satu SELECT per code, dan translasi
di-rekonsiliasi lewat DIFF (tulis hanya perubahan nyata; hapus locale yang tak
lagi dideklarasikan) menggantikan delete-all-lalu-reinsert yang menulis ulang
setiap baris tiap sync. Keputusan konflik per-code (baris manual tidak pernah
ditimpa, dilaporkan sebagai conflict) dipertahankan utuh.

**#835 §6 — job `scheduled-publish` tidak lagi mengunci semua baris.** Query
pemilihan due-post kini `ORDER BY scheduled_at ASC LIMIT n FOR UPDATE SKIP LOCKED`
(bukan `FOR UPDATE` tanpa LIMIT atas semua baris yang match), sehingga runner
paralel mengambil batch disjoint alih-alih memblokir, dan backlog besar dibatasi
per run (`result.partial`, sisa diproses run berikutnya — job periodik & idempoten).

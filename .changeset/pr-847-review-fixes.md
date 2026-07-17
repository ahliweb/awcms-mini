---
"awcms-mini": patch
---

Perbaiki tiga temuan review PR #847.

**Invalidasi cache dikalahkan load yang sedang in-flight.** `invalidate()` hanya
bisa menghapus yang sudah tersimpan, sementara loader yang mulai SEBELUM commit
masih memegang snapshot pra-commit dan menyeatnya kembali sesudahnya dengan TTL
penuh — eviction-nya dibatalkan oleh pembacaan yang sudah terlanjur di udara.
Kedua reviewer menemukannya dari arah berlawanan: domain yang dicabut tetap
dilayani 60s, dan domain yang baru diverifikasi tetap 404 selama 60s dari entri
NEGATIF — persis kasus yang `tenant/domains/[id]/verify.ts` dokumentasikan
sebagai alasan ia melakukan invalidasi. Ditambahkan generation counter per key +
`inFlight.delete()` saat invalidate.

**Perubahan Settings tidak menginvalidasi cache publik.** Nilai yang di-cache
memuat `tenant_status, tenant_code, tenant_name, default_locale` dari
`awcms_mini_tenants` — tabel yang dimutasi modul `tenant_admin` dan tak pernah
disentuh modul `tenant_domain`. Cache-nya murni fungsi host pada KUNCI-nya, bukan
pada NILAI-nya. Ganti nama tenant → halaman publik & RSS menyajikan nilai lama
hingga TTL, padahal sebelum cache ada mereka benar di request berikutnya.

**Gate wiring #826 tidak memeriksa sisi PUBLISH.** `appendDomainEvent` membuat
delivery row dari registry saat publish, jadi publisher tanpa import registrasi
menghasilkan nol row — kehilangan permanen, tak seperti dispatch root yang
terlewat (row `pending` masih bisa dipulihkan). Ditambahkan `PUBLISH_ROOTS`
terpisah, karena aturan "tiap root impor SETIAP registrasi" benar untuk root
peresolusi handler tapi akan membuat ulang edge lintas modul yang #826 hapus.
Kedua gate kini mencocokkan **statement import**, bukan sembarang kemunculan
path — versi pertamanya lolos padahal import-nya dihapus karena ada komentar
menyebut path yang sama.

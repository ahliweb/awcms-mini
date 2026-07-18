---
"awcms-mini": patch
---

Inversi `resolveNewsMediaR2Config` lewat `NewsMediaPort` sehingga `news_portal`
kembali benar-benar opsional bagi `social_publishing` (Issue #859, epic #818).

Adapter LinkedIn `social_publishing` dulu mengimpor
`news-portal/domain/news-media-r2-config.ts`'s `resolveNewsMediaR2Config`
secara statis (untuk R2 public base URL pada cek kepercayaan gambar
`isTrustedR2MediaUrl`). Import lintas-modul itu adalah SATU-SATUNYA penyebab
`social_publishing` harus mendeklarasikan `news_portal` sebagai dependency HARD
di `module.ts` — bertentangan langsung dengan `capabilities.consumes` modul ini
sendiri (`news_media`, `optional: true`) dan membuat tenant tidak bisa disable
`news_portal` selama `social_publishing` aktif.

Sekarang kapabilitas resolusi config itu di-rutekan lewat method baru
`NewsMediaPort.resolveMediaPublicBaseUrl(env)` — pola inversi ADR-0011 yang
sama dengan `NewsMediaPort.resolveMediaReferences` yang sudah ada. Composition
root publish nyata (`scripts/social-publish-dispatch.ts`) menyuntikkan
implementasi konkret `newsMediaPortAdapter` dari `news_portal`; proses SSR
verify (yang tak pernah `publish`) sengaja tidak menyuntikkannya. Bila port tak
di-inject atau `NEWS_MEDIA_R2_PUBLIC_BASE_URL` kosong, `publicBaseUrl` menjadi
string kosong → semua gambar dianggap tak terpercaya → degradasi aman ke
link-share (perilaku fallback yang sama seperti sebelumnya).

Dampak: edge `social_publishing -> news_portal` dihapus dari `dependencies`.
`news_portal` kembali optional/disableable per tenant selama `social_publishing`
aktif (post gambar terdegradasi ke link-share bila `news_portal` mati).
`social_publishing -> blog_content` TETAP dependency HARD (tidak diubah).
`isTrustedR2MediaUrl` kini fungsi murni `(url, publicBaseUrl)` (signature
berubah, hanya dipakai internal + unit test). Gate declared-dependency #826/#845
tetap hijau karena tak ada lagi import lintas-modul `social_publishing ->
news_portal` yang tak dideklarasikan.

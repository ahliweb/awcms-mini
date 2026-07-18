---
"awcms-mini": patch
---

Samakan pengecekan trust media URL LinkedIn (`isTrustedR2MediaUrl`) dengan pola
Meta (`isAcceptableProviderMediaUrl`) — defense-in-depth hardening (Issue #862,
epic #818). Sebelumnya adapter LinkedIn memakai prefix check string
`url.startsWith(publicBaseUrl)` yang bisa di-bypass (trailing-dot FQDN,
`@`-userinfo `media.example.com@evil.com`, dan prefix-collision
`media.example.com.evil.com`) dan tidak menolak downgrade `http:`.

Kedua jalur provider kini memakai SATU helper bersama
`isMediaUrlFromTrustedBase` (`src/modules/social-publishing/domain/provider-media-trust.ts`)
yang parse `new URL()`, mewajibkan `protocol === "https:"`, lalu membandingkan
`URL.host` secara persis — kelas pengecekan lemah yang pelajaran trailing-dot
FQDN Issue #635 sudah hindari untuk Meta. Helper murni tanpa I/O, di-`domain/`
sehingga bisa di-import oleh jalur Meta (`domain/`) dan adapter LinkedIn
(`infrastructure/`) tanpa memicu import cycle.

Ini murni hardening last-mile: `content.imageUrl` sudah selalu dibangun
server-side dari objek media R2 terverifikasi, jadi tidak ada jalur input yang
saat ini terjangkau — tidak mengubah perilaku publish yang sah.

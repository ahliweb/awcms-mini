---
"awcms-mini": patch
---

Turunkan (derive) domain-event **publish root** dari registry, bukan menamainya
tangan (Issue #848, epic #818). Perubahan hanya di gate test dan dokumentasi —
tak ada perubahan perilaku runtime.

**Masalah.** #826 membalik registrasi consumer (modul mendaftarkan consumer-nya
sendiri; runtime tak mengimpor kode consumer) — memutus cycle tapi menukar
jaminan compile-time dengan runtime yang gagalnya **senyap**. `appendDomainEvent`
membuat delivery row **dari registry saat publish**, jadi publisher yang belum
mengimpor registrasi consumer yang men-subscribe event-nya menghasilkan **NOL
row** untuk event yang benar-benar terjadi — permanen, tanpa error/dead-letter.
PR #847 menambal ini dengan daftar `PUBLISH_ROOTS` **manual**: asumsi tak teruji
bahwa consumer lintas-modul BARU yang event-nya di-publish modul lain akan lolos
diam-diam sampai ada yang ingat menambah entri.

**Perbaikan.** `tests/unit/domain-event-consumer-registration-wiring.test.ts` kini
**menurunkan** publish root dari kode: untuk tiap consumer terdaftar yang bukan
milik runtime (`BASE_DOMAIN_EVENT_CONSUMERS`), ambil `eventTypes`-nya, resolusi
tiap pemanggil `appendDomainEvent` yang mem-publish-nya (**resolusi identifier ES
import nyata**, mengikuti operand ternary — bukan grep literal), dan wajibkan tiap
publisher **se-modul** mengimpor registrasi consumer itu. `PUBLISH_ROOTS` manual
dihapus.

**Tanpa edge lintas-modul baru.** Bila publisher berada di modul LAIN dari
registrasi consumer, gate **menandainya sebagai sinyal arsitektural** (registrasi
harus pindah ke composition root proses, ditambahkan ke `COMPOSITION_ROOTS`),
bukan memaksa import lintas-batas yang akan membuat ulang cycle yang #826 hapus.
Nol kasus lintas-modul hari ini; masing-masing yang muncul kelak akan MERAH.

**Gate dibuktikan bisa MERAH.** Cocok terhadap **statement `import`** (resolve +
bandingkan path), bukan `source.includes(specifier)` — melepas import registrasi
dari `integration-hub/application/inbound-webhook-intake.ts` membuat gate gagal
**meski komentar tepat di atasnya menyebut path yang sama** (cacat "prosa
memuaskan gate" yang sama seperti yang #847 perbaiki).

**Guard derivasi.** Gate juga gagal bila (a) ada consumer non-base yang tak
ter-map ke file registrasi (mis. registrasi tanpa export definisi), atau (b) ada
operand `eventType` yang tak bisa diresolusi (blind spot) — keduanya membuat
derivasi buta terhadap publish site, jadi difail-kan lantang.

**Premis issue terkonfirmasi.** Dua consumer non-base:
`integration_hub.outbound_subscription_fanout` (event
`integration-hub.inbound-message.normalized`, di-publish hanya oleh
`inbound-webhook-intake.ts` di modul yang **sama** → satu-satunya publish root,
tanpa edge baru) dan `reporting.event_activity_projector` (event
`sample.recorded`, **tak di-publish kode produksi mana pun** → nol publish root).
Derivasi memroses kedua operand ternary di `workflow-approval` tanpa blind spot.

---
"awcms-mini": patch
---

Putuskan import cycle `domain_event_runtime ⇄ integration_hub` dan tutup akar penyebab kenapa dua gate bisa hijau di atasnya (Issue #826).

**Akar masalahnya bukan cycle-nya, tapi dua gate yang tidak bisa melihatnya:**

1. `tests/unit/module-boundary-cycles.test.ts` hanya memindai `application/` + `domain/`. Sisi keluar cycle ini ada di `infrastructure/`, jadi `aImportsB` terbaca false dan 258 pasang modul lolos hijau di atas cycle yang benar-benar hidup. Sekarang memindai `infrastructure/` + `api/` juga (plus bentuk bare side-effect import `import "…"`, yang kini load-bearing).

2. `bun run modules:dag:check` adalah cycle detector yang benar, tapi hanya bisa menemukan cycle di antara edge yang **diberikan** kepadanya — dan edge itu berasal dari deklarasi `dependencies` di `module.ts` yang tidak pernah diperiksa terhadap kode. `domain-event-runtime/module.ts` mendeklarasikan `["tenant_admin", "identity_access", "logging"]` sementara `consumer-registry.ts` nyata-nyata mengimpor `integration_hub` dan `reporting`. Cycle detector yang disuapi graf tanpa edge cycle-nya sendiri **tidak mungkin gagal**. Gate baru `tests/unit/module-declared-dependencies.test.ts` membuat deklarasi bertanggung jawab pada kode — dengan baseline beku 16 edge pre-existing yang hanya boleh mengecil, supaya bisa rilis sekarang tanpa mengubah graf lifecycle 10 modul sekaligus.

**Cycle-nya sendiri:** port di `_shared/ports/` tidak bisa memperbaikinya. Port hanya menghapus ketergantungan TIPE dari plugin ke runtime, padahal `integration_hub → domain_event_runtime` adalah value import yang sah dan permanen (`appendDomainEvent`, `event-type-registry` — modul ini memang PLUGIN dari runtime tsb). Satu-satunya arah yang bisa dihapus adalah arah runtime → plugin. Jadi registrasi consumer dibalik: modul pemilik consumer mendaftarkan dirinya lewat `registerDomainEventConsumer` dari `<modul>/infrastructure/domain-event-consumer-registration.ts`, dan runtime tidak mengimpor kode modul consumer sama sekali. Ini memperbaiki pelanggaran layering yang mendasari cycle-nya: modul `system` foundation tidak boleh bergantung pada feature module yang menancap padanya (ADR-0013 §1).

`reporting` ikut dibalik. Edge `domain_event_runtime → reporting` bukan import cycle, tapi berlawanan langsung dengan `reporting/module.ts` yang sengaja mendeklarasikan `domain_event_runtime` sebagai "genuine lifecycle-ordering dependency" — kontradiksi yang baru terlihat begitu deklarasi dipaksa cocok dengan import, dan yang membuat `modules:dag:check` gagal dengan cycle `reporting -> domain_event_runtime -> reporting` yang nyata.

**Risiko yang dibawa inversi ini, dan gate-nya:** registrasi lewat side-effect import bisa tidak lengkap di suatu proses, dan gagalnya **senyap** — `dispatch-domain-events.ts` mengiterasi consumer yang TERDAFTAR, jadi delivery milik consumer yang tidak terdaftar tidak pernah di-claim sama sekali (tidak ada error, tidak ada dead-letter, hanya `pending` selamanya). `tests/unit/domain-event-consumer-registration-wiring.test.ts` menemukan file registrasi lewat konvensi lalu memaksa setiap composition root mengimpornya.

Tanpa perubahan perilaku untuk deployment yang sudah jalan: consumer yang sama tetap terdaftar dengan nama, event type, versi, dan handler yang identik.

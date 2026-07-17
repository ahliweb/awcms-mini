---
"awcms-mini": patch
---

Perbaiki dua temuan review PR #839 ronde 4.

**`sensitiveFields.naturalKeyField` tidak dideklarasikan di schema OpenAPI.**
Descriptor default `data_exchange.reference_items` menyetelnya, sementara
`DataExchangeDescriptor.sensitiveFields` adalah `additionalProperties: false`
yang hanya memuat `fieldNames`/`rawValuePermission` — jadi
`GET /api/v1/data-exchange/descriptors` melanggar kontraknya sendiri dan client
ter-generate akan menolaknya. Ditambahkan gate
`tests/unit/data-exchange-descriptor-contract-parity.test.ts` yang memvalidasi
descriptor registry nyata terhadap schema nyata; validasi response-vs-schema
umum difilekan sebagai #844.

**Placeholder `AUTH_JWT_SECRET` diterima saat runtime.**
`checkAuthJwtSecretNotDefault` benar dan tersambung, tetapi tidak ada yang
memaksanya berjalan: `bun run dev`/`bun run start` memanggil server langsung,
tidak pernah `config:validate`. Deployment hasil salin `.env.example` boot
dengan tenang memakai nilai yang dipublikasikan di repo publik sebagai kunci
HMAC `ipHash` — membuat setiap `ipHash` tersimpan bisa dibalik (ruang IPv4 2^32),
yaitu satu-satunya properti yang jadi alasan pseudonym ini ada. Placeholder kini
ditolak di titik pakai, sehingga tidak ada jalur boot yang bisa melewatinya.
Nilainya dibaca dari `default` milik entri registry, bukan diketik ulang, agar
tidak melenceng dari `.env.example`.

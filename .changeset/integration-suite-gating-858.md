---
"awcms-mini": patch
---

Gate integration test suites on `DATABASE_URL` dan cegah regresi bare
`describe(...)`.

`tests/integration/reference-data.integration.test.ts` punya satu blok
top-level yang memakai bare `describe(...)` alih-alih helper gate
`suite = integrationEnabled ? describe : describe.skip`, sehingga sepuluh
test DB-touching berjalan tanpa syarat dan menggagalkan
`bun run check`/`bun test` saat `DATABASE_URL` kosong. CI tidak
menangkapnya karena job Quality selalu menyetel `DATABASE_URL`.

Blok tersebut diperbaiki ke `suite(...)`, dan gate unit murni baru
`tests/unit/integration-suite-gating.test.ts` (jalan justru tanpa DB)
memindai semua `tests/integration/*.integration.test.ts` serta gagal
dengan pesan actionable bila ada `describe(`/`describe.only(` top-level
(kolom-0) yang tidak ter-gate.

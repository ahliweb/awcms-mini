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
memindai semua `tests/integration/*.integration.test.ts` memakai
allow-list default-deny: setiap `describe...` top-level (kolom-0) gagal
dengan pesan actionable KECUALI dua bentuk terdokumentasi —
`describe.skip(` dan `describe.skipIf(!integrationEnabled)(` (kondisi
persis ini). Jadi `describe(`, `describe.only(`, `describe.each(`,
`describe.todo(`, serta `describe.skipIf(...)` berkondisi lain (terbalik
atau `process.env.CI`) semuanya tertangkap.

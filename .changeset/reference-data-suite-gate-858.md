---
"awcms-mini": patch
---

Gate blok `describe("reference-data PATCH no-op and body-shape handling")` di
`tests/integration/reference-data.integration.test.ts` lewat helper `suite`
(`integrationEnabled ? describe : describe.skip`) alih-alih bare `describe`
(Issue #858). Sebelumnya blok ini adalah satu-satunya di file yang berjalan
tanpa syarat, sehingga 10 test-nya gagal saat `bun run check`/`bun test`
dijalankan tanpa `DATABASE_URL` (pengembang lokal) — CI tidak terpengaruh
karena job Quality menyetel `DATABASE_URL`. Seluruh file kini konsisten skip
saat Postgres tidak tersedia; tidak ada perubahan perilaku produksi.

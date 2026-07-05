# GitHub Issues Closed 001

| Metadata           | Nilai                |
| ------------------ | -------------------- |
| Repository         | `ahliweb/awcms-mini` |
| Snapshot           | 2026-07-05T04:29:39Z |
| State              | `CLOSED`             |
| File page          | 1/1                  |
| Max issue per file | 100                  |
| Issue dalam file   | 28                   |
| Range              | #371-#407            |

> File ini adalah snapshot dari GitHub. Refresh dengan proses di `docs/awcms-mini/github/README.md` bila state issue berubah.

Seluruh issue di bawah ditutup dengan reason `not planned` pada 2026-07-04: kontennya spesifik domain POS/retail (katalog, stok, checkout, warehouse, pajak/Coretax, CRM receipt, AI business analyst) yang tidak sesuai konteks AWCMS-Mini sebagai contoh repo pengembangan umum. Konten dipindahkan ke aplikasi turunan contoh (mis. AWPOS), bukan dihapus riwayatnya.

Issue [#371](https://github.com/ahliweb/awcms-mini/issues/371), [#372](https://github.com/ahliweb/awcms-mini/issues/372), dan [#373](https://github.com/ahliweb/awcms-mini/issues/373) ditutup dengan reason `completed` pada 2026-07-05 setelah foundation skeleton Issue 0.1, migration runner Issue 0.2, dan API contract baseline Issue 0.3 merge. Issue [#376](https://github.com/ahliweb/awcms-mini/issues/376), [#377](https://github.com/ahliweb/awcms-mini/issues/377), [#378](https://github.com/ahliweb/awcms-mini/issues/378), dan [#379](https://github.com/ahliweb/awcms-mini/issues/379) ditutup dengan reason `completed` setelah tenant/office (2.1), central profile (2.2), identity login (2.3), dan RBAC/ABAC (2.4) schema merge — epic M2 tuntas. Issue [#407](https://github.com/ahliweb/awcms-mini/issues/407) ditutup dengan reason `completed` setelah setup wizard (12.1) merge.

|                                                        # | Judul                                                             | Milestone (saat dibuat)        |
| -------------------------------------------------------: | ----------------------------------------------------------------- | ------------------------------ |
| [#371](https://github.com/ahliweb/awcms-mini/issues/371) | 0.1 — Initialize AWCMS-Mini Modular Monolith Repository Structure | M0 — Repository Foundation     |
| [#372](https://github.com/ahliweb/awcms-mini/issues/372) | 0.2 — Add SQL Migration Runner                                    | M0 — Repository Foundation     |
| [#373](https://github.com/ahliweb/awcms-mini/issues/373) | 0.3 — Add OpenAPI and AsyncAPI Baseline                           | M0 — Repository Foundation     |
| [#374](https://github.com/ahliweb/awcms-mini/issues/374) | 1.1 — Add Legacy Migration Toolkit Schema                         | -                              |
| [#375](https://github.com/ahliweb/awcms-mini/issues/375) | 1.2 — Add Legacy Migration Dry-Run Service                        | -                              |
| [#376](https://github.com/ahliweb/awcms-mini/issues/376) | 2.1 — Add Tenant and Office Schema                                | M2 — Identity, Tenant, Profile |
| [#377](https://github.com/ahliweb/awcms-mini/issues/377) | 2.2 — Add Central Profile Schema                                  | M2 — Identity, Tenant, Profile |
| [#378](https://github.com/ahliweb/awcms-mini/issues/378) | 2.3 — Add Identity Login and Tenant User Membership               | M2 — Identity, Tenant, Profile |
| [#379](https://github.com/ahliweb/awcms-mini/issues/379) | 2.4 — Add RBAC and ABAC Access Control                            | M2 — Identity, Tenant, Profile |
| [#380](https://github.com/ahliweb/awcms-mini/issues/380) | 3.1 — Add Product Catalog MVP                                     | -                              |
| [#381](https://github.com/ahliweb/awcms-mini/issues/381) | 3.2 — Add Stock Balance and Stock Movement MVP                    | -                              |
| [#382](https://github.com/ahliweb/awcms-mini/issues/382) | 3.3 — Add Checkout Session and Cart                               | -                              |
| [#383](https://github.com/ahliweb/awcms-mini/issues/383) | 3.4 — Add Idempotent Atomic Transaction Posting                   | -                              |
| [#384](https://github.com/ahliweb/awcms-mini/issues/384) | 4.1 — Add Warehouse Zone and Bin Schema                           | -                              |
| [#385](https://github.com/ahliweb/awcms-mini/issues/385) | 4.2 — Add Inventory Lot, Batch, Serial, and Expired Date          | -                              |
| [#386](https://github.com/ahliweb/awcms-mini/issues/386) | 4.3 — Add Warehouse Transfer Order Workflow                       | -                              |
| [#387](https://github.com/ahliweb/awcms-mini/issues/387) | 4.4 — Add Cycle Count and Stock Adjustment Request                | -                              |
| [#388](https://github.com/ahliweb/awcms-mini/issues/388) | 5.1 — Add PDF Receipt Generator                                   | M5 — Sync Storage              |
| [#389](https://github.com/ahliweb/awcms-mini/issues/389) | 5.2 — Add StarSender WhatsApp Receipt Delivery                    | M5 — Sync Storage              |
| [#390](https://github.com/ahliweb/awcms-mini/issues/390) | 5.3 — Add Mailketing Email Receipt Delivery                       | M5 — Sync Storage              |
| [#394](https://github.com/ahliweb/awcms-mini/issues/394) | 7.1 — Add Tenant Tax Profile and Tax Business Unit                | -                              |
| [#395](https://github.com/ahliweb/awcms-mini/issues/395) | 7.2 — Add Party and Product Tax Profiles                          | -                              |
| [#396](https://github.com/ahliweb/awcms-mini/issues/396) | 7.3 — Add VAT Invoice Staging from Sales Document                 | -                              |
| [#397](https://github.com/ahliweb/awcms-mini/issues/397) | 7.4 — Add Coretax XML Batch Export                                | -                              |
| [#399](https://github.com/ahliweb/awcms-mini/issues/399) | 8.2 — Build Cashier POS Fullscreen UI                             | M7 — UI/UX & Reporting         |
| [#400](https://github.com/ahliweb/awcms-mini/issues/400) | 8.3 — Build Customer Receipt Portal                               | M7 — UI/UX & Reporting         |
| [#402](https://github.com/ahliweb/awcms-mini/issues/402) | 9.2 — Add AI Business Analyst Safe Views and Tools                | M7 — UI/UX & Reporting         |
| [#407](https://github.com/ahliweb/awcms-mini/issues/407) | 12.1 — Add Initial Setup Wizard API                               | M0 — Repository Foundation     |

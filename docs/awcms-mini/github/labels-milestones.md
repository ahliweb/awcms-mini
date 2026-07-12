# GitHub Labels dan Milestones AWCMS-Mini

| Metadata         | Nilai                    |
| ---------------- | ------------------------ |
| Repository       | `ahliweb/awcms-mini`     |
| Snapshot         | 2026-07-12T07:47:25.110Z |
| Total labels     | 99                       |
| Total milestones | 25                       |

Label diurutkan menjadi dua kelompok: **taksonomi doc 06** (dipakai backlog issue atomic base generik) dan **peninggalan proyek sebelumnya** (SIKESRA/governance-overlay, dibiarkan apa adanya, tidak dihapus/diubah).

## Label taksonomi doc 06 (25)

| Label                 | Deskripsi                                         | Warna     |
| --------------------- | ------------------------------------------------- | --------- |
| `area:api`            | Kontrak OpenAPI/REST                              | `#5319E7` |
| `area:architecture`   | Struktur repo, module contract, registry          | `#5319E7` |
| `area:auth`           | Identity, auth, and sessions                      | `#bfdadc` |
| `area:database`       | Schema, migration, pooling, RLS                   | `#5319E7` |
| `area:deployment`     | Deployment profile, systemd, backup               | `#5319E7` |
| `area:frontend`       | Astro SSR, islands, UI client                     | `#5319E7` |
| `area:logging`        | Structured logging, audit trail                   | `#5319E7` |
| `area:profile`        | Central profile, identifier masking               | `#5319E7` |
| `area:reporting`      | Management reporting views                        | `#5319E7` |
| `area:security`       | Security and 2FA work                             | `#fbca04` |
| `area:sync`           | Offline sync, outbox/inbox, R2 queue              | `#5319E7` |
| `area:tenant`         | Tenant, office, setup wizard                      | `#5319E7` |
| `area:ui-ux`          | Design system, layout, layar                      | `#5319E7` |
| `priority:p0`         | Prioritas tertinggi - blocker foundation/security | `#B60205` |
| `priority:p1`         | Prioritas tinggi - core domain                    | `#D93F0B` |
| `priority:p2`         | Prioritas sedang - opsional/provider-dependent    | `#FBCA04` |
| `status:blocked`      | Menunggu dependency milestone lain                | `#B60205` |
| `status:needs-review` | Menunggu review PR/issue                          | `#FBCA04` |
| `status:ready`        | Dependency selesai, siap dikerjakan               | `#0E8A16` |
| `type:docs`           | Perubahan dokumentasi sesuai doc 06               | `#1D76DB` |
| `type:epic`           | Epic-level tracking sesuai doc 06                 | `#1D76DB` |
| `type:feature`        | Fitur baru sesuai doc 06                          | `#1D76DB` |
| `type:security`       | Perubahan terkait keamanan sesuai doc 06          | `#1D76DB` |
| `type:task`           | Atomic implementation task                        | `#0e8a16` |
| `type:test`           | Perubahan/penambahan test sesuai doc 06           | `#1D76DB` |

## Label peninggalan proyek sebelumnya (74)

Dibuat sebelum refaktor standar base sebagai label/milestone peninggalan proyek lama. Tidak dipakai backlog doc 06; dibiarkan tanpa perubahan.

| Label                       | Deskripsi                                            | Warna     |
| --------------------------- | ---------------------------------------------------- | --------- |
| `accessibility`             | Accessibility requirements                           | `#0052cc` |
| `admin`                     | Admin UI work                                        | `#0e8a16` |
| `architecture`              |                                                      | `#ededed` |
| `area:admin`                | Admin UI work                                        | `#0e8a16` |
| `area:audit`                | Audit and observability work                         | `#7057ff` |
| `area:authorization`        | RBAC and ABAC work                                   | `#f9d0c4` |
| `area:docs`                 | Documentation and workflow process work              | `#006b75` |
| `area:foundation`           | Foundation and runtime work                          | `#c2e0c6` |
| `area:governance`           | Jobs and region governance work                      | `#d4c5f9` |
| `area:plugins`              | Plugin integration work                              | `#5319e7` |
| `audit-log`                 | Audit log UI or behavior                             | `#7057ff` |
| `authentication`            |                                                      | `#ededed` |
| `backend`                   |                                                      | `#ededed` |
| `backend-needed`            | Requires backend support                             | `#fbca04` |
| `blocked`                   | Blocked by dependency                                | `#d73a4a` |
| `bug`                       | Something isn't working                              | `#d73a4a` |
| `cleanup`                   |                                                      | `#ededed` |
| `cloudflare`                |                                                      | `#ededed` |
| `configuration`             |                                                      | `#ededed` |
| `coolify`                   | Coolify-managed infrastructure                       | `#0052cc` |
| `dashboard`                 | Dashboard UI                                         | `#c2e0c6` |
| `database`                  |                                                      | `#ededed` |
| `dependencies`              | Pull requests that update a dependency file          | `#0366d6` |
| `deployment`                | Deployment and runtime configuration                 | `#006b75` |
| `devops`                    |                                                      | `#ededed` |
| `documentation`             | Improvements or additions to documentation           | `#0075ca` |
| `documents`                 | Document upload and management                       | `#006b75` |
| `duplicate`                 | This issue or pull request already exists            | `#cfd3d7` |
| `email`                     |                                                      | `#ededed` |
| `enhancement`               | New feature or request                               | `#a2eeef` |
| `environment`               | Environment variable and runtime configuration       | `#c2e0c6` |
| `export-report`             | Reports and export                                   | `#d4c5f9` |
| `forms`                     | Form UI                                              | `#bfdadc` |
| `frontend`                  |                                                      | `#ededed` |
| `good first issue`          | Good for newcomers                                   | `#7057ff` |
| `good-first-implementation` | Good first implementation task                       | `#7057ff` |
| `governance`                |                                                      | `#ededed` |
| `help wanted`               | Extra attention is needed                            | `#008672` |
| `hono`                      |                                                      | `#ededed` |
| `import-excel`              | Excel import workflow                                | `#d4c5f9` |
| `integrations`              |                                                      | `#ededed` |
| `invalid`                   | This doesn't seem right                              | `#e4e669` |
| `javascript`                | Pull requests that update javascript code            | `#168700` |
| `mvp`                       | MVP scope                                            | `#0e8a16` |
| `notifications`             |                                                      | `#ededed` |
| `operator-action`           |                                                      | `#ededed` |
| `priority: critical`        | Critical priority                                    | `#b60205` |
| `priority: high`            | High priority                                        | `#d93f0b` |
| `priority: low`             | Low priority                                         | `#c2e0c6` |
| `priority: medium`          | Medium priority                                      | `#fbca04` |
| `priority:high`             | High-priority planned work                           | `#b60205` |
| `question`                  | Further information is requested                     | `#d876e3` |
| `r2`                        | Cloudflare R2 storage                                | `#1d76db` |
| `rbac-abac`                 | RBAC and ABAC controls                               | `#f9d0c4` |
| `region-scope`              | Administrative region scope                          | `#d4c5f9` |
| `registry`                  | Registry data UI                                     | `#1d76db` |
| `responsive`                | Responsive UI behavior                               | `#a2eeef` |
| `security`                  |                                                      | `#ededed` |
| `sensitive-data`            | Sensitive data handling                              | `#b60205` |
| `sikesra`                   | SIKESRA application planning and implementation      | `#1d76db` |
| `source:backlog`            | Created from the atomic backlog                      | `#1d76db` |
| `storage`                   |                                                      | `#ededed` |
| `testing`                   | Testing work                                         | `#5319e7` |
| `type: bug`                 | Bug fix                                              | `#d73a4a` |
| `type: docs`                | Documentation work                                   | `#0075ca` |
| `type: epic`                | Epic tracking issue                                  | `#3f51b5` |
| `type: feature`             | Feature work                                         | `#0e8a16` |
| `type: security`            | Security work                                        | `#b60205` |
| `type: task`                | Implementation task                                  | `#1d76db` |
| `type: test`                | Test work                                            | `#5319e7` |
| `uiux`                      | UI and UX work                                       | `#5319e7` |
| `verification`              | Verification workflow                                | `#fbca04` |
| `wontfix`                   | This will not be worked on                           | `#ffffff` |
| `workflow:issue-driven`     | Work must be implemented through an issue-based flow | `#5319e7` |

## Milestone taksonomi doc 06 (6)

|   # | Milestone                                    | Deskripsi                                                                                                                                                 | State  |
| --: | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
|  20 | M0 — Repository Foundation                   | Skeleton, migration runner, OpenAPI/AsyncAPI baseline (doc 06 Epic 0)                                                                                     | `open` |
|  22 | M2 — Identity, Tenant, Profile               | Tenant, profile, auth, access control dasar (doc 06 Epic 2)                                                                                               | `open` |
|  25 | M5 — Sync Storage                            | Offline sync outbox/inbox, conflict resolution, R2 object queue (doc 06 Epic 6)                                                                           | `open` |
|  27 | M7 — UI/UX & Reporting                       | Admin layout shell, management reporting views (doc 06 Epic 8-9, generic)                                                                                 | `open` |
|  28 | M8 — Security, Performance, Production       | Logging, pooling, workflow approval, security readiness, deployment (doc 06 Epic 10-12.2)                                                                 | `open` |
|  29 | M9 — Peningkatan & Hardening (pasca-backlog) | Peningkatan pasca-backlog v0.22.0: i18n, UX/a11y, performa, integrasi, security hardening, observability (bukan bagian backlog doc06 — dibuat 2026-07-06) | `open` |

## Milestone peninggalan proyek sebelumnya (19)

Dari SIKESRA/governance-overlay era. Dibiarkan tanpa perubahan.

|   # | Milestone                                                                           | State  |
| --: | ----------------------------------------------------------------------------------- | ------ |
|   1 | E0 Foundation Decisions                                                             | `open` |
|   2 | E1 Runtime and Database Bootstrap                                                   | `open` |
|   3 | E2 Identity and Session Core                                                        | `open` |
|   4 | E3 RBAC Core                                                                        | `open` |
|   5 | E4 ABAC Core                                                                        | `open` |
|   6 | E5 Jobs Hierarchy                                                                   | `open` |
|   7 | E6 Logical Regions                                                                  | `open` |
|   8 | E7 Administrative Regions                                                           | `open` |
|   9 | E8 Security Hardening                                                               | `open` |
|  10 | E9 Audit and Observability                                                          | `open` |
|  11 | E10 Admin Surfaces                                                                  | `open` |
|  12 | E11 Plugin Governance Contract                                                      | `open` |
|  13 | E12 Rollout Safety and Docs                                                         | `open` |
|  14 | SIKESRA UI/UX MVP - Sprint 1: Layout, Navigation, and Core Components               | `open` |
|  15 | SIKESRA UI/UX MVP - Sprint 2: Dashboard and Registry Data                           | `open` |
|  16 | SIKESRA UI/UX MVP - Sprint 3: Module Forms                                          | `open` |
|  17 | SIKESRA UI/UX MVP - Sprint 4: Code, Documents, and Verification                     | `open` |
|  18 | SIKESRA UI/UX MVP - Sprint 5: Import, Export, Audit, and Access Management          | `open` |
|  19 | SIKESRA UI/UX MVP - Hardening: Accessibility, Security UX, Tests, and Documentation | `open` |

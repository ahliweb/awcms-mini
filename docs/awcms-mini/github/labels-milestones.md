# GitHub Labels dan Milestones AWCMS-Mini

| Metadata | Nilai |
|---|---|
| Repository | `ahliweb/awcms-mini` |
| Snapshot | 2026-07-04T10:37:33Z |
| Total labels | 76 |
| Total milestones | 19 |

## Labels

| Label | Deskripsi | Warna |
|---|---|---|
| `bug` | Something isn't working | `#d73a4a` |
| `documentation` | Improvements or additions to documentation | `#0075ca` |
| `duplicate` | This issue or pull request already exists | `#cfd3d7` |
| `enhancement` | New feature or request | `#a2eeef` |
| `good first issue` | Good for newcomers | `#7057ff` |
| `help wanted` | Extra attention is needed | `#008672` |
| `invalid` | This doesn't seem right | `#e4e669` |
| `question` | Further information is requested | `#d876e3` |
| `wontfix` | This will not be worked on | `#ffffff` |
| `type:task` | Atomic implementation task | `#0e8a16` |
| `workflow:issue-driven` | Work must be implemented through an issue-based flow | `#5319e7` |
| `source:backlog` | Created from the atomic backlog | `#1d76db` |
| `priority:high` | High-priority planned work | `#b60205` |
| `area:auth` | Identity, auth, and sessions | `#bfdadc` |
| `area:foundation` | Foundation and runtime work | `#c2e0c6` |
| `area:authorization` | RBAC and ABAC work | `#f9d0c4` |
| `area:governance` | Jobs and region governance work | `#d4c5f9` |
| `area:security` | Security and 2FA work | `#fbca04` |
| `area:audit` | Audit and observability work | `#7057ff` |
| `area:admin` | Admin UI work | `#0e8a16` |
| `area:plugins` | Plugin integration work | `#5319e7` |
| `area:docs` | Documentation and workflow process work | `#006b75` |
| `dependencies` | Pull requests that update a dependency file | `#0366d6` |
| `javascript` | Pull requests that update javascript code | `#168700` |
| `security` |  | `#ededed` |
| `operator-action` |  | `#ededed` |
| `sikesra` | SIKESRA application planning and implementation | `#1d76db` |
| `uiux` | UI and UX work | `#5319e7` |
| `mvp` | MVP scope | `#0e8a16` |
| `admin` | Admin UI work | `#0e8a16` |
| `dashboard` | Dashboard UI | `#c2e0c6` |
| `forms` | Form UI | `#bfdadc` |
| `registry` | Registry data UI | `#1d76db` |
| `verification` | Verification workflow | `#fbca04` |
| `documents` | Document upload and management | `#006b75` |
| `import-excel` | Excel import workflow | `#d4c5f9` |
| `audit-log` | Audit log UI or behavior | `#7057ff` |
| `export-report` | Reports and export | `#d4c5f9` |
| `rbac-abac` | RBAC and ABAC controls | `#f9d0c4` |
| `region-scope` | Administrative region scope | `#d4c5f9` |
| `sensitive-data` | Sensitive data handling | `#b60205` |
| `accessibility` | Accessibility requirements | `#0052cc` |
| `responsive` | Responsive UI behavior | `#a2eeef` |
| `backend-needed` | Requires backend support | `#fbca04` |
| `testing` | Testing work | `#5319e7` |
| `blocked` | Blocked by dependency | `#d73a4a` |
| `good-first-implementation` | Good first implementation task | `#7057ff` |
| `priority: critical` | Critical priority | `#b60205` |
| `priority: high` | High priority | `#d93f0b` |
| `priority: medium` | Medium priority | `#fbca04` |
| `priority: low` | Low priority | `#c2e0c6` |
| `type: epic` | Epic tracking issue | `#3f51b5` |
| `type: feature` | Feature work | `#0e8a16` |
| `type: task` | Implementation task | `#1d76db` |
| `type: bug` | Bug fix | `#d73a4a` |
| `type: docs` | Documentation work | `#0075ca` |
| `type: security` | Security work | `#b60205` |
| `type: test` | Test work | `#5319e7` |
| `coolify` | Coolify-managed infrastructure | `#0052cc` |
| `deployment` | Deployment and runtime configuration | `#006b75` |
| `r2` | Cloudflare R2 storage | `#1d76db` |
| `environment` | Environment variable and runtime configuration | `#c2e0c6` |
| `architecture` |  | `#ededed` |
| `configuration` |  | `#ededed` |
| `backend` |  | `#ededed` |
| `hono` |  | `#ededed` |
| `database` |  | `#ededed` |
| `governance` |  | `#ededed` |
| `authentication` |  | `#ededed` |
| `storage` |  | `#ededed` |
| `integrations` |  | `#ededed` |
| `notifications` |  | `#ededed` |
| `cloudflare` |  | `#ededed` |
| `frontend` |  | `#ededed` |
| `devops` |  | `#ededed` |
| `cleanup` |  | `#ededed` |

## Milestones

Catatan: tabel ini adalah snapshot metadata GitHub saat refresh. Deskripsi milestone lama tidak mengubah arsitektur target; otoritas arsitektur tetap `README.md`, `AGENTS.md`, dan dokumen utama `docs/awcms-mini/`.

| No | Title | State | Open | Closed | Due | Description |
|---:|---|---|---:|---:|---|---|
| 1 | E0 Foundation Decisions | `open` | 0 | 0 | - | Freeze architecture and repository conventions |
| 2 | E1 Runtime and Database Bootstrap | `open` | 0 | 0 | - | Stand up Bun runtime, Astro 7 server output, and PostgreSQL bootstrap |
| 3 | E2 Identity and Session Core | `open` | 0 | 0 | - | Implement users, profiles, sessions, and auth event tracking |
| 4 | E3 RBAC Core | `open` | 0 | 0 | - | Implement roles, permissions, assignments, and matrix support |
| 5 | E4 ABAC Core | `open` | 0 | 0 | - | Add service-layer contextual authorization |
| 6 | E5 Jobs Hierarchy | `open` | 0 | 0 | - | Add organizational structure and reporting lines |
| 7 | E6 Logical Regions | `open` | 0 | 0 | - | Add 10-level operational region hierarchy |
| 8 | E7 Administrative Regions | `open` | 0 | 0 | - | Add Indonesian legal region hierarchy |
| 9 | E8 Security Hardening | `open` | 0 | 0 | - | Add TOTP, recovery, step-up, lockouts, and rate limits |
| 10 | E9 Audit and Observability | `open` | 0 | 0 | - | Add append-only audit and security event visibility |
| 11 | E10 Admin Surfaces | `open` | 0 | 0 | - | Deliver governance admin screens for the AWCMS-Mini admin surface |
| 12 | E11 Plugin Governance Contract | `open` | 0 | 0 | - | Extend governance through the AWCMS-Mini plugin contract |
| 13 | E12 Rollout Safety and Docs | `open` | 0 | 0 | - | Add flags, rollout controls, and operator docs |
| 14 | SIKESRA UI/UX MVP - Sprint 1: Layout, Navigation, and Core Components | `open` | 0 | 0 | - | SIKESRA UI/UX MVP sprint 1 planning |
| 15 | SIKESRA UI/UX MVP - Sprint 2: Dashboard and Registry Data | `open` | 0 | 0 | - | SIKESRA UI/UX MVP sprint 2 planning |
| 16 | SIKESRA UI/UX MVP - Sprint 3: Module Forms | `open` | 0 | 0 | - | SIKESRA UI/UX MVP sprint 3 planning |
| 17 | SIKESRA UI/UX MVP - Sprint 4: Code, Documents, and Verification | `open` | 0 | 0 | - | SIKESRA UI/UX MVP sprint 4 planning |
| 18 | SIKESRA UI/UX MVP - Sprint 5: Import, Export, Audit, and Access Management | `open` | 0 | 0 | - | SIKESRA UI/UX MVP sprint 5 planning |
| 19 | SIKESRA UI/UX MVP - Hardening: Accessibility, Security UX, Tests, and Documentation | `open` | 0 | 0 | - | SIKESRA UI/UX MVP hardening planning |

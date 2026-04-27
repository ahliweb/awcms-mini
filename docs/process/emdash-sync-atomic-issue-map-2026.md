# EmDash Sync Atomic Issue Map 2026

## Purpose

This document turns the EmDash sync prompt into a real-state architecture inventory and an atomic GitHub issue map for the current AWCMS Mini repository.

It is intentionally grounded in the current reviewed Mini target stack:

- EmDash-first host architecture
- single-tenant governance overlay
- PostgreSQL plus Kysely
- Hono backend API in `server/`
- Coolify-managed backend and PostgreSQL deployment
- Cloudflare Pages frontend
- Cloudflare R2 for object storage

It does not treat EmDash as a copy target. It uses EmDash as an architectural reference and records where Mini should adopt, adapt, keep, or reject those patterns.

## Sources

- `REQUIREMENTS.md`
- `AGENTS.md`
- `README.md`
- `DOCS_INDEX.md`
- `docs/architecture/constraints.md`
- `docs/architecture/overview.md`
- `docs/architecture/runtime-config.md`
- `docs/process/ai-workflow-planning-templates.md`
- `docs/process/github-issue-workflow.md`
- EmDash `README.md`
- EmDash `package.json`

## Current Mini Inventory

### Repository Shape

- Mini is a single-package repository, not an EmDash-style monorepo.
- Runtime code is split between `src/` and the new Hono API surface under `server/`.
- Governance overlays, plugins, migrations, and security services are already present.

### Current Architecture

- EmDash remains the host architecture.
- PostgreSQL remains the system of record.
- Kysely remains the migration and query layer.
- The external/mobile API baseline lives under `/api/v1/*` on Hono.
- Admin and plugin surfaces remain under EmDash paths such as `/_emdash/*`.
- Mini already has migrations for users, roles, permissions, sessions, TOTP credentials, recovery codes, file metadata, message templates, notifications, and idempotency records.

### Current Confirmed Strengths

- EmDash-first constraints are explicit.
- The Hono API scaffold exists and reuses shared Mini services.
- ABAC route enforcement exists on the Hono API.
- Auth routes now cover login, logout, refresh, bearer `me`, TOTP setup, TOTP confirm, TOTP login verify, recovery-code regeneration, and self-service 2FA disable.
- Secret-hygiene checks are part of the maintained validation surface.

### Current Confirmed Gaps

- Several GitHub sync issues are still umbrella-sized and should be split into smaller execution issues.
- OpenAPI is not yet implemented for the Hono API.
- The R2 upload-request and completion flow is not yet implemented on the Hono API.
- Notification transport providers are not yet implemented on the Hono API.
- Deployment and architecture docs are partially updated but still fragmented across older and newer target-topology documents.
- Broad security hardening remains larger than one issue and should be tracked as dependency-ordered slices.

## EmDash Reference Inventory

### Relevant EmDash Patterns

- EmDash is a pnpm workspace monorepo.
- EmDash keeps strong contributor workflow scripts such as `check`, `test`, `typecheck`, `lint`, and `format`.
- EmDash treats plugins, admin, auth, and content primitives as first-class host seams.
- EmDash keeps public CMS/admin/runtime concerns clearly separated.

### EmDash Patterns Mini Should Not Copy Directly

- Cloudflare-first Worker runtime as the only deployment model.
- D1/KV/Worker-loader assumptions.
- EmDash monorepo package layout.
- Passkey-first auth as a requirement for current Mini v1.

## Comparison Matrix

| Area                   | EmDash Pattern                                 | Current Mini Pattern                                                 | Gap                                    | Decision | Risk   | Required Change                               |
| ---------------------- | ---------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------- | -------- | ------ | --------------------------------------------- |
| Repository structure   | pnpm workspace monorepo                        | single-package repo with `src/` plus `server/`                       | shape differs by product scope         | Keep     | Low    | document why Mini stays single-package        |
| Core architecture      | Astro host with CMS/admin/plugin seams         | EmDash-first governance overlay on Astro + Hono                      | mostly aligned                         | Keep     | Low    | continue additive overlay approach            |
| Routing                | host routes plus explicit API/admin seams      | EmDash admin under `/_emdash/*`, Hono external API under `/api/v1/*` | external API docs incomplete           | Adapt    | Medium | document and extend Hono API surface safely   |
| Modules/plugins        | explicit plugin seams                          | internal plugin helpers in `src/plugins/`                            | terminology/docs can improve           | Adapt    | Low    | tighten plugin contract docs only             |
| Content/CMS primitives | EmDash-native CMS/content model                | Mini does not replace EmDash content model                           | no conflict                            | Keep     | Low    | none                                          |
| Admin/dashboard        | EmDash admin surface                           | EmDash admin extended via `awcms-users-admin`                        | alignment mostly present               | Keep     | Low    | continue inside EmDash admin only             |
| Public rendering       | Astro host pages                               | Cloudflare Pages frontend calling Hono API                           | API/doc consistency gap                | Adapt    | Medium | finish frontend/API boundary docs and tests   |
| Database access        | Kysely-backed portable SQL                     | PostgreSQL + Kysely                                                  | aligned                                | Keep     | Low    | none                                          |
| Auth                   | stronger host auth conventions                 | password + TOTP + Turnstile + bearer edge API                        | OpenAPI and some hardening remain      | Adapt    | High   | continue issue-scoped auth/security hardening |
| ABAC/RBAC              | explicit permissions and host roles            | RBAC + ABAC overlay with route guards                                | baseline landed, coverage can expand   | Adapt    | Medium | add more endpoint coverage issue-by-issue     |
| Config/env             | explicit runtime contracts                     | explicit runtime docs already exist                                  | docs drift across older topology docs  | Adapt    | Medium | consolidate docs around current target stack  |
| Build/scripts          | strong `check`/`lint`/`format` discipline      | `check`, `lint`, `format`, `typecheck`, `test:unit` exist            | mostly aligned                         | Adopt    | Low    | none beyond normal maintenance                |
| Tests                  | repo-wide typed validation baseline            | focused `pnpm check` baseline                                        | some feature seams still missing tests | Adapt    | Medium | add focused tests per feature issue           |
| Docs                   | centralized docs site and contributor guidance | repo docs are broad but fragmented                                   | sync map missing                       | Adapt    | Low    | publish and maintain atomic sync issue map    |

## Decision Summary

### Adopt

- explicit validation workflow conventions
- clear API/admin/plugin seam boundaries
- stronger issue-scoped execution discipline

### Adapt

- routing and API documentation around the Hono `/api/v1/*` surface
- plugin vocabulary and docs
- deployment and runtime docs for the Mini-specific Coolify + Pages + PostgreSQL shape
- auth and security hardening slices

### Keep

- single-package repository layout
- PostgreSQL plus Kysely foundation
- EmDash-first governance overlay model
- TOTP-based v1 two-factor baseline

### Reject

- Cloudflare-only platform assumptions from EmDash
- D1/KV/Worker-loader architectural dependencies
- monorepo/package restructuring as part of sync work
- any move away from PostgreSQL, Hono, or Coolify for current Mini scope

## Acceptance Criteria For Sync Work

- The repo keeps an EmDash-aligned core architecture without creating a second platform core.
- PostgreSQL, Hono, and Coolify remain the current target runtime assumptions where already chosen by Mini.
- Docs and issue planning do not reintroduce Hyperdrive or Supabase as active architecture.
- GitHub issues are dependency-ordered and atomic.
- Already-landed work is recognized instead of being re-opened under broad umbrella issues.

## Current Issue State Assessment

### Already Resolved Or Largely Resolved

- `#246` architecture overview and assessment update: closed
- `#247` env normalization: closed
- `#248` Hono scaffold baseline: closed
- `#257` remove Hyperdrive from active runtime path: closed

### Broad Issues That Need Atomic Follow-Ons

- `#251` auth umbrella
- `#258` security umbrella
- `#259` docs umbrella
- `#260` final verification umbrella

### Candidate For Closure Based On Current State

- `#249` database baseline: Mini already has PostgreSQL, Kysely client wiring, forward-only migrations, role/permission seeds, and the required schema families in place. The issue language is broader than the exact table names now used, but the architectural goal is satisfied.

### Candidate For Partial Completion But Not Closure

- `#250` ABAC/RBAC baseline: route-level ABAC and role/permission endpoints are present, but the original issue body still over-aggregates plugin, permission-catalog, and audit scope that should be checked or split more precisely before closure.

## Atomic Follow-On Issue Map

Use these issue slices instead of continuing with large umbrella issues.

1. Docs sync inventory and issue map
   Current issue: `#262`

2. Auth: route-level validation and error-envelope hardening for Hono auth/security routes
   Dependency: builds on `#251`

3. Security: document and enforce current trusted-proxy and request-size posture across Hono routes
   Dependency: `#258`

4. API: OpenAPI 3.1 document for the current implemented Hono routes only
   Dependency: `#253`

5. Storage: signed upload-request and complete-upload flow backed by `file_objects`
   Dependency: `#252`

6. Notifications: provider abstraction and send/status flow on top of existing notification tables
   Dependency: `#254`

7. Docs: deployment guide consolidation for Cloudflare Pages + Hono on Coolify + PostgreSQL
   Dependency: `#256`, `#259`

8. Verification: final acceptance pass after the narrower issues above close
   Dependency: `#260`

## Rollback Notes

| Change            | Rollback Step                      | Risk | Validation After Rollback |
| ----------------- | ---------------------------------- | ---- | ------------------------- |
| sync planning doc | revert the docs commit             | Low  | `pnpm lint`               |
| issue-map changes | close or edit the follow-on issues | Low  | GitHub issue audit        |

## Validation

- `pnpm lint`

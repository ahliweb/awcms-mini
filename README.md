# AWCMS Mini

AWCMS Mini adalah baseline **Bun + Astro 7 modular monolith** untuk pengembangan aplikasi AWCMS berikutnya. Repository ini sudah di-rebaseline mengikuti struktur, PRD, SRS, blueprint, coding standard, OpenAPI/AsyncAPI discipline, dan workflow dari contoh lokal `/home/data/dev_bun/awpos`.

AWPOS dipakai sebagai contoh arsitektur lengkap. Di repo ini, paket dokumen hasil adaptasi berada di:

```text
docs/awcms-mini/
```

## Status

Foundation awal sudah tersedia:

- Astro 7 server output
- `/api/v1/health`
- module registry di `src/modules/`
- standard API response helper
- domain event envelope helper
- SQL migration runner baseline
- OpenAPI baseline
- AsyncAPI baseline
- unit tests untuk module registry, response helper, dan migration loader

## Stack

- Runtime: Bun
- Web framework: Astro 7
- Database: PostgreSQL
- Architecture: modular monolith, microservice-ready
- API contract: OpenAPI
- Event contract: AsyncAPI
- Security baseline: RBAC + ABAC + RLS + audit log
- Versioning: Changesets

## Quick Start

```bash
bun install
bun run dev
bun run test
bun run api:spec:check
bun run build
```

Migration membutuhkan `DATABASE_URL`:

```bash
bun run db:migrate
```

## Core Commands

```bash
bun run dev
bun run build
bun run db:migrate
bun run api:spec:check
bun run api:contract:test
bun test
bun run db:pool:health
bun run security:readiness
bun run production:preflight
bun run changeset
```

## Repository Layout

```text
src/
  lib/                 shared db, logging, auth, files, errors, i18n foundation
  modules/             modular monolith registry and shared contracts
  pages/               Astro pages and /api/v1 routes
sql/                   ordered SQL migrations
scripts/               migration/spec/preflight helpers
openapi/               REST API contracts
asyncapi/              domain event contracts
docs/awcms-mini/       adapted PRD, SRS, ERD, blueprint, SOP, and standards
tests/                 Bun tests
```

## Authoritative Docs

Read in this order:

1. `AGENTS.md`
2. `docs/awcms-mini/README.md`
3. `docs/awcms-mini/02_prd_detail_per_modul.md`
4. `docs/awcms-mini/03_srs_detail_per_modul.md`
5. `docs/awcms-mini/10_template_kode_coding_standard.md`
6. `docs/awcms-mini/11_implementation_blueprint.md`
7. `docs/awcms-mini/13_final_master_index_traceability.md`

## Implementation Rule

Every runtime change must keep these surfaces aligned:

- SQL migration when schema changes
- OpenAPI when REST API changes
- AsyncAPI when domain events change
- tests for changed behavior
- docs for operator or contributor workflow changes

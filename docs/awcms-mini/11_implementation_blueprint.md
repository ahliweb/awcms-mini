# Bagian 11 — Implementation Blueprint per Sprint

## Prinsip blueprint

1. **Build-first:** setiap sprint menjaga repository buildable (`production:preflight` sebagai baseline).
2. **Skeleton-first:** module descriptor + README + TODO dulu, lalu domain/service/repository/route/kontrak/migration/test.
3. **No fake completion:** skeleton diberi TODO jelas dan status `experimental`.
4. **Security-first:** tenant context, ABAC, RLS, audit, masking sejak awal.

## Status Sprint 1 — Foundation ✅

Semua target sprint 1 terpasang dan tervalidasi:

| Target                                                     | Lokasi                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------ |
| Root structure standar                                     | lihat doc 09                                                       |
| `src/lib/{config,errors,logging,database,auth,files,i18n}` | terimplementasi                                                    |
| `src/modules/_shared` (9 helper)                           | terimplementasi + unit test                                        |
| Module registry + 11 skeleton modul                        | `src/modules/index.ts` (validasi dependency)                       |
| Migration runner + checksum                                | `scripts/db-migrate.ts` + `lib/database/migrations.ts`             |
| Schema 001–004 + RLS FORCE                                 | `sql/` (teruji isolasinya)                                         |
| OpenAPI/AsyncAPI baseline + spec check                     | `openapi/`, `asyncapi/`, `scripts/api-spec-check.ts`               |
| Health endpoint + pool health                              | `src/pages/api/v1/health.ts`, `.../database/pool/health.ts`        |
| Readiness + preflight                                      | `scripts/security-readiness.ts`, `scripts/production-preflight.ts` |
| Docker Compose PostgreSQL                                  | `docker-compose.yml`                                               |
| Versioning Changesets                                      | `.changeset/`                                                      |

Validasi foundation:

```bash
bun install && bun run build && bun test
bun run api:spec:check && bun run security:readiness
docker compose up -d postgres && bun run db:migrate
```

## Sprint 2 — Setup, Login, Profile

File target:

```text
src/modules/tenant-admin/{application/setup-service.ts,infrastructure/repository.ts,api/handlers.ts}
src/modules/identity-access/{application/login-service.ts,api/handlers.ts}
src/modules/profile-identity/{application/resolver.ts,infrastructure/repository.ts}
src/middleware.ts                      # auth → TenantContext → locals
src/pages/api/v1/setup/{status.ts,initialize.ts}
src/pages/api/v1/auth/{login.ts,logout.ts,me.ts}
src/pages/api/v1/profiles/{index.ts,resolve.ts}
tests/tenant-admin/ · tests/identity-access/ · tests/profile-identity/
```

Perilaku minimal: setup idempotent + locked; login lockout; resolver hash+mask idempotent. Schema sudah tersedia (002) — sprint ini tidak butuh migration baru kecuali ada gap.

## Sprint 3 — RBAC/ABAC

```text
src/modules/identity-access/domain/access.ts
src/modules/identity-access/application/access-evaluator.ts
src/modules/identity-access/application/assign-access.ts
src/pages/api/v1/access/{modules.ts,evaluate.ts,assignments.ts,decision-logs.ts}
tests/access/default-deny.test.ts
```

Evaluator: default deny → allow dari role→permission → deny policy overrides → decision log. Seed katalog permission dari registry doc 17 (migration seed atau setup wizard).

## Sprint 4 — Observability & Pooling

```text
src/modules/observability-logging/infrastructure/repository.ts
src/pages/api/v1/logs/{recent.ts,audit.ts,security.ts}
src/modules/database-connectivity/application/pool-gate.ts
```

Perilaku: audit insert dalam transaction mutation; work-class gate + `503 DATABASE_BUSY` + event saturasi.

## Sprint 5 — Workflow & Admin Shell

- Migration `005_awcms_workflow_approval_schema.sql`.
- Decision API idempotent + deny self-approval.
- `src/components/ui` + layout admin (doc 14), navigation registry dari module registry.

## Sprint 6 — Sync & Production Readiness

- Migration sync (feature flag `AWCMS_SYNC_ENABLED`) + endpoint signed HMAC.
- Migration readiness + `POST /security/go-live-gates/evaluate` (mengonsumsi hasil `security:readiness`).
- Deploy profile lengkap (`deploy/`), SOP handover (doc 08).

## Definition of Skeleton Done (tercapai)

Folder utama ✓ · module contract ✓ · response/error helper ✓ · tenant context helper ✓ · audit helper ✓ · domain event helper ✓ · idempotency helper ✓ · migration runner ✓ · OpenAPI/AsyncAPI baseline ✓ · health endpoint ✓ · build pass ✓ · docs awal ✓.

## Definition of Implementation Ready

Skeleton done ✓ · schema tenant/profile/access/observability ✓ · RLS context (`withTenant`) ✓ · redaction ✓ · transaction wrapper ✓ · idempotency wrapper ✓ · **menyusul:** auth middleware, evaluator ABAC, repository audit (Sprint 2–4).

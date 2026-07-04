# Bagian 6 — GitHub Issues Base (Atomic)

## Tujuan

Issue atomic siap pakai untuk melanjutkan base. Format tiap issue: scope, acceptance criteria, dan validasi. Kerjakan berurutan; satu PR per issue; sertakan changeset bila mengubah perilaku.

## Status foundation

Issue 0.1–0.3 (skeleton repo, migration runner, baseline OpenAPI/AsyncAPI) **selesai** pada refaktor standar ini, termasuk schema 001–004 dan validasi RLS.

## Fase 1 — Tenant, Identity, Profile

### Issue 1.1 — Setup wizard API

- Scope: `GET /api/v1/setup/status`, `POST /api/v1/setup/initialize` di modul `tenant-admin` (api/application/infrastructure), seed default doc 17.
- Acceptance: idempotent; setelah sukses status `initialized: true` dan initialize berikutnya 403; audit `tenant.created`; event `tenant.created`.
- Validasi: `bun test`, `api:spec:check` (tambah path OpenAPI), contract test.

### Issue 1.2 — Identity login + lockout

- Scope: `POST /auth/login`, `GET /auth/me`, `POST /auth/logout`; verifikasi scrypt; lockout `AUTH_LOGIN_MAX_ATTEMPTS`; JWT sesi.
- Acceptance: login gagal tidak membocorkan penyebab; lockout aktif; `identity.login.*` diterbitkan; security event pada kegagalan; `password_hash` tidak pernah keluar.

### Issue 1.3 — Auth middleware & tenant context

- Scope: middleware Astro (`src/middleware.ts`) → verifikasi Bearer → bangun `TenantContext` → inject `locals`.
- Acceptance: endpoint non-public tanpa token = 401; tenant header tidak dipercaya tanpa membership.

### Issue 1.4 — Profile resolver

- Scope: `POST /profiles/resolve` idempotent + normalisasi identifier (hash+mask), `GET/POST /profiles`.
- Acceptance: resolve identifier sama → profile sama; masked di semua response.

## Fase 2 — RBAC/ABAC

### Issue 2.1 — Katalog permission + seed role

- Scope: seed `awcms_permissions` dari registry activity (doc 17); pembuatan role default per tenant saat setup.
- Acceptance: setup menghasilkan 5 role base + mapping permission sesuai matriks doc 17.

### Issue 2.2 — Evaluator ABAC default deny

- Scope: `identity-access/application/access-evaluator.ts` — RBAC baseline + ABAC policy; deny overrides allow; decision log.
- Acceptance: test default-deny lulus (tanpa allow → deny; deny policy menang; deny high-risk tercatat).

### Issue 2.3 — Access assignment API + guard endpoint

- Scope: `POST /access/assignments` (idempotent + audit), `POST /access/evaluate`, `GET /access/modules`, `GET /access/decision-logs`; pasang `guardAccess` di semua endpoint non-public.
- Acceptance: user tanpa permission ditolak 403 dengan reason; assignment memicu `access.assignment.changed`.

## Fase 3 — Observability & Pooling

### Issue 3.1 — Repository audit/log/security event + API logs

- Scope: infrastructure `observability-logging`; helper insert dipakai modul lain; `GET /logs/*` (Auditor).
- Acceptance: audit ditulis dalam transaction mutation; attributes ter-redact; pagination keyset.

### Issue 3.2 — Pool gate work-class + backpressure

- Scope: `database-connectivity` — gate per work class, antrean+timeout, `503 DATABASE_BUSY`, event `database.pool.saturated`.
- Acceptance: saturasi tersimulasi di test; health endpoint melaporkan antrean.

## Fase 4 — Workflow & UI shell

### Issue 4.1 — Workflow approval engine

- Scope: schema migration baru (definitions/instances/tasks/decisions), decision API idempotent, deny self-approval.
- Acceptance: approve/reject menghasilkan event + audit; self-approval 403.

### Issue 4.2 — Admin shell + navigation registry

- Scope: `ui-experience` + layout dasar doc 14; navigasi dari module registry + permission.
- Acceptance: modul experimental tidak tampil untuk user tanpa akses.

## Fase 5 — Sync opsional

### Issue 5.1 — Sync HMAC push/pull

- Scope: schema sync + endpoint signed (HMAC `timestamp.body`, skew 300s); feature flag `AWCMS_SYNC_ENABLED`.
- Acceptance: signature salah/timestamp kadaluarsa ditolak; duplicate event idempotent.

## Fase 6 — Production readiness

### Issue 6.1 — Readiness schema + go-live gates API

- Scope: schema readiness + `POST /security/go-live-gates/evaluate`; integrasi hasil `scripts/security-readiness.ts`.
- Acceptance: critical finding → BLOCKED + event `security.golive.blocked`.

## Template issue

```text
Judul: <fase.nomor> — <ringkas>
Scope:
Acceptance criteria:
Validasi: bun test / api:spec:check / db:migrate / build / (contract test)
Catatan security: tenant/ABAC/RLS/audit/idempotency/masking yang relevan
```

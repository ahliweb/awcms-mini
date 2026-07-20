---
name: awcms-mini-tenant-lifecycle
description: Kerjakan bagian mana pun dari modul tenant_lifecycle AWCMS-Mini (Issue #873, epic #868 SaaS control plane Wave 1, ADR-0022) — modul control-plane KEEMPAT. Gunakan saat menambah/mengubah state machine lifecycle tenant (provisioning/trial/active/renewal_due/past_due/grace/suspended/canceled/restoring/blocked), transisi tervalidasi + concurrency-safe, restriction policy fail-closed yang ditegakkan lintas API/SSR/public/worker, transisi terjadwal idempoten, downgrade non-destruktif, atau restore ter-rekonsiliasi. Merangkum: lifecycle = axis TERPISAH dari entitlement (#871) & permission (identity_access); restriksi server-derived fail-closed via satu helper neutral-ground (`_shared/tenant-lifecycle-policy.ts` + `_shared/tenant-lifecycle-restriction-read.ts`) yang dibaca auth chokepoint TANPA import modul (no reverse-dep); suspend/cancel/downgrade ubah state+gate+entitlement TAPI TIDAK PERNAH hapus data; scheduled transition idempoten di bawah worker konkuren (row-lock + state+version-predicate); event versioned same-commit; PROVIDES tenant_restrictions + lifecycle_transition (#876 consume); CONSUMES effective_entitlement (#871) + provisioning_status (#872); LAN/offline tanpa payment provider.
---

# AWCMS-Mini — Tenant Lifecycle Module

`tenant_lifecycle` (`src/modules/tenant-lifecycle`, Issue #873, epic #868 SaaS
control plane Wave 1, **ADR-0022**) adalah **modul control-plane KEEMPAT** —
Official Optional Business Foundation, **opt-in per tenant, default-disabled**,
**tenant-scoped**. Ia mencatat **state siklus hidup SaaS** sebuah tenant,
memvalidasi transisi forward-legal dengan optimistic-version guard, menyimpan
history append-only, menjadwalkan transisi masa depan (trial/grace expiry) yang
di-apply **idempoten** oleh worker, dan **menurunkan** (bukan menyimpan sebagai
kebenaran) **restriksi akses fail-closed** yang diberlakukan lintas empat
surface. PROVIDES `tenant_restrictions` (read-only) + `lifecycle_transition`
(write, di-consume #876); CONSUMES `effective_entitlement` (#871) +
`provisioning_status` (#872).

## Axis terpisah (WAJIB dipahami)

Lifecycle **BUKAN** entitlement dan **BUKAN** permission:

- **entitlement (#871)** = FITUR/modul/quota apa yang tenant punya.
- **permission (identity_access)** = SIAPA boleh bertindak.
- **lifecycle (#873)** = APAKAH tenant boleh beroperasi & SEBERAPA (admin/
  public/write/job/provider), diturunkan dari state. Positive lifecycle tak
  pernah memberi permission yang aktor tak punya.

## Batas keamanan yang WAJIB dijaga (ADR-0022)

- **Tenant-scoped RLS FORCE, predikat SELALU-HANYA `tenant_id`** (no soft
  super-tenant; no `OR is_platform`). Operator kelola tenant target lewat
  konteks per-tenant (`SET LOCAL app.current_tenant_id`), tiap command audited.
- **Platform-tenant gate:** command lifecycle HANYA dari tenant platform
  (`awcms_mini_setup_state.tenant_id`), di `_support.ts` `authorizeOperator`.
- **Restriction server-derived + FAIL-CLOSED**, ditegakkan di **HELPER
  capability** (BUKAN per-route — pelajaran #841): auth chokepoint
  `authorizeInTransaction` membaca lifecycle via `_shared` policy/reader; public
  host routing + background worker via projeksi `awcms_mini_tenants.status` yang
  di-set same-commit. Suspend TAK bisa di-bypass via direct API / stale session
  / public host / worker.
- **TIDAK PERNAH hapus data tenant.** Suspend/cancel/downgrade = ubah state +
  gate (+ entitlement), bukan delete. REVOKE DELETE (states) / UPDATE+DELETE
  (history). Trigger DB tolak DELETE + transisi ilegal.

## 6 pola control-plane (WAJIB sejak awal)

1. **default-disabled** — `defaultTenantState:"disabled"`; gated
   `tests/unit/module-governance-default-disabled.test.ts` (key sudah termasuk
   `tenant_lifecycle`). Tenant tanpa baris lifecycle = TAK diatur (ALLOW_ALL,
   offline-safe) — restriction hanya berlaku bila ada baris.
2. **boundary registry-wide** — modul lain tak import `tenant-lifecycle/app|
domain` (`tests/unit/module-boundary.test.ts`); no-shared-table-write
   (`awcms_mini_tenant_lifecycle_*` hanya ditulis modul ini — chokepoint neutral
   hanya SELECT); cross-module via port + injeksi di `_support.ts`. Policy
   kanonik ada di **`_shared/tenant-lifecycle-policy.ts`** supaya
   `identity_access` bisa MENEGAKKAN tanpa import modul (no reverse-dep/cycle).
3. **concurrency SEMUA write path** — `loadStateForUpdate` (row-lock) →
   validasi legal + optimistic version di app → `applyTransition` ter-predikat
   `state=? AND version=?` (0-row = 409 deterministik). Scheduled apply idempoten
   di bawah worker konkuren (row-lock + state+version-predicate; worker kedua
   temukan schedule sudah clear = no-op). Idempotency-Key + replay winner di
   route. JANGAN `Promise.all` pada satu tx.
4. **immutability trigger DB** — history append-only (tolak UPDATE/DELETE); states
   transisi forward-legal-only via whitelist trigger yang BYTE-MIRROR
   `domain/lifecycle-state.ts`; version +1 tepat per transisi; `canceled` hanya
   boleh ke `restoring`; downgrade/suspend/cancel TIDAK PERNAH DELETE.
5. **tak ada hash tenant-facing** — payload event & snapshot restriction
   non-sensitif (state/version/source); reason free-text TAK masuk event.
6. **fail-closed tri-state parser** — `application/request-parsing.ts`: absent=
   default aman (source→operator, confirmUnresolved→false), present-wrong-type=
   400 (validator), `expectedVersion` nullable tri-state.

## Restriction matrix (server-derived, `_shared/tenant-lifecycle-policy.ts`)

| state                                | admin | write         | public | jobs | provider | export/recovery      |
| ------------------------------------ | ----- | ------------- | ------ | ---- | -------- | -------------------- |
| provisioning                         | ✓     | ✓             | ✗      | ✗    | ✗        | ✓                    |
| trial / active / renewal_due / grace | ✓     | ✓             | ✓      | ✓    | ✓        | ✓                    |
| past_due                             | ✓     | ✗ (read-only) | ✓      | ✓    | ✓        | ✓                    |
| suspended / canceled / blocked       | ✗     | ✗             | ✗      | ✗    | ✗        | ✓ (separately authz) |
| restoring                            | ✓     | ✗             | ✗      | ✗    | ✗        | ✓                    |

- `governing:false` (tak ada baris) → `ALLOW_ALL`. Error saat governed →
  `DENY_ALL`. Projeksi `tenant.status = active IFF publicSiteAllowed`.
- Auth chokepoint EXEMPT `moduleKey==='tenant_lifecycle'` supaya operator/owner
  tetap bisa read/restore/recovery saat restricted.

## Endpoint (platform-operator, Idempotency-Key + reason wajib)

- `GET  /api/v1/tenant-lifecycle/tenants/{id}` — state + restrictions + timeline.
- `POST .../initialize` — buat record (idempoten).
- `POST .../transition` — transisi tervalidasi (409 ilegal/version).
- `POST .../schedule` + `DELETE .../schedule` — set/cancel transisi terjadwal.
- `POST .../downgrade` — turunkan entitlement (#871), TANPA hapus data.
- `POST .../restore` — reactivate ter-rekonsiliasi (provisioning_status #872);
  `confirmUnresolved` wajib bila belum ready.

## Job

`bun run tenant-lifecycle:run-scheduled <tenantId>` — apply transisi terjadwal
due untuk SATU tenant (idempoten). Fleet-wide batch DEFERRED ke #880.

## Verifikasi

`bun run db:migrate` (089/090), `bun run api:spec:check`, `bun test`,
`bun run build`. Test per AC: transition matrix (unit), RLS/concurrency/
idempotent-scheduled/event-same-commit (integration), cross-surface saat
suspended (API/SSR/public/worker), mutation test (cabut satu surface → parity
GAGAL). Lihat `src/modules/tenant-lifecycle/README.md`.

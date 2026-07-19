---
name: awcms-mini-tenant-entitlement
description: Kerjakan bagian mana pun dari modul tenant_entitlement AWCMS-Mini (Issue #871, epic #868 SaaS control plane Wave 1, ADR-0022) — modul control-plane KEDUA dan JANTUNG epic, yang pertama tenant-scoped. Gunakan saat menambah/mengubah endpoint di src/modules/tenant-entitlement, saat mengonsumsi kontrak effective_entitlement dari modul bisnis, saat menyentuh resolusi entitlement (offer/override/suspension/dependency-downgrade), saat menyentuh assign/override/revoke, atau saat menyentuh evaluation snapshot. Merangkum kontrak fail-closed effective_entitlement, batas control-plane vs tenant-plane, RLS FORCE tenant-scoped tanpa soft super-tenant, immutability/write-once, entitlement != permission, dan resolusi bounded no-N+1.
---

# AWCMS-Mini — Tenant Entitlement Module

`tenant_entitlement` (`src/modules/tenant-entitlement`, Issue #871, epic #868
SaaS control plane Wave 1, **ADR-0022**) adalah **modul control-plane KEDUA dan
JANTUNG epic** — Official Optional Business Foundation, **opt-in per tenant,
default-disabled**, dan **modul control-plane TENANT-SCOPED pertama**. Ia
menurunkan **entitlement efektif** fitur/modul/kuota tenant dari offer
`service_catalog` published + override operator, lalu mengekspos SATU kontrak
penegakan fail-closed (`effective_entitlement`) yang dikonsumsi #872/#873/#875/
#876 dan modul bisnis. Baca `src/modules/tenant-entitlement/README.md` +
`docs/adr/0022-*.md` sebelum mengubah.

## Invariant WAJIB dijaga (dari ADR-0022)

1. **effective_entitlement FAIL-CLOSED (§4 High-2 — INTI).** unknown/absent/
   indeterminate/unavailable/disabled = **DENY**, tak pernah grant-all. Satu-
   satunya tempat gating hidup = **helper capability** (`domain/resolution.ts`
   `isFeatureAllowed`/`isModuleEntitled`/`getQuota` + port adapter), BUKAN per-
   route ([[ssr-admin-pages-skip-module-enabled]]). Port adapter juga cek
   `resolveModuleEnabled` (disabled → deny-all) + catch error → deny.
2. **entitlement != permission (§4).** Entitlement positif TAK bisa memberi
   permission yang actor tak punya; RBAC/ABAC/RLS tetap otoritatif dan dicek
   INDEPENDEN. Header/body tenant TIDAK dipercaya sebagai fakta entitlement.
3. **module entitlement != module enabled-state** (`awcms_mini_tenant_modules`)
   tapi terkoordinasi. #871 hanya RESOLVE; tidak meng-toggle tenant_modules
   (itu tugas provisioning #872). Entitlement loss = ubah **state + gate**,
   TIDAK PERNAH DELETE data tenant.
4. **Tenant-scoped RLS FORCE tanpa soft super-tenant (§6 High-1).** Setiap tabel
   `tenant_id` + `ENABLE`+`FORCE RLS` + policy predikat **SELALU DAN HANYA**
   `tenant_id = current_setting('app.current_tenant_id')::uuid`. JANGAN tambah
   `OR platform-claim`. Operator kelola entitlement tenant HANYA lewat konteks
   per-tenant (`withTenant`), tiap mutasi audited. Route TIDAK punya path param
   `{tenantId}` — beroperasi pada tenant konteks saat ini.
5. **Immutability / write-once (§9).** assignments: kolom identity/offer beku
   sekali dibuat; status forward-legal (canceled = terminal); supersede/cancel
   provenance write-once. overrides: konten beku; revocation write-once (NULL→
   non-null). evaluation_snapshots: append-only penuh (no UPDATE/DELETE).
   Ditegakkan trigger DB (`sql/081`) + REVOKE grant, bukan hanya app-layer.
6. **Snapshot hash = HANYA bentuk tenant-facing (§pattern #5).** `snapshot_hash`
   di-hash atas keputusan yang diekspos (key+allowed+quota+sourceKind), TANPA
   reason free-text operator (tak ada di `EntitlementSource`), TANPA timestamp
   (dua resolusi identik → hash sama → invalidasi deterministik). JANGAN encode
   data operator-only lalu ekspos (oracle).

## Resolusi (deterministik, explainable, BOUNDED)

`resolveTenantEntitlement` (application) memuat **bulk** (2 record read + 1
published-offer read per offer distinct — via port `service_catalog_read`) lalu
memanggil `resolveEffectiveEntitlement` (PURE). **Query count konstan terhadap
jumlah key** (no per-request N+1 catalog query — [[n-plus-1-batch-835-premises]];
ada perf/query-count test). Precedence per key: override aktif MENGGANTI
keputusan offer (DB jamin ≤1 override aktif per key → grant/deny tak ambigu);
tanpa override → grant dari assignment aktif; tanpa keduanya → absent → helper
lookup DENY. Suspended/expired assignment = tak berkontribusi (restriction).
Module dependency SAFE-DOWNGRADE: modul entitled yang dependency-nya (yang juga
keputusan entitlement) tak entitled → di-downgrade (fixpoint monotonic).

## Pola concurrency SERAGAM (template service_catalog #870)

Tiap write path (`application/entitlement-directory.ts`): row-lock `FOR UPDATE`

- UPDATE ter-predikat status/revoked → 0-row = 409 bersih; `ON CONFLICT` pada
  partial unique index (assignment current, override active) → duplikat = 409
  bersih (bukan raw 23505); idempotency-replay (`replayConcurrentIdempotentWinner`)
  menang atas business-conflict same-key. assign/transition/override/revoke wajib
  `Idempotency-Key` (hash ber-resource-id) + audit (action diskriminatif) + emit
  event same-commit + tulis snapshot same-commit.

## Fail-closed tri-state parser (SEMUA field, [[patch-default-in-parse-resets-omitted-fields]])

`application/request-parsing.ts`: absent scalar/enum/bool → default; present →
verbatim (validator domain tolak 400); nullable → tri-state (absent→null,
present-wrong-type→400 bukan coerce ke null). Override targetKey WAJIB dikenal
(fail-closed unknown, `domain/entitlement-key-registry.ts` — union
`ModuleDescriptor.serviceCatalog.contributes*` + `listModules()` keys; DIREPLIKASI
dari service_catalog demi boundary, jangan import lintas modul).

## Events + boundary

Emit `awcms-mini.tenant-entitlement.assignment.changed` /
`.override.changed` (v1.0) via `appendDomainEvent` (terdaftar di
`event-type-registry.ts` + AsyncAPI + `module.ts` events.publishes, parity
di-gate). PROVIDES port `effective_entitlement`
(`_shared/ports/effective-entitlement-port.ts`, read-only). CONSUMES
`service_catalog_read` — wire adapter di composition-root route/page, JANGAN
import service-catalog app/domain (`tests/unit/module-boundary.test.ts` menegakkan).

## Verifikasi (JANGAN skip DB)

`bun run check` PENUH dengan PostgreSQL nyata (DB terisolasi FRESH, lihat memory
`scratch-db-verify-when-shared-db-poisoned` + `local-postgres-connection-details`).
*.integration.test.ts tak boleh skip. Test wajib: precedence/effective-date/
override/suspension/unknown-key/explanation (unit); RLS + constraint +
concurrency + revocation + event same-commit + cross-tenant + authorization-
negative + contract + perf/query-count (integration); mutation test (unknown-key
→ allow HARUS bikin test gagal). Regen: `openapi:bundle`, `api:docs:generate`,
`i18n:extract`, `repo:inventory`, `modules:composition:inventory`. Doc 01/13/21 +
`module-doc-reconciliation` + `module-skill-coverage` di-gate saat menambah modul.

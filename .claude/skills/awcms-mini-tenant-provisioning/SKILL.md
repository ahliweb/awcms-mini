---
name: awcms-mini-tenant-provisioning
description: Kerjakan bagian mana pun dari modul tenant_provisioning AWCMS-Mini (Issue #872, epic #868 SaaS control plane Wave 1, ADR-0022) — modul control-plane KETIGA. Gunakan saat menambah/mengubah orchestration provisioning (request/start/resume/cancel/retry/reconcile), plan/step registry berversi, step handler (core atau derived via capability port), kompensasi, atau reconciliation. Merangkum: provisioning idempoten/resumable dengan durable checkpoint, lease/lock ownership + bounded retry, kompensasi diklasifikasi (reversible/manual/forbidden) yang TIDAK PERNAH hapus data tenant, reconciliation non-destruktif, readiness gate (tenant tak pernah active tanpa kontrol keamanan), reuse tenant_admin onboarding + tenant_entitlement (bukan duplikasi), provider di luar transaksi, dan LAN/offline saat provider step absen.
---

# AWCMS-Mini — Tenant Provisioning Module

`tenant_provisioning` (`src/modules/tenant-provisioning`, Issue #872, epic #868
SaaS control plane Wave 1, **ADR-0022**) adalah **modul control-plane KETIGA** —
Official Optional Business Foundation, **opt-in per tenant, default-disabled**,
**tenant-scoped**. Ia mengorkestrasi **provisioning tenant idempoten/resumable**
dari plan/step registry berversi, dengan durable checkpoint, lease/lock, bounded
retry, kompensasi diklasifikasi, dan reconciliation non-destruktif. PROVIDES
`provisioning_status`; CONSUMES fail-closed `effective_entitlement` (#871).

## Batas keamanan yang WAJIB dijaga (ADR-0022)

- **Tenant-scoped RLS FORCE, predikat SELALU-HANYA `tenant_id`** (no soft
  super-tenant). Operator kelola tenant target lewat konteks per-tenant
  (`SET LOCAL app.current_tenant_id`), tiap command audited.
- **Platform-tenant gate:** command provisioning HANYA boleh dari tenant platform
  (`awcms_mini_setup_state.tenant_id`). Owner tenant yang ter-provision punya SEMUA
  permission di tenant-nya sendiri — tanpa gate ini ia bisa baca run tenant lain.
  Ditegakkan di `src/pages/api/v1/tenant-provisioning/_support.ts` `authorizeOperator`.
- **Secret = referensi only.** Owner password dikonsumsi SEKALI di request time
  (di-hash oleh `createTenantOwner`), TAK PERNAH disimpan; hanya fingerprint-nya
  masuk `inputs_hash`. Step I/O minimal + redacted; tak ada token/secret di
  payload/log/checkpoint.

## 6 pola control-plane (#870, WAJIB sejak awal)

1. **default-disabled** — `defaultTenantState:"disabled"`; gated
   `tests/unit/module-governance-default-disabled.test.ts` (key `tenant_provisioning`).
2. **boundary registry-wide** — modul lain tak import `tenant-provisioning/app|domain`;
   no-shared-table-write (`awcms_mini_tenant_provisioning_*` hanya ditulis modul ini);
   cross-module via port (`provisioning_status`/`provisioning_step`) + injeksi di
   composition root (`_support.ts`), BUKAN import langsung di app/domain.
3. **concurrency SEMUA write path** — lease (row-lock `FOR UPDATE` + state-predicate,
   expired-lease reclaimable), UPDATE ter-predikat status → 409 bersih, idempotency
   replay (request row = idempotency record: tenant_code unique + inputs_hash+key),
   partial-column (`transitionRequest` CASE WHEN provided).
4. **immutability/write-once (trigger DB 3-DML)** — step attempts/results/
   reconciliations APPEND-ONLY (reject UPDATE+DELETE); step `checkpoint` write-once
   (NULL→non-null); request/step identity+plan+inputs frozen; status transitions
   forward-legal only; no hard delete (REVOKE DELETE). Mirror pure di
   `domain/provisioning-state.ts`.
5. **snapshot/hash tenant-facing-only** — TIDAK ADA hash tenant-facing di modul ini
   (tak ada oracle). `inputs_hash` = idempotency binding (fingerprint password, bukan
   plaintext), bukan data tenant-visible.
6. **fail-closed tri-state SEMUA field parser** — `application/request-parsing.ts`:
   absent→default; present→verbatim (validator tolak 400); nullable tri-state;
   present-non-object owner/options→`{}`.

## Engine (ADR-0022 §11.1)

Transaction model — durable checkpoint + provider di luar tx:

- `request`: SATU tx — buat tenant (anti-dup `tenant_code`), owner, office, settings,
  request+steps (bootstrap+owner PRE-COMPLETED, sisanya pending), emit `requested`.
- `start/resume/retry`: acquire lease → loop step, TIAP step tx SENDIRI (checkpoint
  durable sebelum step berikut). `waiting` (provider) → event via outbox lalu pause.
- `cancel`: tolak bila lease hidup; kompensasi terklasifikasi; tenant tetap inactive.
- `reconcile`: desired-vs-actual, laporkan drift + safe action, TANPA auto-fix.

State request: requested→in_progress→provisioned; in_progress→compensating→failed;
failed/blocked→in_progress (retry); provisioned→reconciling→provisioned; →canceled.
Readiness: pending/ready/blocked. Run gagal/cancel TAK PERNAH tinggalkan tenant
active — tenant `inactive` + status blocked/failed terlihat + `readiness=blocked`.

## Kompensasi (klasifikasi eksplisit)

`domain/compensation.ts`: `reversible`→jalankan `compensate` handler (undo idempoten,
STATE saja); `manual`→`manual_required`; `forbidden`→`skipped_forbidden` (tenant
record + readiness). JANGAN hapus data tenant sebagai kompensasi generik.

## Reuse (JANGAN duplikasi)

- Tenant/owner/office/config: `tenant-admin/application/tenant-onboarding.ts`
  (dipakai BERSAMA setup wizard — satu implementasi). Refactor setup pakai helper
  ini; jaga SQL/urutan identik.
- Entitlement assignment: `tenant_entitlement` assign/cancel (#871) via
  `_support.ts` `buildEngineDeps().steps.entitlement`.
- Module preset + subdomain: injeksi opsional (base UNWIRED → step SKIP, LAN-safe);
  derived app pasang via `CoreStepDeps`/`registerProvisioningStep`.

## Plan/step registry (composition seam, beda dari #874)

`domain/provisioning-plan.ts` (plan berversi, `registerProvisioningPlan`) +
`infrastructure/step-handler-registry.ts` (`registerProvisioningStep`). Base:
`standard_tenant` v1 (tenant_bootstrap/owner_identity/default_configuration/
entitlement_assignment/module_preset/subdomain_request/readiness_check). Step tanpa
handler ter-resolve → FAIL CLOSED (blocked). Derived contribute tanpa edit engine.

## Sinyal control-plane fleet-wide (#930)

`application/control-plane-signals.ts` — `collectProvisioningSignals(tx, now)`,
dibaca `bun run control-plane:fleet-sweep`. Membaca HANYA tabel modul ini, di
dalam konteks RLS satu tenant; iterasi lintas-tenant ada di composition root
(ADR-0022 §6b — platform operator BUKAN soft super-tenant).

- **`awcms_mini_tenant_provisioning_requests` UNIQUE pada `tenant_id`** —
  provisioning 1:1 dengan tenant, jadi per tenant paling banyak SATU request.
  Menguji beberapa status berarti menyiapkan beberapa TENANT, bukan beberapa
  request.
- Status modul dipetakan ke vocabulary label metrik yang lebih KASAR
  (`pending`/`running`/`waiting`/`failed`) — sengaja, supaya label alert tidak
  ikut tumbuh tiap kali status baru ditambahkan.
- **`failed` masuk hitungan backlog tapi TIDAK menua.** Ia tidak menunggu apa
  pun; memasukkannya ke umur "oldest pending" membuat umur naik selamanya
  setelah satu kegagalan dan mengunci alert terbuka.
- Worker butuh GRANT SELECT eksplisit (migration `103`).

## Verifikasi WAJIB

`bun run check` PENUH di DB PostgreSQL terisolasi FRESH (migration 085 diedit ⇒
migrate dari nol; jangan DB yang punya 083 lama = checksum drift). Test: state
transition/plan-validation/compensation-classification/error-handling (unit);
lease/idempotency/resume/RLS/event-same-commit (integration); failure-injection tiap
step boundary; concurrency duplicate-request + worker-restart; derived-step fixture;
E2E request→failure→resume→active; security secret/PII redaction + cross-tenant denial.
Blast radius: index.ts (26 modul), doc-reconciliation `toBe(26)` + heading "Peta 26",
doc 21 tabel+total, skill-coverage MAP, event-registry+AsyncAPI+OpenAPI, i18n.

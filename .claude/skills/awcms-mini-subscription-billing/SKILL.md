---
name: awcms-mini-subscription-billing
description: Kerjakan bagian mana pun dari modul subscription_billing AWCMS-Mini (Issue #876, epic #868 SaaS control plane Wave 1, ADR-0022) — modul control-plane KELIMA. Gunakan saat menambah/mengubah state machine subscription (pending/trialing/active/past_due/canceled/expired) atau invoice (draft->issued->{paid,void}), generasi invoice idempoten per (subscription, period, offer version), credit note, referensi alokasi pembayaran, dunning, atau upgrade/downgrade/cancel terjadwal. Merangkum 6 pola WAJIB + BOUNDARY KRITIS: billing = STATE komersial SaaS, BUKAN general ledger/double-entry/AR-AP/tax engine/e-invoicing/kas-bank/invoice bisnis tenant; payment allocation = REFERENSI saja (bukan tabel akuntansi/klaim); uang EXACT minor-unit bigint (TIDAK PERNAH float) + single-currency per invoice + rounding policy eksplisit; issued invoice IMMUTABLE (koreksi via credit-note/void, tak pernah edit/delete); subscription terikat versi published offer IMMUTABLE (#870); usage line rekonsiliasi ke #875 + rekam window/version; dunning MEMINTA transisi lewat kontrak lifecycle #873 (fail-closed, tak pernah tulis state langsung); job berjadwal pakai lease per-tenant; RLS ENABLE+FORCE predikat SELALU-HANYA tenant_id; platform-operator terpisah dari tenant admin; PROVIDES billing_document_state (#877 consume); LAN/offline/manual-payment tanpa gateway online.
---

# AWCMS-Mini — Subscription Billing Module

`subscription_billing` (`src/modules/subscription-billing`, Issue #876, epic
#868 SaaS control plane Wave 1, **ADR-0022**) adalah **modul control-plane
KELIMA** — Official Optional Business Foundation, **opt-in per tenant,
default-disabled**, **tenant-scoped**. Ia mencatat **STATE komersial SaaS**
sebuah subscription tenant: subscription terikat versi published offer
immutable (#870), billing period, invoice draft/issued (immutable) + line,
credit note, referensi alokasi pembayaran, dunning, dan upgrade/downgrade/
cancel terjadwal. PROVIDES `billing_document_state` (read-only, di-consume
`payment_gateway` #877); CONSUMES `service_catalog_read` (#870),
`usage_aggregate` (#875), dan `lifecycle_transition` (#873, write).

## BOUNDARY KRITIS (ADR-0022 §11) — billing BUKAN akuntansi

- **BUKAN** general ledger / double-entry / AR-AP subledger / tax engine /
  e-invoicing / withholding / rekonsiliasi kas-bank / invoice bisnis tenant.
  Billing = STATE komersial SaaS saja.
- **Payment allocation = REFERENSI** (provider ref + amount + invoice mana yang
  diselesaikan). TIDAK PERNAH membuat tabel akuntansi / journal / klaim.
- Provider pembayaran lewat kontrak adapter **#877** — TIDAK ADA panggilan
  provider di dalam transaksi invoice. Payment status di-update HANYA dari
  outcome adapter/reconciliation tervalidasi (`recordPaymentAllocation`).
- Bila ragu apakah sesuatu termasuk billing atau akuntansi/ERP: itu di LUAR
  scope modul ini.

## 6 pola WAJIB (front-load = 0 ronde review)

1. **default-disabled** (`defaultTenantState: "disabled"`) — gate
   `tests/unit/module-governance-default-disabled.test.ts`.
2. **boundary registry-wide** (`tests/unit/module-boundary.test.ts`): tak ada
   modul lain menulis `awcms_mini_subscription_billing_*`; tak ada modul lain
   import app/domain modul ini; konsumsi lintas-modul HANYA di composition-root
   (`src/pages/api/v1/subscription-billing/_support.ts` + `scripts/*`) lewat
   port (`service_catalog_read`, `usage_aggregate`, `lifecycle_transition`).
3. **concurrency semua write path + job**: row-lock `FOR UPDATE` + UPDATE
   ber-predikat state/version → 409 deterministik; **generasi invoice IDEMPOTEN
   per (subscription, period)** via partial-unique + `ON CONFLICT DO NOTHING` +
   subscription row-lock + `replayConcurrentIdempotentWinner`; job pakai **lease
   per-(tenant, job_kind)** (`billing-lease.ts`) + bounded batch.
4. **immutability trigger DB**: subscription offer binding FROZEN; invoice
   draft->issued->{paid,void}; **issued invoice IMMUTABLE** (amount/currency/
   period/issued provenance beku — trigger); line beku saat parent issued;
   status_history/credit_notes/payment_allocations APPEND-ONLY; koreksi via
   credit-note/void, TAK PERNAH edit/delete. REVOKE DELETE.
5. **Uang EXACT** (`domain/money.ts`): minor-unit **bigint**, TIDAK PERNAH
   float; semua aritmetika lewat BigInt; guard `<= Number.MAX_SAFE_INTEGER` di
   CHECK + parser; **single-currency per invoice** (tolak mixed-currency);
   rounding policy eksplisit (`half_up`/`half_even`/`floor`/`ceil`).
6. **fail-closed tri-state parser** (`application/request-parsing.ts`): absent=
   keep default, present-wrong-type=**400** (validator menolak, bukan koersi);
   event versioned emit dgn KONSTANTA ter-import langsung same-commit.

## Peta file

- `sql/091_*` schema (10 tabel), `sql/092_*` permissions.
- `domain/`: `money.ts` (exact minor-unit), `subscription-state.ts`,
  `invoice-state.ts`, `period.ts`, `request-validation.ts`, `job-kinds.ts`.
- `application/`: `billing-directory.ts` (SQL), `subscription-engine.ts`,
  `invoice-engine.ts` (generate/issue/void/credit/payment), `dunning-engine.ts`
  (minta transisi #873 fail-closed), `subscription-change-engine.ts`,
  `billing-jobs.ts` (renewal + dunning, lease), `billing-lease.ts`,
  `billing-document-port-adapter.ts` (PROVIDES `billing_document_state`).
- Routes: `src/pages/api/v1/subscription-billing/tenants/{tenantId}/...`
  (writes = platform-operator; reads = platform-operator ATAU self-tenant).
- Jobs: `scripts/subscription-billing-run-{renewal,dunning}.ts`.

## Dunning ↔ lifecycle (WAJIB)

Dunning **MEMINTA** transisi lifecycle lewat port `lifecycle_transition` (#873),
TIDAK PERNAH menulis `awcms_mini_tenant_lifecycle_*`. **Fail-closed**: error /
hasil non-ok dari port = outcome `refused`/`not_available`, JANGAN asumsikan
transisi ter-apply (`catch { proceed }` DILARANG).

Validasi selesai: `bun run db:migrate` (92 migrasi), typecheck, lint, semua
`*:check`, `bun test`, `bun run build`.

---
name: awcms-mini-payment-gateway
description: Kerjakan bagian mana pun dari modul payment_gateway AWCMS-Mini (Issue #877, epic #868 SaaS control plane Wave 1, ADR-0022) — modul control-plane KEENAM & TERAKHIR. Gunakan saat menambah/mengubah checkout/session provider-netral, webhook masuk bertandatangan, event pembayaran ternormalisasi, refund, retry/DLQ, provider health/circuit-breaker, atau reconciliation. Merangkum BOUNDARY KRITIS: status pembayaran TAK PERNAH dipercaya dari redirect browser (hanya webhook signed tervalidasi ATAU reconciliation); panggilan provider SELALU di luar transaksi DB (ADR-0006) lewat outbox + worker; webhook fail-closed WAJIB (HMAC timing-safe + freshness ≤300s + binding provider/account + payload size + anti-replay per-event-id DURABLE di DB + ordering) → valid signed webhook update payment TEPAT SEKALI; SSRF/open-redirect allow-list via new URL()+host equality (BUKAN startsWith); secret provider HANYA di process.env (pointer env: di row), TAK PERNAH di tabel/event/log; webhook envelope PII di-mask doc 04 sebelum persist; uang EXACT minor-unit bigint (TIDAK PERNAH float); RLS ENABLE+FORCE predikat SELALU-HANYA tenant_id; provider adapter = opsional config (fake/sandbox di base, provider nyata via application-registry.ts); CONSUMES billing_document_state (#876) + PROVIDES payment_outcome; BUKAN general ledger/AR-AP/merchant settlement/tax/PCI card-data; LAN/offline/manual-payment jalan tanpa provider.
---

# AWCMS-Mini — Payment Gateway Module

`payment_gateway` (`src/modules/payment-gateway`, Issue #877, epic #868 SaaS
control plane Wave 1, **ADR-0022**) adalah **modul control-plane KEENAM &
TERAKHIR** — Official Optional Business Foundation, **opt-in per tenant,
default-disabled**, **tenant-scoped**. Ia menyediakan kapabilitas pembayaran
**provider-netral**: hosted checkout/session, webhook masuk **bertandatangan**,
event pembayaran ternormalisasi, refund, retry/DLQ, provider health + circuit
breaker, dan reconciliation. Ia **BUKAN** general ledger / AR-AP / double-entry
accounting / merchant settlement / tax engine, dan **tidak pernah** menyimpan
kredensial kartu / PAN (ADR-0022 §11).

## Boundary keamanan KRITIS (patuhi semuanya)

1. **Status pembayaran TAK PERNAH dari redirect browser.** Hanya webhook signed
   tervalidasi ATAU hasil reconciliation yang mengubah status intent. Route
   `webhook/[providerAccountId].ts` diautentikasi oleh id akun opaque (bind ke
   TEPAT SATU tenant) + verifikasi adapter — bukan sesi JWT tenant.
2. **Panggilan provider SELALU di luar transaksi DB (ADR-0006).** `initiateCheckout`/
   `requestRefund` commit intent + baris **outbox** DULU; worker
   `outbox-dispatch` memanggil provider **tanpa transaksi terbuka**, lalu
   finalize di transaksi terpisah. Outage provider → retry/backoff + circuit
   breaker + DLQ, TAK PERNAH menahan/rollback transaksi sumber.
3. **Webhook inbox fail-closed WAJIB** (`domain/webhook-security.ts` +
   `webhook-intake.ts`): (a) HMAC signature timing-safe; (b) timestamp/freshness
   window **≤300s**; (c) binding provider/account (payload `account_ref` ==
   akun terikat → cegah cross-tenant substitution); (d) payload size; (e)
   **anti-replay via event-id PERSISTEN di DB** (unique
   `(tenant, account, provider_event_id)` — BUKAN in-memory); (f) ordering
   (`provider_sequence` monotonic). **Valid signed webhook update payment TEPAT
   SEKALI** (loser ON CONFLICT = no-op). Gagal/oversized/duplicate/out-of-order/
   stale = tolak fail-closed + audit + reconciliation evidence.
4. **SSRF/open-redirect** (`domain/endpoint-allowlist.ts`): endpoint provider +
   callback URL **allow-listed** per akun; validasi host via `new URL()` +
   **host equality** (BUKAN `startsWith` prefix — memory
   [[linkedin-media-trust-helper-862]]).
5. **Secret provider HANYA di `process.env`** — row akun menyimpan POINTER
   `env:VAR_NAME` (`domain/secret-ref.ts`), TAK PERNAH nilai secret. Tidak di
   tabel/event/log/audit. Rotasi = env deployment.
6. **Webhook envelope PII di-mask doc 04 SEBELUM persist** (`domain/masking.ts`)
   — hanya snippet ter-mask (bukan raw body), referensi provider ter-MASK,
   safe error class (tak pernah pesan provider mentah).

## 6 pola WAJIB (control-plane)

1. **default-disabled** `defaultTenantState:"disabled"` + gate di
   `tests/unit/module-governance-default-disabled.test.ts`.
2. **boundary registry-wide** (`module-boundary.test.ts`): no reverse dep,
   `awcms_mini_payment_gateway_*` hanya modul sendiri, port `payment_outcome`
   neutral. Konsumsi billing #876 (billing_document_state read + recordPayment
   Allocation write) HANYA di composition-root (`_support.ts`/scripts), jangan
   di app/domain payment_gateway.
3. **concurrency SEMUA write path + jobs:** row-lock `FOR UPDATE` + UPDATE
   ber-predikat status → 409, `ON CONFLICT` partial-unique,
   `replayConcurrentIdempotentWinner`. Webhook EXACTLY-ONCE (event-id unique).
   Job (dispatch/reconcile/expire) pakai **LEASE** per-(tenant,job_kind).
   JANGAN `Promise.all` atas satu tx.
4. **immutability trigger DB:** webhook inbox / normalized events / processing
   attempts / reconciliations append-only; intent state machine forward-legal
   (initiated→pending→{settled,failed,expired}; failed→initiated; settled→
   {refunded,disputed}); refund result write-once. REVOKE DELETE.
5. **no hash tenant-facing oracle**; uang EXACT bigint minor-unit no-float
   (`domain/money.ts`).
6. **fail-closed tri-state SEMUA field parser** (`request-parsing`/`request-
validation`). Event versioned emit dgn KONSTANTA ter-import LANGSUNG dari
   `event-type-registry`, snapshot same-commit.

## Provider adapter (opsional)

Adapter provider = **External Integration off-by-default**. Base HANYA ship
`sandbox-adapter.ts` (fake, untuk test + docs) di `infrastructure/adapter-
registry.ts`. Provider nyata (Midtrans/Xendit/Stripe) opt-in di repo turunan
lewat `application-registry.ts` + `registerPaymentProviderAdapter`, TAK PERNAH
hardcoded di base. LAN/offline (modul disabled) = 100% tanpa provider.

## Kontrak & seam

- CONSUMES `billing_document_state` (#876, read-only) untuk validasi invoice payable.
- PROVIDES `payment_outcome` (`_shared/ports/payment-outcome-port.ts`) —
  settled/refunded diteruskan ke `subscription_billing.recordPaymentAllocation`
  (write path #876 sendiri, idempoten, audited), wired di composition-root.
- Migrasi `093` (schema) + `094` (permissions); jobs
  `payment-gateway:dispatch-outbox|reconcile|expire-sweep`.

Lihat `src/modules/payment-gateway/README.md` untuk detail ERD/tabel/state
machine.

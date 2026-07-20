---
name: awcms-mini-usage-metering
description: Kerjakan bagian mana pun dari modul usage_metering AWCMS-Mini (Issue #875, epic #868 SaaS control plane Wave 1, ADR-0022) — modul control-plane KETIGA, fondasi metering provider-neutral tenant-scoped. Gunakan saat menambah/mengubah endpoint di src/modules/usage-metering, saat modul bisnis mengemit meter event lewat port usage_append, saat billing (#876) membaca usage/quota lewat port usage_aggregate, saat menyentuh aggregation worker (lease/checkpoint/bounded-batch/replay/rebuild), late/out-of-order events, koreksi bertanda, atau reconciliation. Merangkum event append-only numeric-only, idempotency identity (dihitung sekali), determinisme aggregation (rebuild = reproduksi), quota fail-closed authoritative, dan resolusi meter fail-closed terhadap single source #874.
---

# AWCMS-Mini — Usage Metering Module

`usage_metering` (`src/modules/usage-metering`, Issue #875, epic #868 SaaS
control plane Wave 1, **ADR-0022**) adalah **modul control-plane KETIGA** —
Official Optional Business Foundation, **opt-in per tenant, default-disabled**,
dan **tenant-scoped**. Ia adalah **fondasi metering provider-neutral**: modul
pemilik mengemit meter EVENT numeric-only (idempotent, privacy-minimized) di
commit-nya sendiri lewat port `usage_append`; worker async resumable
memMATERIALISASI usage WINDOW secara DETERMINISTIK dari event immutable + koreksi
bertanda; reconciliation menghitung ulang window dari sumber dan menandai drift;
port `usage_aggregate` mengekspos usage efektif + keputusan quota FAIL-CLOSED
yang dibaca billing (#876). Baca `src/modules/usage-metering/README.md` +
`docs/adr/0022-*.md` sebelum mengubah. BUKAN pricing invoice (#876), BUKAN
telemetry aplikasi.

## Invariant WAJIB dijaga (dari ADR-0022)

1. **Numeric-only / no raw payload (§3/§8).** Event menyimpan `quantity` bigint
   (JANGAN float) + map dimensi ADMITTED kecil (`domain/dimension-admission.ts`
   — kunci/nilai skalar pendek, fail-closed) — JANGAN raw body/dokumen/secret/
   JSON arbitrer. Payload event domain & audit numeric-only — JANGAN free-text
   reason koreksi.
2. **Idempotency identity → dihitung sekali.** `(tenant, producer, meter,
source_event_id, source_version)` UNIQUE. Append & koreksi INSERT `ON CONFLICT
DO NOTHING RETURNING` lalu replay row pemenang. Route high-risk pakai
   `Idempotency-Key` + `replayConcurrentIdempotentWinner` untuk balapan same-key.
   Hash idempotency WAJIB sertakan resource id (event id / shard) — memory
   `idempotency-hash-missing-resource-id-recurring`.
3. **Append-only + immutability (§9).** events/corrections/reconciliation_runs
   append-only; aggregates di-recompute in place (identity beku, `source_watermark`
   monotonik, `window_closed` one-way); cursor `checkpoint_seq` maju saja. Ditegakkan
   trigger BEFORE (`sql/087`) + REVOKE least-privilege (`sql/088`). JANGAN hard-delete
   data tenant; DELETE hanya jalur purge retention (worker-only, hormati legal hold).
4. **Determinisme aggregation.** Nilai window = fungsi MURNI dari event+koreksi yang
   `event_time`-nya jatuh di window — BUKAN urutan ingest/terima. Maka rebuild
   (recompute-from-source) mereproduksi nilai tersimpan, replay tak pernah
   double-count, late/out-of-order recompute window-nya (tambah late counter), dan
   reconciliation menandai aggregate yang drift. Bucket window pakai
   `windowStartFor` UTC (JANGAN SQL `date_trunc` — timezone sesi).
5. **Quota FAIL-CLOSED authoritative (§4).** `getQuotaDecision` gabung limit
   `effective_entitlement` (#871, fail-closed) + usage window SAAT INI yang
   dihitung ULANG LIVE dari event immutable (BUKAN aggregate materialized yang bisa
   basi). Recompute gagal → `usage_unavailable` → quota hard DENY. Entitlement !=
   permission — keputusan positif fakta komersial, bukan otorisasi.
6. **Meter resolve terhadap single source #874.** Semua meter/aggregation/bounds/
   admisibilitas koreksi lewat `_shared/saas-contract-registry.ts` (via
   `application/meter-registry.ts`) — JANGAN hardcode set meter. Meter tak dikenal
   → fail closed (`null`/`unknown_meter`). Base kirim contoh netral di `module.ts`;
   app turunan kontribusi lewat `application-registry.ts`.

## Batas modul (module-boundary)

- Modul lain HANYA impor TYPE port dari `_shared/ports/usage-append-port.ts` /
  `usage-aggregate-port.ts`; adapter konkret diwire di composition root
  (route/job), BUKAN impor lintas-modul langsung.
- `effective_entitlement` (#871) DIKONSUMSI lewat port di composition root,
  fail-closed, JANGAN impor domain/application tenant_entitlement langsung.
- Tabel `awcms_mini_usage_*` HANYA ditulis modul ini (no-shared-table-write).

## Alur emisi usage (untuk modul pemilik)

Di transaksi bisnismu sendiri: `createUsageAppendPort(registry)(tx, tenantId,
input)` — event usage commit ATOMIK dengan transaksi bisnis (outbox pattern, tabel
`usage_events` = outbox yang di-drain worker di LUAR transaksi). `tenantId` dari
konteks tenant pemanggil — producer tak bisa submit usage tenant lain.

## Sebelum selesai

Jalankan `bun run db:migrate`, `bun run api:spec:check`, `bun test`, `bun run
build`. Migration schema/permission baru → `foundation.test.ts` count + doc 13.
Event baru → AsyncAPI + `event-type-registry.ts`. Route baru → OpenAPI. Ubah
perilaku → changeset. Regen inventory (`repo:inventory`, composition inventory,
api docs, i18n POT).

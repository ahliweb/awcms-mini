---
name: awcms-mini-integration
description: Audit dan perkuat backend & integrasi eksternal AWCMS-Mini (resiliensi, outbox, webhook/provider, versioning API, observability). Gunakan saat menambah/mengeraskan integrasi ke provider luar (R2, WhatsApp, email, AI, pajak), memperbaiki keandalan delivery, atau menaikkan ketahanan backend. Menegakkan ADR-0006 (provider opsional, di luar transaksi) dan pola outbox doc 16.
---

# AWCMS-Mini — Backend & Integration Hardening

Sumber kebenaran: **`docs/awcms-mini/16_backend_data_access_integration.md`** (transactional outbox, transaction wrapper, idempotency), **`docs/awcms-mini/05_openapi_asyncapi_detail.md`** (kontrak API/event), dan **`docs/awcms-mini/10_template_kode_coding_standard.md`** (guardrail). Skill ini **peningkatan**: menaikkan keandalan & ketahanan, bukan sekadar membuat endpoint (itu `awcms-mini-new-endpoint`).

## Prinsip integrasi (non-negotiable)

- **Provider eksternal opsional** (ADR-0006): R2/WA/email/AI/pajak **tidak boleh** jadi dependency alur operasional kritis, dan **tidak boleh** dipanggil di dalam transaksi DB. Provider off → aksi tetap masuk antrean, bukan gagal.
- **Secret hanya dari environment** (doc 18); flag aktif tanpa kredensial → gagal start (fail-fast).

## Checklist ketahanan

- [ ] **Transactional outbox** — efek samping eksternal (kirim WA/email, upload objek, publish event) ditulis ke tabel outbox **dalam** transaksi bisnis, lalu dispatcher terpisah mengirim di luar transaksi (at-least-once). Bukan panggilan langsung inline. Contoh yang sudah ada: `awcms_mini_sync_outbox` dan `awcms_mini_object_sync_queue`; `awcms_mini_message_outbox` (WA/email, doc 04 §ERD) adalah pola yang direncanakan tetapi belum dibuat — aplikasi turunan yang butuh kanal pesan menambahkannya mengikuti pola sama.
- [ ] **Timeout + retry + backoff** — tiap panggilan keluar punya timeout eksplisit; retry dengan exponential backoff berbatas (pola `evaluateObjectRetry`, maks percobaan); jangan retry tak terbatas.
- [ ] **Circuit breaker** — dependency yang gagal beruntun dibuka sementara agar tak menyeret sistem (pola `src/lib/database/circuit-breaker.ts` dapat diperluas ke provider).
- [ ] **Idempotency di batas integrasi** — dispatcher aman diulang (dedup by natural key / `Idempotency-Key` / ledger batch seperti `sync_push_batches`); pengiriman ganda tak menduplikasi efek.
- [ ] **Dead-letter / status gagal** — item yang habis retry ditandai `failed` dengan `last_error`, bukan hilang diam-diam; ada jalur retry manual admin (mis. `/sync/object-queue/{id}/retry`).
- [ ] **Verifikasi webhook masuk** — signature HMAC + anti-replay (timestamp skew) untuk callback provider, pola `awcms-mini-sync-hmac`. Jangan percaya payload tak tertandatangani.
- [ ] **SSRF-safe** — URL provider dari konfigurasi tepercaya (env), bukan dari input user; validasi host bila perlu.
- [ ] **Kontrak sinkron** — endpoint baru/berubah → OpenAPI diperbarui; event baru/berubah → AsyncAPI diperbarui; `module.ts` publishes/subscribes akurat. `bun run api:spec:check` hijau.
- [ ] **Versioning & kompatibilitas** — perubahan breaking di path/skema butuh versi baru atau additive; jangan patahkan klien lama (pola cookie additive di `/auth/login`).
- [ ] **Observability** — correlation ID diteruskan lintas hop (header `X-Correlation-ID`, middleware); log terstruktur JSON (hormati `LOG_LEVEL`); aksi high-risk masuk audit; redaksi secret/PII sebelum log.
- [ ] **Degradasi anggun** — bila provider/flag off, endpoint operasional tetap jalan (POS tak berhenti); pesan/objek tetap terantre.
- [ ] **Rate limiting / anti-abuse** — batasi endpoint publik/mahal; login sudah punya lockout — perluas pola ke titik lain bila perlu.

## Verifikasi

- Uji provider off: aksi tetap masuk outbox/queue, tak ada error operasional.
- Uji retry: paksa gagal → item mundur backoff → habis percobaan → `failed` + `last_error`, retry manual mengembalikan ke `pending`.
- Uji idempotency dispatcher: kirim ulang batch → efek tak berganda.
- `bun run check` hijau; OpenAPI/AsyncAPI sinkron; correlation ID muncul di log lintas hop.

## Skill terkait

`awcms-mini-new-endpoint` / `awcms-mini-new-event` (kontrak), `awcms-mini-sync-hmac` (signature), `awcms-mini-idempotency` (mutation), `awcms-mini-audit-log` (jejak), `awcms-mini-performance` (I/O di luar transaksi).

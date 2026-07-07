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

- [ ] **Transactional outbox** — efek samping eksternal (kirim WA/email, upload objek, publish event) ditulis ke tabel outbox **dalam** transaksi bisnis, lalu dispatcher terpisah mengirim di luar transaksi (at-least-once). Bukan panggilan langsung inline. Contoh nyata sudah ada, ikuti pola ini: `awcms_mini_object_sync_queue` + `dispatchObjectSyncQueue` (`src/modules/sync-storage/application/object-dispatch.ts`, Issue #436) — tiga fase CLAIM (transaksi pendek, `FOR UPDATE SKIP LOCKED`, status transien `sending` sebagai lease) → UPLOAD (di luar transaksi apa pun) → FINALIZE (transaksi pendek kedua). `awcms_mini_sync_outbox` (event lokal antar-node) belum punya dispatcher live. Email (epic #492, Issue #493-#495) adalah contoh kedua nyata dari pola ini, dengan variasi: `awcms_mini_email_messages` (`sql/020`) + `dispatchEmailQueue` (`src/modules/email/application/email-dispatch.ts`) — CLAIM (reuse `next_attempt_at` sebagai lease, sama seperti object queue) → SEND (render dari `template_key`/`variables` lalu panggil `EmailProvider.send`, di luar transaksi apa pun) → FINALIZE (retry_wait/sent/failed + catat `email_delivery_attempts`). Caller nyata sudah ada sejak Issue #496/#497 (epic #492 selesai): password reset (`POST /auth/password/forgot`) dan bulk announcement (`POST /email/announcements[/preview]`, two-tier ABAC) sama-sama meng-enqueue ke `email_messages` sebelum `bun run email:dispatch` mengklaimnya.
- [ ] **Timeout + retry + backoff** — tiap panggilan keluar punya timeout eksplisit (`withTimeout`, `src/lib/integration/timeout.ts`, Issue #436 — reuse, jangan bikin ulang); retry dengan exponential backoff berbatas (pola `evaluateObjectRetry`, maks percobaan); jangan retry tak terbatas.
- [ ] **Circuit breaker** — dependency yang gagal beruntun dibuka sementara agar tak menyeret sistem. `src/lib/database/circuit-breaker.ts` punya **registry per-provider** sejak Issue #436: `getProviderCircuitBreaker(providerKey)` untuk provider eksternal (reuse, jangan bikin circuit breaker terpisah) — beda dari singleton database yang sudah ada sejak awal. Saat breaker terbuka, baris yang butuh provider itu tidak diklaim sama sekali pada pass tersebut (tetap `pending`); baris yang tidak butuh provider tetap jalan.
- [ ] **Idempotency di batas integrasi** — dispatcher aman diulang (dedup by natural key / `Idempotency-Key` / ledger batch seperti `sync_push_batches`); pengiriman ganda tak menduplikasi efek. Untuk upload objek: key upload (`objectKey`) sendiri jadi dedup key alami (PUT S3/R2 ke key sama = overwrite, bukan duplikat) — tidak selalu perlu ledger terpisah.
- [ ] **Dead-letter / status gagal** — item yang habis retry ditandai `failed` dengan `last_error`, bukan hilang diam-diam; ada jalur retry manual admin (mis. `/sync/object-queue/{id}/retry`).
- [ ] **Verifikasi webhook masuk** — signature HMAC + anti-replay (timestamp skew) untuk callback provider, pola `awcms-mini-sync-hmac`. Jangan percaya payload tak tertandatangani.
- [ ] **SSRF-safe** — URL provider dari konfigurasi tepercaya (env), bukan dari input user; validasi host bila perlu. Contoh nyata: `object-storage-uploader.ts` (Issue #436) — endpoint R2 selalu dari `process.env.R2_ACCOUNT_ID`, tak pernah dari request.
- [ ] **Kontrak sinkron** — endpoint baru/berubah → OpenAPI diperbarui; event baru/berubah → AsyncAPI diperbarui; `module.ts` publishes/subscribes akurat. `bun run api:spec:check` hijau. Dispatcher/CLI internal (bukan endpoint HTTP) **tidak** butuh update OpenAPI.
- [ ] **Versioning & kompatibilitas** — perubahan breaking di path/skema butuh versi baru atau additive; jangan patahkan klien lama (pola cookie additive di `/auth/login`).
- [ ] **Observability** — correlation ID otomatis di `meta.correlationId` untuk endpoint `/api/*` sejak Issue #447 (tidak perlu wiring manual, lihat `awcms-mini-observability`); log terstruktur JSON (hormati `LOG_LEVEL`); aksi high-risk masuk audit; redaksi secret/PII sebelum log; extension point `setLogSink`/`setAuditExportHook` tersedia bagi aplikasi turunan yang butuh forward ke SIEM eksternal (`awcms-mini-observability`).
- [ ] **Degradasi anggun** — bila provider/flag off, endpoint operasional tetap jalan (POS tak berhenti); pesan/objek tetap terantre.
- [ ] **Rate limiting / anti-abuse** — batasi endpoint publik/mahal. `src/lib/security/rate-limit.ts` (Issue #437) sudah menyediakan fixed-window counter generik (`checkRateLimit`, keyed sumber+konteks) — dipakai login, **reuse untuk endpoint publik/mahal lain**, jangan bikin limiter terpisah. In-memory per-proses (tidak dibagi antar instance) — cukup untuk topologi single-instance, deployment multi-instance perlu rate limiting di edge/proxy.

## Verifikasi

- Uji provider off: aksi tetap masuk outbox/queue, tak ada error operasional.
- Uji retry: paksa gagal → item mundur backoff → habis percobaan → `failed` + `last_error`, retry manual mengembalikan ke `pending`.
- Uji idempotency dispatcher: kirim ulang batch → efek tak berganda.
- `bun run check` hijau; OpenAPI/AsyncAPI sinkron; correlation ID muncul di log lintas hop.

## Skill terkait

`awcms-mini-new-endpoint` / `awcms-mini-new-event` (kontrak), `awcms-mini-sync-hmac` (signature), `awcms-mini-idempotency` (mutation), `awcms-mini-audit-log` (jejak), `awcms-mini-observability` (correlation ID, extension point), `awcms-mini-performance` (I/O di luar transaksi).

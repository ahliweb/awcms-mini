# Sync Storage

Implementasi Issue 6.1 (`docs/awcms-mini/06_github_issues_detail.md` §Issue 6.1 — Add Sync Outbox and Inbox), Issue 6.2 (§Issue 6.2 — Add Sync Conflict Tracking and Resolution), dan Issue 6.3 (§Issue 6.3 — Add R2 Object Sync Queue).

## Scope — Issue 6.1 (Outbox/Inbox)

- `awcms_mini_sync_nodes` — registrasi node sync per tenant (`node_code` unik per tenant), status active/inactive, checkpoint (`last_pull_sequence`), `last_pushed_at`/`last_pulled_at`.
- `awcms_mini_sync_outbox` — event lokal yang tersedia untuk di-pull node lain, `sequence` (identity, monoton) jadi cursor checkpoint.
- `awcms_mini_sync_inbox` — event yang diterima dari node lain via push, disimpan status `received` (belum ada modul domain untuk benar-benar "menerapkan" event-nya pada base ini).
- `awcms_mini_sync_push_batches` — ledger idempotency per `(tenant_id, node_id, batch_id)`; push dengan `batch_id` yang sama diulang dianggap sukses tanpa memroses ulang event.
- Endpoint `POST /api/v1/sync/push`, `POST /api/v1/sync/pull`, `GET /api/v1/sync/status`.

Skema ada di `sql/007_awcms_mini_sync_storage_outbox_inbox_schema.sql`.

## Scope — Issue 6.2 (Conflict Tracking)

- `awcms_mini_sync_aggregate_versions` — versi terakhir yang diketahui server untuk tiap `(aggregate_type, aggregate_id)`, dipakai evaluator konflik optimistic-concurrency generik (tidak butuh pengetahuan domain apa pun tentang aggregate-nya).
- `awcms_mini_sync_conflicts` — catatan konflik **immutable** (fakta inti — node, batch, aggregate, tipe konflik, payload — tidak pernah diubah setelah dibuat; hanya kolom resolusi yang diisi **sekali** saat resolve). Dua tipe konflik generik:
  - `missing_base_version` — aggregate sudah punya versi (`current_version > 0`) tapi event push tidak menyertakan `baseVersion` sama sekali.
  - `version_mismatch` — `baseVersion` yang dikirim tidak sama dengan versi server saat ini (ada perubahan lain yang lebih baru).
- `POST /sync/push` (diperbarui): event boleh menyertakan `baseVersion?: number` opsional; event yang konflik dicatat ke `sync_conflicts` (bukan `sync_inbox`) dan **tidak** memajukan versi aggregate. Response menambah field `conflicted`.
- `GET /sync/conflicts` (list, filter `?status=open|resolved`) dan `POST /sync/conflicts/{id}/resolve` (body `{ resolution: accept_incoming|keep_existing|manual, note? }`) — **beda dari endpoint sync lain**: keduanya **bearer-token** (session login), bukan HMAC, karena "conflict manual" (ADR-0006) berarti resolusi adalah keputusan manusia, bukan node. Di-guard permission `sync_storage.conflict_resolution.read`/`.approve` (diseed di migration ini). Resolve pada conflict yang sudah `resolved` ditolak `409` (resolusi tidak bisa diubah — bagian dari "immutable").

Skema ada di `sql/008_awcms_mini_sync_storage_conflict_schema.sql`.

## Scope — Issue 6.3 (R2 Object Sync Queue)

- `awcms_mini_object_sync_queue` — antrean objek lokal (mis. file receipt/lampiran) yang menunggu disinkronkan/di-upload ke object storage (R2 atau kompatibel). Unique `(tenant_id, node_id, object_key)` — re-enqueue `objectKey` yang sama **upsert** (bukan duplikat): `local_path`, `checksum_sha256`, `byte_size`, `requires_upload` diperbarui dan baris dikembalikan ke `status='pending'` dengan `retry_count`/`last_error`/`next_retry_at`/`uploaded_at` direset — karena secara efektif ini enqueue ulang yang segar. Index `(tenant_id, status, next_retry_at)` untuk pemindaian retry oleh calon dispatcher worker.
- `requires_upload` diisi dari env var `R2_ENABLED` saat enqueue: `R2_ENABLED=true` → objek **memang butuh** di-upload ke object storage; `R2_ENABLED=false` (default) → objek tetap diantre (dicatat sebagai fakta lokal/checksum) tapi tidak menandai kebutuhan upload nyata. **Tidak ada pemanggilan R2/Cloudflare SDK atau HTTP request eksternal di base ini** — sama seperti `awcms_mini_message_outbox` (WA/email) yang juga belum punya dispatcher live, `R2_ENABLED` di sini hanya flag data, bukan trigger jaringan (ADR-0006: provider eksternal opsional, tidak boleh jadi dependency alur kritikal).
- Endpoint `POST /api/v1/sync/objects` — body `{ objects: [{ objectKey, localPath, checksumSha256, byteSize }] }` (array, seperti `events` pada push), upsert per objek, response `{ queued: <count> }`.
- Endpoint `GET /api/v1/sync/objects/status` — entri antrean milik node pemanggil yang **belum** `sent` (`pending`+`failed`), limit 100, urut `created_at`, field `objectKey, status, retryCount, nextRetryAt, lastError, byteSize, requiresUpload`.
- Domain logic murni baru di `domain/object-queue.ts`: `verifyObjectChecksum` (pure string equality — checksum bukan secret, tidak perlu timing-safe compare), `evaluateObjectRetry` (backoff eksponensial `2^retryCount` menit, dibatasi `OBJECT_SYNC_MAX_RETRY_DELAY_MINUTES=60`, tidak lagi eligible begitu `retryCount >= OBJECT_SYNC_MAX_RETRIES=5`), dan `validateObjectSyncEnqueueRequestBody` (pola `ValidationError`/discriminated union sama seperti `sync-validation.ts`).

Skema ada di `sql/009_awcms_mini_object_sync_queue_schema.sql`.

## Domain logic

`domain/sync-hmac.ts` (pure, murni) — `computeSyncSignature` (`HMAC-SHA256("<timestamp>.<body>")`, sesuai skill `awcms-mini-sync-hmac`/doc 10 §Sync HMAC standard), `verifySyncSignature` (timing-safe compare via `node:crypto.timingSafeEqual`), `isTimestampWithinSkew` (anti-replay, default maksimum skew 300 detik — `AWCMS_MINI_SYNC_MAX_SKEW_SEC`).

`domain/sync-conflict.ts` (pure, murni) — `evaluatePushEventConflict(currentVersion, baseVersion)`: default deny berbasis versi, generik untuk aggregate apa pun.

Endpoint melakukan I/O: baca body **mentah** (`request.text()`, bukan `.json()`) agar signature bisa diverifikasi persis sebelum di-parse, cek node aktif, cek idempotency batch, lalu tulis DB.

## Autentikasi berbeda dari endpoint lain

Endpoint sync **tidak** memakai bearer token/session — ini komunikasi node-ke-server (machine-to-machine), bukan user login. Autentikasi memakai HMAC (`X-AWCMS-Mini-Node-ID`, `X-AWCMS-Mini-Timestamp`, `X-AWCMS-Mini-Signature`) dengan secret tunggal dari environment (`AWCMS_MINI_SYNC_HMAC_SECRET`) — bukan secret per-node, sesuai `.env.example` (satu secret untuk seluruh deployment). Header `X-AWCMS-Mini-Tenant-ID` tetap wajib untuk isolasi tenant.

Endpoint menolak (403) jika `AWCMS_MINI_SYNC_ENABLED` bukan `true` — mengaktifkan env var yang sudah ada di `.env.example` sejak Issue 0.1 namun belum pernah benar-benar dibaca kode.

Pengecualian: `GET /sync/conflicts` dan `POST /sync/conflicts/{id}/resolve` memakai bearer token (lihat §Issue 6.2 di atas) — bukan HMAC, karena ini endpoint untuk manusia, bukan node.

## Belum tersedia

- **Dispatcher upload R2 nyata** (backlog): tidak ada endpoint publik untuk menandai entri `awcms_mini_object_sync_queue` sebagai `sent`/`failed` pada tahap ini — sengaja tidak dibuat karena belum ada worker dispatcher yang benar-benar memanggil R2/Cloudflare. Saat worker tersebut dibangun (aplikasi turunan atau issue lanjutan), ia semestinya memanggil **fungsi aplikasi internal langsung** (bukan endpoint HTTP publik) untuk mengunci baris, mencoba upload di luar transaction DB (ADR-0006), lalu meng-update `status`/`uploaded_at`/`retry_count`/`next_retry_at`/`last_error` — karena hanya worker internal terpercaya yang boleh melakukan aksi ini, bukan node sync mana pun.
- Audit event terpisah untuk resolusi konflik (belum ada tabel `audit_events` umum — jejak resolusi saat ini melekat pada baris `sync_conflicts` itu sendiri).
- Penerapan otomatis event `awcms_mini_sync_inbox` ke tabel domain (base tidak punya modul domain untuk diterapkan — event tetap `received`, aplikasi turunan yang memprosesnya).

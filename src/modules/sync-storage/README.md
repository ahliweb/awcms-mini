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

Pengecualian: `GET /sync/conflicts` dan `POST /sync/conflicts/{id}/resolve` memakai bearer token **atau** cookie SSR (lihat §Sync admin ops dashboard di bawah) — bukan HMAC, karena ini endpoint untuk manusia, bukan node.

## Sync admin ops dashboard

Layar admin `/admin/sync` dan endpoint pendukungnya — sebelumnya konflik adalah satu-satunya aksi manusia; sekarang node dan antrean objek juga punya kontrol admin, plus gap audit yang lama tercatat di "Belum tersedia" sudah ditutup.

- `GET /api/v1/sync/nodes` + `PATCH /api/v1/sync/nodes/{id}` (bearer/cookie, bukan HMAC) — daftar node dan aktifkan/nonaktifkan/ganti nama. Menonaktifkan berlaku **langsung**: setiap endpoint HMAC (`/sync/push`, `/sync/pull`, `/sync/status`, `/sync/objects*`) sudah menolak `node.status !== "active"` dengan `403` — dua permission baru `sync_storage.node_management.{read,update}` diseed di `sql/014_awcms_mini_sync_node_management_permission_schema.sql` (tidak ada perubahan schema, tabel `awcms_mini_sync_nodes` migrasi 007 sudah punya kolom yang dibutuhkan).
- `GET /api/v1/sync/object-queue` (filter `?status=pending|sent|failed`, keyset pagination opsional `?cursor=`/`nextCursor` — Issue #435, `src/modules/_shared/keyset-pagination.ts`) — tampilan tenant-wide (semua node) untuk admin, beda dari `GET /sync/objects/status` yang HMAC dan hanya menampilkan milik satu node pemanggil. Guard `sync_storage.object_queue.read` (sudah diseed sejak migrasi 009). `fetchObjectQueueEntries` (`application/sync-directory.ts`) menerapkan `LIMIT` di dalam subquery sebelum join ke `awcms_mini_sync_nodes`, bukan sort+limit atas hasil join — perbaikan performa Issue #435 (query planner salah mengestimasi baris hasil join, memilih Seq Scan+sort walau index yang benar tersedia; lihat komentar di fungsi tersebut).
- `POST /api/v1/sync/object-queue/{id}/retry` — override manual atas jadwal backoff otomatis (`evaluateObjectRetry` di `domain/object-queue.ts`, tetap dipakai loop retry node sendiri): reset `retry_count`/`next_retry_at`/`last_error` dan `status` kembali ke `pending`, termasuk melewati `OBJECT_SYNC_MAX_RETRIES` — untuk kasus admin sudah memperbaiki masalah (mis. rotasi kredensial storage) dan ingin node mencoba lagi segera. Hanya entri `failed` yang eligible (`pending`/`sent` ditolak `409`). Guard `sync_storage.object_queue.retry` (sudah diseed sejak migrasi 009, sebelumnya belum ada konsumen) — memerlukan penambahan action `"retry"` ke union `AccessAction` (`domain/access-control.ts`, pola yang sama seperti Issue 10.1 menambah `restore`/`purge`); **bukan** high-risk (`isHighRiskAction("retry") === false`) karena ini nudge terhadap jadwal otomatis, bukan aksi destruktif seperti delete/approve/export — tetap diaudit eksplisit terlepas dari klasifikasi itu.
- **Audit event resolusi konflik** (menutup gap "Belum tersedia" di bawah yang sudah usang): `POST /sync/conflicts/{id}/resolve` kini juga memanggil `recordAuditEvent` (`resourceType: "sync_conflict"`, `action: "approve"`) — sebelumnya jejak resolusi hanya melekat di baris `sync_conflicts` itu sendiri, tidak pernah masuk `awcms_mini_audit_events` walau tabel itu sudah ada sejak Issue 10.1.
- Endpoint `/sync/conflicts` dan `/sync/conflicts/{id}/resolve` di-refactor memakai `resolveAuthInputs`/`authorizeInTransaction` (`identity-access/application/access-guard.ts`, dipusatkan sejak PR Access & Users) sehingga kini juga menerima cookie SSR, bukan cuma bearer header — inilah yang memungkinkan `/admin/sync` memanggilnya langsung.
- Ringkasan (`Ringkasan`) di halaman admin memakai ulang `fetchSyncHealthReport` (Issue 9.1) — agregasi yang sama persis dengan kartu dashboard `admin/index.astro` dan `GET /reports/sync-health`, tidak ada query hitung duplikat.

## Dispatcher — Issue #436 (kerasan backend & integrasi eksternal)

Menutup gap "dispatcher upload R2 nyata" di atas. **Fungsi internal, bukan endpoint HTTP publik** — hanya worker terpercaya yang boleh menandai `awcms_mini_object_sync_queue` sebagai `sent`/`failed`, bukan node sync mana pun (sama seperti sebelumnya, hanya sekarang ada implementasinya).

- `src/modules/sync-storage/application/object-dispatch.ts` — `dispatchObjectSyncQueue(sql, tenantId, options?)`, dipanggil per tenant. Pola tiga fase wajib oleh ADR-0006 ("jangan panggil provider di dalam transaction"):
  1. **CLAIM** — satu transaction pendek memindahkan baris `pending` yang jatuh tempo ke status transien `sending` (`FOR UPDATE SKIP LOCKED`, migrasi 018 menambah `sending` ke `CHECK` constraint status). Reuse kolom `next_retry_at` yang sudah ada sebagai "lease expiry" selama `sending` (tidak ada kolom baru) — bila proses crash di tengah, baris otomatis bisa diklaim ulang oleh pass berikutnya begitu lease kedaluwarsa.
  2. **UPLOAD** — di luar transaction apa pun, memanggil `ObjectUploader` yang di-resolve dari `requires_upload` milik baris (`src/modules/sync-storage/infrastructure/object-storage-uploader.ts`): `createNoopObjectUploader` (requires_upload=false — R2 off/STORAGE_DRIVER=local, tidak ada jaringan/I/O sama sekali, selalu sukses) atau `createR2ObjectUploader` (requires_upload=true — upload nyata lewat `Bun.S3Client` native Bun, tanpa SDK npm; memverifikasi checksum lokal aktual sebelum upload — pemanggil nyata pertama `verifyObjectChecksum`).
  3. **FINALIZE** — transaction pendek kedua per baris: sukses → `sent`+`uploaded_at`; gagal → `evaluateObjectRetry` (`domain/object-queue.ts`, di-reuse verbatim, tidak diduplikasi) menentukan `pending`+backoff atau `failed`+`last_error` setelah `OBJECT_SYNC_MAX_RETRIES` habis.
  - **Idempotent secara alami**: baris `sent`/`failed` tidak pernah diklaim ulang; kunci upload (`objectKey`) sendiri adalah dedup key alami (PUT S3/R2 ke key yang sama adalah overwrite, bukan duplikat) — tidak perlu ledger batch terpisah untuk upload objek (beda dari `awcms_mini_sync_push_batches` yang memang perlu ledger karena penerapan event bukan overwrite-idempotent).
  - **Circuit breaker per-provider** (`getProviderCircuitBreaker("object-storage")`, `src/lib/database/circuit-breaker.ts` — breaker generik yang tadinya hanya untuk database kini jadi registry per-provider-key): saat breaker terbuka, baris `requires_upload=true` tidak diklaim sama sekali pada pass tersebut (tetap `pending`, tak tersentuh); baris `requires_upload=false` tetap jalan karena tak pernah menyentuh provider.
  - **Timeout** setiap panggilan upload (`src/lib/integration/timeout.ts`, `withTimeout`, default `OBJECT_SYNC_UPLOAD_TIMEOUT_MS=10000`).
  - **Observability**: `correlationId` (opsional, di-generate bila tak diberikan) diteruskan ke setiap baris log terstruktur (`sync_storage.object_dispatch.claimed/sent/retry_scheduled/failed`) lewat `src/lib/logging/logger.ts` — sudah meredaksi field sensitif secara otomatis (`_shared/redaction.ts`), pesan error dari provider dipotong ke 500 karakter sebelum disimpan sebagai `last_error`.
- `scripts/object-sync-dispatch.ts` (`bun run sync:objects:dispatch`) — entrypoint CLI terjadwal (cron/systemd timer/k8s CronJob), **bukan** endpoint HTTP. Mengiterasi setiap tenant `active` (tabel `awcms_mini_tenants` tidak ber-RLS — tabel root, bukan data tenant-scoped) dan menguras backlog setiap tenant per batch sampai satu pass tidak mengklaim apa pun.
- Endpoint/AsyncAPI: **tidak ada kontrak baru** — dispatcher murni internal (tidak ada request/response HTTP baru, tidak ada event domain baru dipublikasikan), jadi OpenAPI/AsyncAPI baseline tidak berubah untuk issue ini.

## Belum tersedia

- Penerapan otomatis event `awcms_mini_sync_inbox` ke tabel domain (base tidak punya modul domain untuk diterapkan — event tetap `received`, aplikasi turunan yang memprosesnya).

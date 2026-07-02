# Database Concurrency & Race Condition Prevention

Standar pencegahan race condition PostgreSQL untuk AWCMS Mini (#360).

Transaksi database saja **tidak selalu cukup**. Pada isolation level default
PostgreSQL (`READ COMMITTED`), pola berikut tetap rawan _race condition_:

```sql
SELECT ...;            -- baca state
-- hitung / validasi di aplikasi
UPDATE ...;            -- tulis berdasarkan state lama
```

Dua request/worker paralel bisa membaca state yang sama lalu saling menimpa —
menghasilkan **lost update**, **duplicate numbering**, **double processing**,
**double approval**, atau state yang tidak konsisten.

Dokumen ini menetapkan pola aman dan helper yang wajib dipakai di service layer.

## Ringkas: pilih pola sesuai kebutuhan

| Kebutuhan                                          | Pola aman                                   |
| -------------------------------------------------- | ------------------------------------------- |
| Counter / kuota / stok / limit                     | Atomic update (`SET x = x + n WHERE ...`)   |
| Create-if-not-exists / slug unik                   | Unique constraint + `ON CONFLICT` (UPSERT)  |
| Update butuh validasi kompleks pada satu baris     | `SELECT ... FOR UPDATE`                     |
| Transisi status (pending → approved)               | Guarded update (expected status di `WHERE`) |
| Penomoran dokumen / provisioning / resource logis  | Advisory lock transaksional                 |
| Invariant lintas beberapa baris/tabel              | `SERIALIZABLE` + retry                      |
| Request berulang (order / API eksternal / webhook) | Idempotency key                             |

## Pola yang dilarang / wajib direview

- `SELECT` → logika aplikasi → `UPDATE` **tanpa** lock atau atomic update.
- Penomoran dengan `MAX(number) + 1` (rawan duplikat).
- "Cek dulu lalu insert" tanpa unique constraint (rawan duplikat baris).

## 1. Atomic update (paling disukai)

Biarkan PostgreSQL yang menghitung dan memvalidasi dalam satu statement. Tidak
butuh lock eksplisit.

```sql
UPDATE quotas
SET used = used + $1
WHERE id = $2
  AND used + $1 <= limit_value
RETURNING id, used, limit_value;
```

Bila `RETURNING` kosong, batas terlampaui — tangani sebagai kegagalan bisnis.

## 2. Guarded status transition

Sertakan status yang diharapkan di `WHERE` agar hanya satu penulis yang menang.

```sql
UPDATE records
SET status = 'approved', updated_at = now()
WHERE id = $1
  AND status = 'pending'
RETURNING id;
```

Bila tidak ada baris terpengaruh, seseorang sudah mengubah status lebih dulu —
tolak sebagai konflik, jangan proses ulang.

## 3. Unique constraint + UPSERT

```sql
CREATE UNIQUE INDEX cms_entries_slug_unique ON cms_entries (site_id, slug);
```

```sql
INSERT INTO cms_entries (site_id, slug, title)
VALUES ($1, $2, $3)
ON CONFLICT (site_id, slug)
DO UPDATE SET title = EXCLUDED.title
RETURNING id, site_id, slug, title;
```

## 4. Row-level lock untuk validasi kompleks

Bila logika terlalu kompleks untuk satu atomic update, kunci barisnya lebih dulu
di dalam transaksi. Lock dilepas otomatis saat commit/rollback.

```js
import { getDatabase, withTransaction } from "../db/index.mjs";

await withTransaction(getDatabase(), async (trx) => {
  const record = await trx
    .selectFrom("records")
    .selectAll()
    .where("id", "=", id)
    .forUpdate()
    .executeTakeFirstOrThrow();

  // validasi kompleks di service layer ...

  await trx
    .updateTable("records")
    .set({ status: "approved" })
    .where("id", "=", id)
    .where("status", "=", "pending")
    .execute();
});
```

## 5. Advisory lock untuk resource logis

Untuk resource yang tidak dipetakan 1:1 ke satu baris (penomoran dokumen per
tahun, provisioning domain/order). Gunakan advisory lock **transaksional**
(`pg_advisory_xact_lock`) — otomatis dilepas saat transaksi selesai.

```js
import {
  getDatabase,
  withTransaction,
  buildAdvisoryLockKey,
  withAdvisoryXactLock,
} from "../db/index.mjs";

await withTransaction(getDatabase(), async (trx) => {
  const key = buildAdvisoryLockKey(
    "awcms-mini:numbering",
    `${year}:${docType}`,
  );

  return withAdvisoryXactLock(trx, key, async () => {
    const next = await trx
      .updateTable("numbering_sequences")
      .set((eb) => ({ last_number: eb("last_number", "+", 1) }))
      .where("year", "=", year)
      .where("document_type", "=", docType)
      .returning("last_number")
      .executeTakeFirstOrThrow();

    return next.last_number;
  });
});
```

## 6. SERIALIZABLE + retry untuk invariant kompleks

Bila aturan bisnis bergantung pada konsistensi beberapa baris/tabel yang tidak
bisa diekspresikan sebagai satu atomic update, jalankan di transaksi
`SERIALIZABLE`. PostgreSQL dapat menolak dengan SQLSTATE `40001`
(`serialization_failure`) atau `40P01` (`deadlock_detected`); helper akan
me-retry transaksi secara utuh.

```js
import { getDatabase, withSerializableRetry } from "../db/index.mjs";

const result = await withSerializableRetry(getDatabase(), async (trx) => {
  // baca beberapa baris/tabel, hitung invariant, lalu tulis.
  // JANGAN lakukan side-effect non-transaksional (email, HTTP) di sini —
  // callback bisa dijalankan ulang.
  return doWork(trx);
});
```

Retry default = 3 kali. Sediakan `onRetry` untuk logging/metrik bila perlu.

## 7. Idempotency key

Untuk request penting yang bisa terkirim ganda (order, provisioning, webhook,
panggilan API eksternal), simpan idempotency key unik dan tolak/replay bila
sudah ada. Tabel `idempotency_records` (migrasi `038_idempotency_records`)
menyediakan penyimpanannya.

## Helper referensi (`src/db/concurrency.mjs`)

| Export                    | Fungsi                                                            |
| ------------------------- | ----------------------------------------------------------------- |
| `withSerializableRetry`   | Transaksi `SERIALIZABLE` dengan retry pada 40001/40P01.           |
| `withAdvisoryXactLock`    | Ambil advisory lock transaksional lalu jalankan callback.         |
| `acquireAdvisoryXactLock` | Ambil advisory lock saja (di dalam transaksi aktif).              |
| `buildAdvisoryLockKey`    | Bangun kunci lock deterministik dari namespace + id.              |
| `isSerializationFailure`  | Deteksi error transient (40001/40P01) untuk logika retry sendiri. |

Semua di-_re-export_ dari `src/db/index.mjs`.

## Audit log

Operasi sensitif yang dilindungi dari race condition (approval, transisi status,
penomoran, provisioning) **wajib** menulis audit log melalui
`src/services/audit/service.mjs` di dalam transaksi yang sama agar jejaknya
konsisten dengan hasil write.

## Testing

- **Unit**: orkestrasi helper (retry, guard, deteksi SQLSTATE) diuji tanpa DB
  nyata di `tests/unit/db-concurrency.test.mjs`.
- **Concurrent integration**: kasus paling kritikal (numbering, approval, kuota)
  wajib punya test yang menjalankan ≥2 transaksi paralel terhadap PostgreSQL
  nyata dan mengassert tidak ada lost update / duplikat. Test integrasi ini
  dipisah dari unit test (butuh `DATABASE_URL`).

## Referensi

- Issue #360 — PostgreSQL concurrency controls.
- `docs/architecture/database-access.md` — pooler & transport DB.
- `docs/security/security-baseline.md` — baseline keamanan.

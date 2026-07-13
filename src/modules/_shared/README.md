# Shared Module Foundation

Folder ini berisi kontrak lintas-modul yang boleh dipakai semua modul AWCMS-Mini.

## Module Contract

Setiap modul wajib mendeklarasikan `ModuleDescriptor` dari `module-contract.ts`, lalu mendaftarkannya lewat `src/modules/index.ts`.

## API Response

Endpoint REST memakai helper dari `api-response.ts` agar response konsisten:

- sukses: `{ success: true, data, meta }`
- gagal: `{ success: false, error: { code, message, details? }, meta }`

## Idempotency Store

`idempotency.ts` backs `awcms_mini_idempotency_keys` (migration 012) for every high-risk mutation endpoint that requires `Idempotency-Key` (doc 10, skill `awcms-mini-idempotency`). `saveIdempotencyRecord` uses `INSERT ... ON CONFLICT (tenant_id, request_scope, idempotency_key) DO NOTHING RETURNING id` — two parallel requests can both pass `findIdempotencyRecord` under READ COMMITTED before either commits, and only one may win the unique index. On losing the race it re-`SELECT`s the now-committed winning row and compares `request_hash`: identical payload → throws `IdempotencyRaceLostError` carrying the winner's response to replay (honoring the ordinary "same hash → replay" rule even under the race); different payload → throws it with no replay (genuine conflict). `withTenant` (`src/lib/database/tenant-context.ts`) catches this error at the one chokepoint every caller already goes through: it rolls back the loser's transaction (so its mutation never persists), skips the circuit breaker (benign concurrency, not an infra failure), logs `idempotency.race_lost` (SHA-256 hash of the key, never the raw value), and returns either the replayed response or a clean `409 IDEMPOTENCY_CONFLICT` — never a raw constraint error — without touching the ~25 individual route files.

## Capability Ports

Untuk kapabilitas yang genuinely dipakai lintas-modul tapi TIDAK boleh jadi
cross-module `application`/`domain` import langsung (lihat
`docs/adr/0011-capability-ports-for-cross-module-collaboration.md`),
AWCMS-Mini memakai pola ports-and-adapters minimal — bukan DI framework,
murni parameter fungsi biasa:

- **Port** — interface TypeScript murni di `src/modules/_shared/ports/*.ts`,
  tidak meng-import apa pun dari modul manapun (netral).
- **Adapter** — implementasi konkret satu port, hidup di modul PEMILIK
  kapabilitas itu sendiri (mis. `news-portal/application/news-media-port-adapter.ts`).
  Modul lain tidak pernah meng-import file adapter modul lain secara langsung.
- **Composition root** — route handler (`src/pages/api/v1/**`, dst.) yang
  meng-import adapter konkret dan menyuntikkannya sebagai parameter fungsi
  biasa ke kode `application` modul lain yang membutuhkan kapabilitas itu.

Tiga port nyata saat ini:

- **`ports/news-media-port.ts` — `NewsMediaPort`** — kapabilitas milik
  `news_portal`, dikonsumsi `blog_content`: cek apakah mode full-online
  R2-only aktif untuk tenant, validasi sebuah referensi media aman
  (same-tenant, verified), dan resolve id media ke URL publik/alt text.
- **`ports/public-content-port.ts` — `PublicContentPort`** — kapabilitas
  milik `blog_content`, dikonsumsi `news_portal`: query post/kategori
  publik read-only (existence check, ringkasan post by id, kategori by
  slug, listing post terbaru) untuk homepage section composer.
- **`ports/social-publishing-port.ts` — `SocialPublishingPort`** —
  kapabilitas milik `social_publishing`, dikonsumsi `blog_content` secara
  opsional (no-op aman — `{ jobsCreated: 0 }` — bila `social_publishing`
  tidak aktif untuk deployment tersebut): `onArticlePublished` membuat
  outbox job untuk setiap rule/akun yang cocok saat sebuah artikel
  published, murni tulis DB dalam transaksi milik caller (ADR-0006
  compliant — publish sungguhan ke provider terjadi belakangan, di luar
  transaksi, lewat dispatcher `social_publishing`).

`ModuleDescriptor` (`module-contract.ts`) punya field opsional
`capabilities?: ModuleCapabilityContract` (`{ provides?: string[],
consumes?: ModuleCapabilityDependency[] }`) untuk mendokumentasikan
hubungan port ini secara terstruktur — `provides` menyebut nama kapabilitas
yang modul ini sediakan adapternya (cocok dengan sebuah port di atas),
`consumes` menyebut kapabilitas modul lain yang dipakai (`providedBy` +
`optional` bila modul penyedia boleh tidak aktif untuk tenant/deployment
tertentu). Field ini sengaja TERPISAH dari `dependencies` (yang murni
mengatur urutan enable/disable lifecycle, dicek
`domain/tenant-module-lifecycle.ts`) — sebuah modul bisa mengonsumsi
kapabilitas modul lain tanpa mendeklarasikan `dependencies` ke sana (kasus
nyata `blog_content`/`news_portal`, keputusan Issue #632 yang masih
berlaku). Diverifikasi otomatis oleh `tests/unit/module-boundary.test.ts`,
yang men-scan `application`/`domain` tree tiap modul untuk import langsung
ke tree modul lain dan gagal loud bila ditemukan — bukan sekadar
didokumentasikan dan dipercaya secara manual.

Rasional desain lengkap (konteks, alternatif yang ditolak, trade-off):
`docs/adr/0011-capability-ports-for-cross-module-collaboration.md`.

## Soft Delete Convention

Resource master/config/draft yang bisa dihapus wajib memakai kolom:

- `deleted_at`
- `deleted_by`
- `delete_reason`

Query list/detail default harus menyaring `deleted_at IS NULL`. Akses arsip, restore, dan purge harus memakai permission eksplisit dan audit log. Helper awal tersedia di `soft-delete.ts`; repository spesifik modul tetap wajib memakai query terparametrisasi dan RLS sesuai doc 10/16.

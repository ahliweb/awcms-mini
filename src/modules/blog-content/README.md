# Blog Content

Implementasi Issue #537, #538, #539, #540, dan #541 (epic #536 — `blog_content`, `docs/adr/0009-public-tenant-scoped-routes.md`). **Modul domain pertama yang didaftarkan langsung di repo base ini** — sebelumnya `AGENTS.md` §Peta modul hanya mendaftarkan modul base generik; lihat catatan di sana untuk konteks.

## Scope per issue

Issue #537: module descriptor, domain validation, application placeholder read-only, dan schema database (migration 026/027) — lihat §Tabel dan §Permission seed.

Issue #538: API admin CRUD + lifecycle untuk blog post di `/api/v1/blog/posts` (lihat §Admin API — Blog Posts).

Issue #539: API admin CRUD untuk halaman statis (`/api/v1/blog/pages`, lihat §Admin API — Blog Pages), kategori/tag (`/api/v1/blog/terms`, lihat §Admin API — Blog Taxonomies), post-term relation assignment (lewat `termIds` di payload post, lihat §Post-term relation handling), dan PostgreSQL full-text search (`/api/v1/blog/search` admin + helper public-safe, lihat §Search). Migration `028` mengubah `search_vector` menjadi `GENERATED ALWAYS ... STORED`.

Issue #540: rute publik anonim (tanpa sesi) di bawah `/blog/{tenantCode}/...` sesuai ADR-0009 — index, detail post, arsip kategori/tag, search, RSS feed, dan sitemap. Lihat §Public routes.

Issue #541: revision history append-only untuk post/page, restore revisi (permission eksplisit + Idempotency-Key), scheduled-publishing job (`bun run blog:publish:scheduled`), dan kontrak AsyncAPI domain event penuh untuk lifecycle modul ini. Lihat §Revisions dan §Scheduled publishing.

Presentation extensions (#542) dan admin UI (#543) masih backlog — lihat §Belum tersedia.

## Tabel (migration `026_awcms_mini_blog_content_schema.sql`)

Tujuh tabel persis sesuai doc issue #537 §Database Tables, semuanya tenant-scoped (`ENABLE` + `FORCE ROW LEVEL SECURITY`, satu policy `tenant_isolation` per tabel):

1. **`awcms_mini_blog_posts`** — `status`: `draft → review → scheduled → published → archived` (`domain/post-status.ts` `isValidStatusTransition`), `visibility`: `public | private | unlisted`. Slug unik per `(tenant_id, locale)` selama `deleted_at IS NULL` (partial unique index). `search_vector tsvector` — sejak migration `028` (Issue #539) kolom ini `GENERATED ALWAYS ... STORED` (weighted `title` 'A' / `excerpt` 'B' / `content_text` 'C', text search config `simple`), PostgreSQL sendiri yang menjaganya tetap sinkron; index GIN tetap ada.
2. **`awcms_mini_blog_pages`** — struktur core sama seperti posts (termasuk `search_vector` generated STORED yang sama sejak migration `028`), plus `page_type` (`standard | landing | legal | system`), `parent_page_id` (self-FK), `menu_order`.
3. **`awcms_mini_blog_terms`** — kategori (`taxonomy_type = 'category'`, boleh `parent_id`) dan tag (`taxonomy_type = 'tag'`, `CHECK` menolak `parent_id` — lihat juga `domain/taxonomy-policy.ts` untuk cek pre-insert di level aplikasi). Slug unik per `(tenant_id, taxonomy_type)`.
4. **`awcms_mini_blog_post_terms`** — relasi many-to-many post↔term, tetap membawa `tenant_id` sendiri (bukan hanya lewat FK) supaya RLS bisa langsung mengisolasi baris join ini, konvensi yang sama seperti tabel relasi lain di base ini.
5. **`awcms_mini_blog_revisions`** — **append-only**, tidak pernah di-`UPDATE` aplikasi (pola sama seperti `awcms_mini_workflow_decisions`/`awcms_mini_audit_events`). "Restore revisi" berarti membuat revisi baru berisi konten lama, bukan menimpa baris manapun — jalur kode restore-nya diimplementasikan Issue #541, lihat §Revisions. Tidak ada kolom `slug`.
6. **`awcms_mini_blog_redirects`** — soft-deletable (bukan append-only), unik per `(tenant_id, from_path)` selama aktif.
7. **`awcms_mini_blog_settings`** — satu baris per tenant, `tenant_id` sendiri jadi primary key (pola sama seperti `awcms_mini_tenant_settings`, migration 002), bukan soft-deletable (dikonfigurasi, bukan dihapus).

Tidak ada `GRANT` eksplisit ke `awcms_mini_app` di migration 026 — migration 013 sudah memasang `ALTER DEFAULT PRIVILEGES` yang otomatis meng-grant tabel baru apa pun yang dibuat role pemilik (dipakai ulang oleh migration 025 untuk alasan yang sama).

## Permission seed (migration `027_awcms_mini_blog_content_permissions.sql`)

26 permission persis sesuai doc issue #537 §Permission Seed (`blog_content.posts.*`, `.pages.*`, `.taxonomies.*`, `.revisions.*`, `.settings.*`, `.seo.configure`, `.search.read`). Tidak ada role grant implisit — hanya assignable lewat Access & Users yang sudah ada.

## Domain validation (`domain/`)

- `content-validation.ts` — `validateBlogContentCore`: field inti yang dipakai bersama post & page (`title`, `slug`, `excerpt`, `contentJson`, `contentText`, `locale`), plus field-level validator individual (`validateTitleField`, dst.) yang dipakai ulang oleh partial-update page/post, dan `validateDeleteReasonInput` (`{ reason: string }`) dipakai ulang oleh soft-delete post/page/term.
- `post-status.ts` — enum status/visibility + `isValidStatusTransition` (satu sumber kebenaran dipakai ulang oleh endpoint lifecycle Issue #538 dan scheduled-publishing Issue #541), plus `canRestorePost`/`canPurgePost`.
- `page-type.ts` (Issue #539) — enum `PageType` (`standard | landing | legal | system`) + `isPageType`.
- `slug-policy.ts` — `isValidSlug` (format) + `slugify` (derivasi dari title; pemanggil tetap wajib cek keunikan sendiri).
- `seo-validation.ts` — `validateSeoFields` (`seoTitle` ≤70 char, `metaDescription` ≤160 char, `canonicalUrl` harus URL http(s) absolut).
- `taxonomy-policy.ts` — `validateTermParent` (tag tidak boleh punya parent, term tidak boleh jadi parent dirinya sendiri) — pre-check aplikasi sebelum constraint DB `awcms_mini_blog_terms_tag_no_parent_check` tersentuh.
- `content-access-policy.ts` (Issue #539) — `evaluateContentUpdateAccess`, generic ABAC ownership override (lihat §ABAC di bawah) diekstrak dari `post-access-policy.ts` Issue #538 supaya `page-access-policy.ts` bisa memakai ulang logic yang sama persis, bukan duplikat. `post-access-policy.ts`/`page-access-policy.ts` sekarang jadi thin wrapper yang mengunci `updateGuard` masing-masing (`blog_content.posts.update` / `.pages.update`).
- `blog-post-validation.ts` — `validateCreateBlogPostInput`/`validateUpdateBlogPostInput`/`validateScheduleBlogPostInput`/`validateSoftDeleteBlogPostInput`. Issue #539 menambah `termIds?: string[]` (validasi bentuk saja — array UUID, dedup; eksistensi per-tenant dicek di application layer).
- `blog-page-validation.ts` (Issue #539) — sama strukturnya seperti `blog-post-validation.ts`, plus `pageType`/`parentPageId` (menolak diri sendiri sebagai parent)/`menuOrder` (integer ≥0).
- `blog-term-validation.ts` (Issue #539) — `validateCreateBlogTermInput`/`validateUpdateBlogTermInput`/`validateSoftDeleteBlogTermInput`. Update tidak bisa mengecek ulang aturan tag-tanpa-parent terhadap baris yang sudah ada (validator murni, tidak query DB) — endpoint (`PATCH /api/v1/blog/terms/{id}`) yang menggabungkan field baru dengan baris existing sebelum memanggil `validateTermParent` lagi.

## Application (`application/`)

- `blog-post-directory.ts` — dulu (Issue #537) hanya placeholder read-only; Issue #538 melengkapinya dengan seluruh mutation post (`createBlogPost`, `updateBlogPost`, `softDeleteBlogPost`, `transitionBlogPostStatus`, `restoreBlogPost`, `purgeBlogPost`) di file yang sama — konvensi "satu directory, baca+tulis" yang sama seperti `email/application/email-template-directory.ts`, bukan dipecah jadi file service terpisah. `version` (kolom integer di schema #537) di-increment tiap `updateBlogPost`/`transitionBlogPostStatus` sukses — penanda perubahan monoton saja, **belum** ada optimistic-concurrency check (If-Match/expected-version) yang membacanya.
- `blog-page-directory.ts` (Issue #539) — struktur identik `blog-post-directory.ts` (`createBlogPage`, `fetchBlogPageById`, `listBlogPages`, `updateBlogPage`, `softDeleteBlogPage`), **tanpa** `transitionBlogPostStatus`/`restoreBlogPage`/`purgeBlogPage` — pages tidak punya lifecycle-action endpoint di issue ini (lihat §Admin API — Blog Pages).
- `blog-taxonomy-directory.ts` — dulu (Issue #537) hanya `fetchBlogTermsByTaxonomyType` placeholder; Issue #539 melengkapinya dengan CRUD term penuh (`createBlogTerm`, `fetchBlogTermById`, `listBlogTerms`, `updateBlogTerm`, `softDeleteBlogTerm`) plus fungsi relasi post-term (`syncPostTermAssignments`, `fetchPostTermIds`, `countExistingTerms`) — lihat §Post-term relation handling.
- `blog-search.ts` (Issue #539) — `searchBlogContentAdmin` (semua status, guard `search.read`) dan `searchPublicBlogContent` (predikat publik, helper murni — lihat §Search).
- `blog-revision-directory.ts` (Issue #541) — `createBlogRevision` (INSERT-only, `revision_number` = `MAX(...)+1` scoped ke `(tenant_id, resource_type, resource_id)`), `listBlogRevisions`, `fetchBlogRevisionById` (di-scope ke `resource_id` juga, bukan cuma `id` — revisionId dari post lain tidak bisa dibaca lewat URL post ini). Tidak ada fungsi update/delete di file ini sama sekali — lihat §Revisions.
- `blog-scheduled-publish.ts` (Issue #541) — `publishDueScheduledPosts`, satu `UPDATE` set-based per tenant, dipanggil `scripts/blog-scheduled-publish.ts` — lihat §Scheduled publishing.
- `domain/revision-policy.ts` (Issue #541) — `isSignificantContentChange` (true kalau `title`/`contentJson`/`contentText` ada di input update; field kosmetik seperti `seoTitle`/`canonicalUrl`/`slug` tidak memicu revisi baru).

## Admin API — Blog Posts (Issue #538)

`/api/v1/blog/posts` (`src/pages/api/v1/blog/posts/`), bearer session + `X-AWCMS-Mini-Tenant-ID`, pola identik endpoint lain di base ini (`resolveAuthInputs`/`extractBearerToken` → `authorizeInTransaction`/`evaluateAccess` → service → `recordAuditEvent` → `ok()`/`fail()`).

```txt
GET    /api/v1/blog/posts                    -> blog_content.posts.read
POST   /api/v1/blog/posts                     -> blog_content.posts.create
GET    /api/v1/blog/posts/{id}                -> blog_content.posts.read
PATCH  /api/v1/blog/posts/{id}                -> blog_content.posts.update (+ author-own-draft override, lihat di bawah)
DELETE /api/v1/blog/posts/{id}                -> blog_content.posts.delete
POST   /api/v1/blog/posts/{id}/submit-review  -> blog_content.posts.update (sama override)
POST   /api/v1/blog/posts/{id}/publish        -> blog_content.posts.publish (Idempotency-Key wajib)
POST   /api/v1/blog/posts/{id}/schedule       -> blog_content.posts.schedule (Idempotency-Key wajib)
POST   /api/v1/blog/posts/{id}/archive        -> blog_content.posts.archive (Idempotency-Key wajib)
POST   /api/v1/blog/posts/{id}/restore        -> blog_content.posts.restore (Idempotency-Key wajib)
POST   /api/v1/blog/posts/{id}/purge          -> blog_content.posts.purge (Idempotency-Key wajib)
```

### ABAC — author boleh edit draft sendiri tanpa permission `update`

Doc issue #538 §ABAC Rules menuntut dua hal sekaligus dari **satu** permission `blog_content.posts.update`: "Editor/Admin dengan permission boleh edit semua post tenant" **dan** "Author boleh edit draft sendiri walau belum published" (tanpa permission itu). `domain/content-access-policy.ts`'s `evaluateContentUpdateAccess` (logic generik, diekstrak di Issue #539 supaya pages memakai ulang) mengekspresikan ini sebagai OR: role permission (jalur "Editor/Admin") ATAU (pemanggil = `authorTenantUserId` DAN `status !== 'published'`) (jalur "Author"). `post-access-policy.ts`'s `evaluatePostUpdateAccess` dan `page-access-policy.ts`'s `evaluatePageUpdateAccess` adalah thin wrapper yang mengunci guard-nya ke `blog_content.posts.update`/`.pages.update`. Fungsi generiknya **sengaja tidak** ditaruh di `identity-access/domain/access-control.ts`'s `evaluateAccess` — itu evaluator lintas-modul yang deny-biased (ADR-0004 "default deny, deny overrides allow"); override ALLOW berbasis kepemilikan resource adalah business logic spesifik `blog_content`, disusun di atas `evaluateAccess` (memanggilnya dulu, baru fallback ke ownership check kalau satu-satunya alasan deny adalah `default_deny`), bukan primitive lintas-modul baru seperti `self_approval_deny` yang sudah ada.

Dipakai oleh `PATCH /api/v1/blog/posts/{id}`, `POST /api/v1/blog/posts/{id}/submit-review`, dan `PATCH /api/v1/blog/pages/{id}` (semua map ke permission `update`); endpoint lain (`publish`/`schedule`/`archive`/`restore`/`purge` untuk posts) TIDAK punya ownership override — cek permission murni via `authorizeInTransaction`, sesuai literal doc issue #538: "Author may not publish unless granted `blog_content.posts.publish`". Pages tidak punya lifecycle-action endpoint sama sekali di issue ini (lihat §Admin API — Blog Pages), jadi tidak ada pertanyaan ownership-override untuk publish/schedule/archive pages.

### `AccessAction` union diperluas: `publish`, `schedule`, `archive`

Sama seperti Issue 10.1 menambah `restore`/`purge` dan sync object-queue menambah `retry`, guard `posts.publish`/`.schedule`/`.archive` butuh tiga nilai baru di `identity-access/domain/access-control.ts`'s `AccessAction` union (lihat README modul itu). **Tidak** ditambahkan ke `HIGH_RISK_ACTIONS` (metadata dokumentatif, bukan gerbang) — endpoint-nya tetap memanggil `recordAuditEvent` eksplisit dan mewajibkan `Idempotency-Key` terlepas dari klasifikasi itu.

### Validasi status transition & purge/restore precondition

- Semua transisi status (submit-review/publish/schedule/archive) divalidasi via `isValidStatusTransition` (Issue #537) sebelum mutasi — transisi tidak sah → `409 INVALID_STATUS_TRANSITION`.
- `canPurgePost(status, deletedAt)` (baru di `post-status.ts`) — purge hanya boleh untuk post yang sudah `archived` atau sudah soft-deleted; selain itu → `409 PURGE_NOT_ALLOWED`.
- `canRestorePost(deletedAt)` — restore hanya untuk post yang sedang soft-deleted; selain itu → `404`.

### Sanitasi HTML

`domain/content-validation.ts`'s `validateContentJsonField`/`validateContentTextField` menolak (bukan men-sanitize) `<script>`, `<iframe>`, `<embed>`, `<object>`, atribut event-handler inline, dan URL `javascript:` — pola persis sama yang dipakai `email-template-validation.ts` (doc 20 §XSS).

### Idempotency & audit

`Idempotency-Key` wajib untuk `publish`/`schedule`/`archive`/`restore`/`purge` (scope: `blog_post_publish`/`blog_post_schedule`/`blog_post_archive`/`blog_post_restore`/`blog_post_purge`, tabel generik `awcms_mini_idempotency_keys`). `create`/`update` tidak mewajibkannya (direkomendasikan saja per doc issue #538) — retry `create` yang mengulang slug yang sama akan kena `409 SLUG_CONFLICT` dari partial unique index, sama seperti `POST /api/v1/email/templates`.

Audit `action` memakai string persis dari doc issue #538 §Audit Requirements (`blog.post.created`, `.updated`, `.submitted_for_review`, `.published`, `.scheduled`, `.archived`, `.deleted`, `.restored`, `.purged`) — bukan verb generik singkat (`create`/`update`) yang dipakai modul lain, karena issue ini eksplisit meminta identifier tersebut.

### Purge — pembersihan `post_terms`

`purgeBlogPost` menghapus baris `awcms_mini_blog_post_terms` milik post itu lebih dulu (metadata join murni, tidak berarti apa-apa begitu post-nya hilang) sebelum `DELETE` post-nya sendiri — **berbeda** dari pola `POST /api/v1/profiles/{id}/purge` yang menangkap foreign-key violation via savepoint, karena di sini kita sendiri yang memiliki kedua tabel dan tahu persis apa yang aman dihapus lebih dulu. `awcms_mini_blog_revisions` sengaja **tidak** disentuh (tidak ber-FK ke post, tetap jadi riwayat historis meski post-nya sudah purge).

## Admin API — Blog Pages (Issue #539)

`/api/v1/blog/pages` (`src/pages/api/v1/blog/pages/`), pola identik posts (guard → validasi → service → audit → response). **Beda dari posts: hanya CRUD, tidak ada lifecycle-action endpoint** (`submit-review`/`publish`/`schedule`/`archive`/`restore`/`purge`) — doc issue #539 §Routes hanya mendaftarkan GET/POST/GET/PATCH/DELETE untuk pages, meskipun permission `blog_content.pages.{publish,archive,restore,purge}` sudah diseed sejak Issue #537. Permission itu menunggu issue lanjutan yang benar-benar membangun endpoint-nya — jangan asumsikan lifecycle pages sudah berfungsi hanya karena permission-nya ada di katalog.

```txt
GET    /api/v1/blog/pages          -> blog_content.pages.read
POST   /api/v1/blog/pages          -> blog_content.pages.create
GET    /api/v1/blog/pages/{id}     -> blog_content.pages.read
PATCH  /api/v1/blog/pages/{id}     -> blog_content.pages.update (+ author-own-draft override)
DELETE /api/v1/blog/pages/{id}     -> blog_content.pages.delete
```

Tidak idempotency-gated (sama seperti posts create/update — recommended, bukan required). Audit `action` memakai pola literal yang sama: `blog.page.created`/`.updated`/`.deleted`.

## Admin API — Blog Taxonomies (Issue #539)

`/api/v1/blog/terms` (`src/pages/api/v1/blog/terms/`). **Tidak ada `GET /{id}`** — doc issue #539 §Routes hanya mendaftarkan list/create/update/delete untuk terms.

```txt
GET    /api/v1/blog/terms          -> blog_content.taxonomies.read
POST   /api/v1/blog/terms          -> blog_content.taxonomies.configure
PATCH  /api/v1/blog/terms/{id}     -> blog_content.taxonomies.configure
DELETE /api/v1/blog/terms/{id}     -> blog_content.taxonomies.configure
```

Satu permission (`configure`) menggerbangi create/update/delete sekaligus — sama seperti `sync_storage.conflict_resolution.approve` menggerbangi seluruh `POST /sync/conflicts/{id}/resolve` apa pun hasilnya (permission = kapabilitas "mengelola taksonomi", bukan per-aksi terpisah). Tidak ada restore/purge — doc issue #537's permission seed tidak punya `taxonomies.restore`/`.purge`, jadi soft-delete term bersifat satu arah lewat kode ini (baris tetap ada di DB untuk audit, tapi tidak ada jalur API mengembalikannya).

`PATCH` yang mengubah `taxonomyType` ke `tag` sambil `parentId` lama masih ada (tidak ikut dikosongkan di request yang sama) ditolak `400` — endpoint menggabungkan field yang dikirim dengan baris existing sebelum memanggil ulang `validateTermParent`, persis dicatat di `blog-term-validation.ts`'s docblock.

## Post-term relation handling (Issue #539)

Doc issue #539 §Scope menyebut "Post-term relation handling" tapi **tidak** mendaftarkan route khusus untuk itu di §Routes — jadi ini ditanam di payload create/update blog post yang sudah ada (Issue #538), bukan endpoint baru:

- `POST`/`PATCH /api/v1/blog/posts(/{id})` menerima `termIds?: string[]` opsional.
- Kalau dikirim, `countExistingTerms` mengecek dulu semua id ada & milik tenant yang sama (`400 VALIDATION_ERROR` kalau tidak) — dijalankan **sebelum** post ditulis, supaya tidak ada post "setengah jadi" saat `termIds` invalid.
- `syncPostTermAssignments` men-**replace** seluruh assignment (`DELETE` semua baris `awcms_mini_blog_post_terms` milik post itu, lalu `INSERT` ulang set yang dikirim) — bukan diff/merge, karena caller selalu mengirim daftar lengkap yang diinginkan.
- Response `GET`/`POST`/`PATCH /api/v1/blog/posts(/{id})` menyertakan `termIds` (di-assemble di route handler lewat `fetchPostTermIds`, **bukan** field pada `BlogPostView` dari `blog-post-directory.ts` — directory tetap murni soal tabel `awcms_mini_blog_posts` saja). `GET /api/v1/blog/posts` (list) **tidak** menyertakan `termIds` per item (query tambahan per baris tidak sepadan untuk daftar).

## Search (Issue #539)

`blog-search.ts` — PostgreSQL full-text search lewat `search_vector @@ websearch_to_tsquery('simple', q)`, `UNION ALL` antara posts dan pages, diurutkan `created_at DESC, id DESC`.

- **`GET /api/v1/blog/search`** (guard `blog_content.search.read`) — admin search, boleh mengembalikan status apa pun (`draft`/`review`/.../`archived`) selama caller punya `search.read`; tidak ada komposisi permission tambahan per-status. Keyset-paginated lewat `_shared/keyset-pagination.ts` (`cursor` base64 `(createdAt, id)`), pola sama persis `GET /api/v1/logs/audit`. Filter opsional `?type=post|page` dan `?status=`.
- **`searchPublicBlogContent`** — helper murni, **tidak** dipasang ke route apa pun di issue ini (rendering rute publik = Issue #540, eksplisit Out of Scope di doc issue #539). Predikat persis dari doc issue #539 §Public Visibility Predicate: `status = 'published' AND visibility = 'public' AND deleted_at IS NULL AND published_at IS NOT NULL AND published_at <= now()`. Issue #540 memanggil fungsi ini langsung, bukan menulis ulang predikatnya.

## Public routes (Issue #540)

`src/pages/blog/[tenantCode]/` — 7 rute publik, anonim (tanpa sesi/header tenant), per ADR-0009: resolusi tenant dari segmen path `tenantCode`, bukan subdomain/header.

```txt
GET /blog/{tenantCode}                         -> index (paginated, tanpa auth/permission — publik)
GET /blog/{tenantCode}/{slug}                   -> detail post
GET /blog/{tenantCode}/category/{slug}          -> arsip kategori
GET /blog/{tenantCode}/tag/{slug}               -> arsip tag
GET /blog/{tenantCode}/search?q=                -> search publik (memakai searchPublicBlogContent, Issue #539)
GET /blog/{tenantCode}/feed.xml                 -> RSS 2.0
GET /blog/{tenantCode}/sitemap-blog.xml         -> sitemap protocol 0.9
```

**Hanya blog post**, bukan pages (`awcms_mini_blog_pages`) — doc issue #540 §Scope hanya mendaftarkan "Public post detail page", tidak ada "Public page detail" sama sekali di antara bullet scope-nya (beda dari §Routes issue #539 yang eksplisit menyebut halaman statis). Rendering publik untuk `blog_content` pages tetap backlog terbuka.

### Kenapa `.ts` API route, bukan `.astro` page

Ketujuh rute ini adalah `APIRoute` (`.ts`, HTML/XML string dirender manual), **bukan** file `.astro` — keputusan disengaja. Repo ini tidak punya konvensi test untuk output `.astro` (semua integration test yang ada, termasuk seluruh suite `blog_content` sebelumnya, memanggil `APIRoute` handler langsung lewat `tests/integration/harness.ts`'s `invoke()`/`invokeRaw()`). Menulis rute ini sebagai `.astro` akan membuatnya untestable lewat pola yang sudah mapan di repo — sementara persyaratan issue ini sendiri eksplisit ("Tests cover public visibility leakage... SEO rendering... RSS and sitemap content filtering") menuntut test end-to-end yang nyata, bukan cuma unit test fungsi murni. `invokeRaw()` (baru, `tests/integration/harness.ts`) melengkapi `invoke()` untuk handler yang me-return body non-JSON — `invoke()` sendiri selalu `JSON.parse(text)` dan akan throw untuk HTML/XML.

### Dua predikat visibilitas publik yang berbeda

Doc issue #540 mendefinisikan satu "Public Visibility Rule" dasar (`status='published' AND visibility='public' AND deleted_at IS NULL AND published_at IS NOT NULL AND published_at <= now()`) plus aturan tambahan "listing/search/feed/sitemap: `visibility != 'unlisted'`". Kedua kalimat itu redundan kalau predikat dasarnya SELALU `visibility='public'` — kecuali predikat dasar itu dimaksudkan untuk konteks LISTING saja, dan DETAIL punya predikat sendiri yang sedikit lebih longgar. Acceptance criteria issue ini mengonfirmasi baca-an itu: **"Unlisted content is excluded from listing/search/feed/sitemap"** (bukan dari SEMUA akses publik) — artinya unlisted memang harus tetap bisa diakses lewat link langsung, itulah gunanya tier "unlisted" ada terpisah dari "private" (yang tidak pernah publik sama sekali).

`public-blog-directory.ts` karena itu punya **dua** predikat:

- **Listing** (index/kategori/tag/search/feed/sitemap): `visibility = 'public'` ketat — sama persis predikat `searchPublicBlogContent` (Issue #539).
- **Detail** (`fetchPublicBlogPostBySlug`): `visibility IN ('public', 'unlisted')` — private tetap selalu ditolak.

Kalau interpretasi ini pernah dianggap salah oleh maintainer, ini satu-satunya tempat yang perlu diubah (bukan tersebar di 7 route handler).

### Content block schema (baru, didefinisikan oleh issue ini)

`content_json` sebelumnya "opaque to the API" (doc issue #537/#538). Issue #540 pertama kali mendefinisikan bentuk konkretnya karena rendering publik butuh sesuatu yang nyata untuk dirender: `{ blocks: ContentBlock[] }` dengan 4 tipe block — `paragraph`, `heading` (level 1-6), `list` (`ordered?: boolean`, `items: string[]`), `quote`. `domain/content-block-rendering.ts`'s `renderContentJsonToHtml` adalah **whitelist renderer** — setiap tipe block hanya pernah mengeluarkan teks lewat `escapeHtml`, tidak ada tipe block "raw html". Block dengan `type` tak dikenal atau field tidak valid di-skip diam-diam (tidak pernah throw — lihat §Error handling). Menambah tipe block baru (image, embed, table, ...) berarti menambah `case` baru di `switch` fungsi itu, bukan membuka raw-HTML escape hatch.

### SEO rendering (`domain/seo-rendering.ts`)

- `resolveSeoTitle`: `seoTitle || title`.
- `resolveMetaDescription`: `metaDescription || excerpt || <ringkasan digenerate dari contentText, dipotong di batas kata, diberi "...">`.
- `resolveCanonicalUrl`: pakai `canonicalUrl` penulis kalau itu URL http(s) absolut yang valid (re-validasi lewat `isAbsoluteHttpUrl` yang sama dengan write-time check di `seo-validation.ts` — defense in depth, "Do not render unsafe URLs"); kalau tidak, fallback ke URL halaman itu sendiri; kalau keduanya tidak valid, `null` (tag `<link rel="canonical">` tidak dirender sama sekali, bukan dirender dengan URL tidak aman).

### Error handling — tidak pernah bocorkan stack trace

Setiap route handler dibungkus `try/catch` di level teratas: error asli di-log lewat `log("error", ...)` (untuk operator), tapi respons ke klien SELALU string generik tetap (`src/lib/html/error-responses.ts`'s `notFoundHtmlResponse`/`serverErrorHtmlResponse`/`notFoundXmlResponse`/`serverErrorXmlResponse`) — tidak pernah pesan/`error.message` mentah. Tenant `tenantCode` tidak ditemukan ATAU tidak `active` menghasilkan `404` yang identik (ADR-0009: "jangan bocorkan keberadaan tenant").

### Pagination

Index dan arsip kategori/tag pakai `?page=` (1-indexed) + `LIMIT`/`OFFSET` sederhana, bukan keyset — ini halaman publik yang dibaca pengunjung manusia (ekspektasi UX "halaman 1, 2, 3", bukan cursor buram), beda dari admin search (Issue #539) yang keyset-paginated. `pageSize` diambil dari `awcms_mini_blog_settings.posts_per_page` (Issue #537, default 10) lewat `fetchPublicBlogSettings`. RSS/sitemap tidak dipaginasi sama sekali — flat, dibatasi 50 post terbaru (`FEED_ITEM_LIMIT`), karena konsumennya mesin (feed reader/crawler), bukan pengunjung yang mengklik "next".

## Revisions (Issue #541)

`/api/v1/blog/posts/{id}/revisions` (`src/pages/api/v1/blog/posts/[id]/revisions/`).

```txt
GET  /api/v1/blog/posts/{id}/revisions                     -> blog_content.revisions.read
GET  /api/v1/blog/posts/{id}/revisions/{revisionId}         -> blog_content.revisions.read
POST /api/v1/blog/posts/{id}/revisions/{revisionId}/restore -> blog_content.revisions.restore (Idempotency-Key wajib)
```

Hanya rute untuk **post** — doc issue #541 §Routes cuma mendaftarkan tiga rute di atas, meski aturan revisi sendiri ("post/page changes") berlaku untuk keduanya. `PATCH /api/v1/blog/pages/{id}` juga memicu `createBlogRevision` dengan `resource_type = 'page'` (baris tersimpan, riwayat terekam), tapi tidak ada rute baca/restore untuk page revision di issue ini — backlog terbuka, lihat §Belum tersedia.

### Kapan revisi baru dibuat — "significant change"

`domain/revision-policy.ts`'s `isSignificantContentChange` — true kalau `PATCH` menyertakan `title`, `contentJson`, atau `contentText`; field lain (`seoTitle`, `metaDescription`, `canonicalUrl`, `visibility`, `locale`, `featuredMediaId`, `slug`, `menuOrder`, ...) tidak memicu revisi baru. `awcms_mini_blog_revisions` tidak punya kolom `slug` (migration 026) — konsisten dengan keputusan itu. Dipanggil dari `PATCH /api/v1/blog/posts/{id}` dan `PATCH /api/v1/blog/pages/{id}`, **bukan** dari `POST` create — revisi pertama baru muncul begitu ada perubahan konten signifikan pertama setelah create, bukan snapshot draft awal.

### Restore — append-only, tidak pernah menimpa

`POST .../revisions/{revisionId}/restore`: (1) ambil konten revisi target, (2) tulis kembali ke baris post yang hidup lewat `updateBlogPost` biasa, (3) `createBlogRevision` lagi untuk mencatat state hasil restore itu sendiri (`changeNote: "Restored from revision {n}."`). Langkah 3 berarti restore **menambah** baris baru di `awcms_mini_blog_revisions`, tidak pernah `UPDATE`/`DELETE` baris manapun yang sudah ada — riwayat lengkap termasuk revisi-revisi "di antara" tetap utuh dan bisa dibaca lagi nanti.

Permission `blog_content.revisions.restore` **eksplisit wajib** — tidak ada ownership override seperti `PATCH /api/v1/blog/posts/{id}` (author pemilik post tidak otomatis boleh restore revisinya sendiri tanpa permission itu; lihat §ABAC di §Admin API — Blog Posts untuk kontras pola). `Idempotency-Key` wajib (scope `blog_revision_restore`) — replay key yang sama mengembalikan response tersimpan tanpa menambah revisi kedua.

Audit: `blog.post.revision_restored` (severity `warning`, `attributes: { revisionId, revisionNumber }`).

## Scheduled publishing (Issue #541)

`bun run blog:publish:scheduled` (`scripts/blog-scheduled-publish.ts`) — worker internal, bukan endpoint HTTP, dijadwalkan cron/systemd timer (pola sama `scripts/form-draft-purge.ts`). Untuk setiap tenant aktif, memanggil `blog-scheduled-publish.ts`'s `publishDueScheduledPosts(sql, tenantId)`.

Satu `UPDATE` set-based per tenant (bukan loop per-row, bukan batching bertahap seperti `form-draft-purge.ts` — tidak ada kebutuhan retensi/paging di sini):

```sql
UPDATE awcms_mini_blog_posts
SET status = 'published', published_at = COALESCE(published_at, now()),
    scheduled_at = NULL, version = version + 1, updated_at = now()
WHERE tenant_id = $1 AND status = 'scheduled'
  AND scheduled_at IS NOT NULL AND scheduled_at <= now() AND deleted_at IS NULL
RETURNING id, slug
```

Idempoten by construction: post yang sudah `published` atau `scheduled_at`-nya masih di masa depan tidak match `WHERE` — run kedua di `now` yang sama adalah no-op murni. `COALESCE(published_at, now())` memastikan post yang **pernah** published sebelumnya (`published_at` sudah terisi dari histori lama, lalu di-set balik ke `draft`/`scheduled` lewat SQL manual atau endpoint masa depan) tidak kehilangan `published_at` aslinya — doc issue #541 §Scheduled Publishing Rules: "sets published_at=now() only if not already set".

Audit per post yang dipublish: `blog.post.published` (reuse action yang sama dengan `POST .../publish` manual — pembeda `trigger: "scheduled_publish"` hanya ada di structured log, bukan di audit `attributes`). Plus satu event ringkasan per pemanggilan tenant: `blog.post.scheduled_publish_executed` (kalau ada yang dipublish, `attributes.publishedCount`) atau `blog.post.scheduled_publish_skipped` (kalau tidak ada yang due — bukan satu event skip per post yang diperiksa, karena job ini set-based, tidak iterasi per-baris).

Tidak ada pemanggilan provider eksternal sama sekali di job ini (ADR-0006 tidak relevan di sini — job murni transisi database, tidak ada dispatcher/provider yang perlu dijaga di luar transaction).

## Domain events (AsyncAPI, Issue #541)

`asyncapi/awcms-mini-domain-events.asyncapi.yaml` — 13 channel baru untuk `blog_content`, terdaftar juga di `module.ts`'s `events.publishes` (divalidasi `scripts/api-spec-check.ts`'s `checkModuleEventChannels`: tiap entry `publishes` module manapun wajib punya channel AsyncAPI yang cocok). Sama seperti setiap event lain di kontrak ini sejak Issue 0.3: **dokumentasi kontrak saja** — tidak ada dispatcher pub/sub nyata di repo ini; produser sebenarnya adalah structured JSON logger (`src/lib/logging/logger.ts`'s `log()`), bukan event bus. Konvensi penamaan log line: buang prefix `awcms-mini.` dari event type (`awcms-mini.blog-content.post.published` -> log message `blog-content.post.published`) — pola sama persis `email.message.queued` dkk.

12 dari 13 event punya produser nyata di kode saat ini:

| Event (AsyncAPI channel, tanpa prefix `awcms-mini.`) | Log line diemisikan dari |
| --- | --- |
| `blog-content.post.created` | `pages/api/v1/blog/posts/index.ts` (`POST`) |
| `blog-content.post.updated` | `pages/api/v1/blog/posts/[id].ts` (`PATCH`) |
| `blog-content.post.submitted-for-review` | `pages/api/v1/blog/posts/[id]/submit-review.ts` |
| `blog-content.post.published` | `pages/api/v1/blog/posts/[id]/publish.ts` **dan** `blog-content/application/blog-scheduled-publish.ts` (atribut `trigger` membedakan) |
| `blog-content.post.scheduled` | `pages/api/v1/blog/posts/[id]/schedule.ts` |
| `blog-content.post.archived` | `pages/api/v1/blog/posts/[id]/archive.ts` |
| `blog-content.post.deleted` | `pages/api/v1/blog/posts/[id].ts` (`DELETE`) |
| `blog-content.post.restored` | `pages/api/v1/blog/posts/[id]/restore.ts` (restore soft-delete, **bukan** restore revisi) |
| `blog-content.post.purged` | `pages/api/v1/blog/posts/[id]/purge.ts` |
| `blog-content.revision.created` | `blog-content/application/blog-revision-directory.ts`'s `createBlogRevision` — satu titik untuk PATCH signifikan **dan** restore revisi, jadi log line-nya otomatis muncul dari kedua jalur tanpa duplikasi kode |
| `blog-content.term.created` | `pages/api/v1/blog/terms/index.ts` (`POST`) |
| `blog-content.term.updated` | `pages/api/v1/blog/terms/[id].ts` (`PATCH`) |

Satu-satunya event **tanpa** produser saat ini: `blog-content.settings.updated` — didaftarkan sesuai daftar literal doc issue #541, tapi belum ada endpoint yang menulis `awcms_mini_blog_settings` (`blog_content.settings.configure` sudah diseed sejak Issue #537, menunggu endpoint-nya). `checkModuleEventChannels` hanya memvalidasi arah module.ts→AsyncAPI (setiap `publishes` wajib ada channel), bukan sebaliknya, jadi channel tanpa produser tidak membuat `api:spec:check` gagal.

## Belum tersedia (backlog eksplisit, bukan kelalaian)

- Public page (halaman statis) rendering — hanya post yang punya rute publik di Issue #540, lihat §Public routes.
- Page revision list/detail/restore endpoints — `createBlogRevision` sudah dipanggil dari `PATCH /api/v1/blog/pages/{id}` (baris tersimpan), tapi tidak ada rute baca/restore untuk `resource_type = 'page'`, hanya post (lihat §Revisions).
- `POST /api/v1/blog/settings` (atau setara) — `blog-content.settings.updated` sudah didaftarkan di kontrak AsyncAPI (Issue #541) tapi belum ada endpoint yang menulis `awcms_mini_blog_settings`.
- Template, menu, widget, media/gallery, multilingual, theme mode, ads — Issue #542.
- Admin UI, dokumentasi akhir, hardening — Issue #543.
- Page lifecycle-action endpoints (`submit-review`/`publish`/`schedule`/`archive`/`restore`/`purge` untuk pages) — permission-nya sudah diseed (Issue #537) tapi tidak ada issue yang eksplisit membangun endpoint-nya; backlog terbuka, bukan bagian #539.
- Optimistic-concurrency check yang membaca kolom `version` — kolom sudah di-increment tiap write, tapi belum ada endpoint yang menolak write berdasarkan `version` mismatch.
- Search relevance ranking (`ts_rank`) dan text search config per-locale (`english`/`indonesian`) — `search_vector` sudah weighted (A/B/C) untuk kebutuhan ini di masa depan, tapi `GET /api/v1/blog/search` (admin) dan search publik saat ini hanya mengurutkan `created_at DESC`.
- Locale-aware negotiation untuk pengunjung publik (mis. header `Accept-Language`) — index/detail publik saat ini menampilkan semua post tanpa filter locale; `<html lang>` memakai locale post/tenant, bukan preferensi pengunjung.
- `robots.txt` dan referensi sitemap dari `robots.txt` — hanya sitemap XML-nya sendiri yang ada, belum ada yang mereferensikannya secara otomatis.

---
name: awcms-mini-blog-content
description: Kerjakan bagian mana pun dari epic blog_content AWCMS-Mini (Issue #537-#543, epic #536) — posts, pages, taxonomi, search, rute publik, revisi/scheduled publishing, atau UI admin blog. Gunakan saat menambah endpoint/logic ke src/modules/blog-content atau src/pages/blog, mengubah schema blog, atau melanjutkan issue lanjutan epic ini. Merangkum keputusan yang sudah dibuat di Issue #537-#540 supaya tidak diulang/dikontradiksi.
---

# AWCMS-Mini — Blog Content Module

`blog_content` (`src/modules/blog-content`) adalah **modul domain pertama
yang didaftarkan langsung di repo base ini** (epic #536, bukan di aplikasi
turunan terpisah — lihat `AGENTS.md` §Peta modul dan
`docs/adr/0009-public-tenant-scoped-routes.md`). Skill ini merangkum
keputusan Issue #537-#540 (semuanya sudah selesai) yang **wajib** dipakai
ulang oleh Issue #541-#543, bukan didesain ulang — baca
`src/modules/blog-content/README.md` untuk detail lengkap tiap tabel dan
endpoint.

## Kapan pakai skill ini vs skill generik

Skill ini melengkapi (bukan menggantikan) `awcms-mini-new-endpoint`,
`awcms-mini-new-migration`, `awcms-mini-testing`, dll. — itu tetap dipakai
untuk cara **membangun** endpoint/migration/test. Skill ini menyediakan
konteks **domain blog_content spesifik** yang tidak jelas dari sekadar
membaca satu file migration.

## Status per issue (jangan bangun ulang yang sudah ada)

| Issue | Scope                                       | Status                                                  |
| ----- | ------------------------------------------- | ------------------------------------------------------- |
| #537  | Schema, domain validation, permission seed  | **Selesai** (migration 026/027)                         |
| #538  | Admin API + lifecycle actions (posts)       | **Selesai** (`/api/v1/blog/posts`, lihat README)        |
| #539  | Pages, taxonomi, post-term relation, search | **Selesai** (`/api/v1/blog/pages`, `/terms`, `/search`) |
| #540  | Rute publik, RSS, sitemap, SEO              | **Selesai** (`/blog/{tenantCode}/...`, lihat README)    |
| #541  | Revisions + scheduled publishing            | Belum                                                   |
| #542  | Template/menu/widget/media/multilingual/ads | Belum                                                   |
| #543  | Admin UI, dokumentasi akhir, hardening      | Belum                                                   |

## Yang sudah ada — pakai ulang, jangan re-derive

- **Tabel** (migration `026_awcms_mini_blog_content_schema.sql`): `awcms_mini_blog_posts`, `_pages`, `_terms`, `_post_terms`, `_revisions` (append-only), `_redirects`, `_settings` (1 row/tenant, `tenant_id` = PK). Semua `ENABLE`+`FORCE ROW LEVEL SECURITY`, tanpa `GRANT` eksplisit (migration 013's `ALTER DEFAULT PRIVILEGES` sudah meng-cover). Migration `028` (Issue #539) mengubah `search_vector` di posts/pages jadi `GENERATED ALWAYS ... STORED` (weighted title/excerpt/content_text, config `simple`) — PostgreSQL sendiri yang menjaganya sinkron, tidak ada trigger/application code.
- **Permission seed** (migration `027`): 26 permission `blog_content.<posts|pages|taxonomies|revisions|settings|seo|search>.<action>` — kalau endpoint baru butuh permission di luar daftar ini, itu berarti scope-nya salah atau butuh migration permission baru, bukan improvisasi module_key/activity_code baru. Semua permission `pages.*`/`taxonomies.*`/`search.read` yang dipakai #539 **sudah** ada dari migration ini — #539 tidak menambah migration permission baru.
- **Domain validation** (`src/modules/blog-content/domain/`): `content-validation.ts` (field inti + penolakan HTML tak aman + `validateDeleteReasonInput` bersama, dipakai ulang oleh create/update/delete post/page/term), `post-status.ts` (`isValidStatusTransition`, `canRestorePost`, `canPurgePost`), `page-type.ts` (`isPageType`), `slug-policy.ts`, `seo-validation.ts`, `taxonomy-policy.ts` (`validateTermParent`), `content-access-policy.ts` (`evaluateContentUpdateAccess` — logic ABAC ownership generik, lihat di bawah), `post-access-policy.ts`/`page-access-policy.ts` (thin wrapper resource-specific), `blog-post-validation.ts`, `blog-page-validation.ts`, `blog-term-validation.ts`. **Panggil fungsi-fungsi ini**, jangan tulis ulang regex/aturan yang sama di endpoint handler.
- **Application** (`src/modules/blog-content/application/`): `blog-post-directory.ts` (CRUD + lifecycle posts, plus konsumsi `syncPostTermAssignments`/`fetchPostTermIds`/`countExistingTerms` dari `blog-taxonomy-directory.ts` untuk `termIds`), `blog-page-directory.ts` (CRUD pages saja — **tanpa** lifecycle transition/restore/purge), `blog-taxonomy-directory.ts` (CRUD term + relasi post-term), `blog-search.ts` (`searchBlogContentAdmin`, `searchPublicBlogContent`).
- **API admin posts** (`src/pages/api/v1/blog/posts/`): CRUD + 5 lifecycle action + `termIds` di body create/update. **API admin pages** (`src/pages/api/v1/blog/pages/`): CRUD saja, tanpa lifecycle action. **API admin terms** (`src/pages/api/v1/blog/terms/`): list/create/update/delete, tanpa `GET /{id}`. **API search** (`src/pages/api/v1/blog/search/`): admin only, keyset-paginated. Baca `src/modules/blog-content/README.md` untuk pola guard/idempotency/audit lengkap tiap endpoint (termasuk nama action audit literal `blog.<resource>.<verb>`).
- **Rute publik** (`src/pages/blog/[tenantCode]/`, Issue #540): index, detail post, arsip kategori/tag, search, `feed.xml`, `sitemap-blog.xml` — 7 `APIRoute` (`.ts`, bukan `.astro`, lihat §Aturan #10). Semua anonim, resolusi tenant lewat `src/lib/tenant/public-tenant-resolver.ts`'s `resolvePublicTenantByCode` (ADR-0009). Query publik ada di `public-blog-directory.ts` (**bukan** `blog-post-directory.ts` yang admin-only), rendering aman di `content-block-rendering.ts`/`seo-rendering.ts`/`public-page-rendering.ts`. **Hanya post**, tidak ada rute publik untuk pages.

## Aturan lintas-issue yang wajib diikuti

1. **Slug uniqueness**: posts/pages unik per `(tenant_id, locale, slug)` selama `deleted_at IS NULL`; terms unik per `(tenant_id, taxonomy_type, slug)`. Jangan tambah constraint unik baru yang lebih longgar/ketat tanpa migration baru + update README.
2. **Tag tidak boleh punya `parent_id`** — sudah di-enforce di constraint DB (`awcms_mini_blog_terms_tag_no_parent_check`) dan aplikasi (`validateTermParent`). Endpoint create/update term wajib panggil `validateTermParent` sebelum insert/update — untuk update, gabungkan field yang dikirim dengan baris existing dulu (lihat `blog-term-validation.ts` docblock), jangan cek isolated terhadap body saja.
3. **Revisions append-only** — tidak pernah `UPDATE`/`DELETE` baris `awcms_mini_blog_revisions`. "Restore revisi" (Issue #541) = insert revisi baru berisi konten lama, lalu update baris post/page aktif dari revisi itu.
4. **`search_vector` sudah `GENERATED ALWAYS ... STORED`** sejak migration `028` (Issue #539) — jangan pernah menulis ke kolom ini secara manual (Postgres menolaknya), dan jangan menambah trigger/`recomputeSearchVector` semacamnya, itu sudah beres di level kolom.
5. **Rute publik tenant-scoped wajib ikuti ADR-0009**: resolusi tenant lewat segmen path `tenant_code` (`/blog/{tenantCode}/...`) via `resolvePublicTenantByCode` (`src/lib/tenant/public-tenant-resolver.ts`), **bukan** subdomain/header — base ini LAN-first, tidak boleh berasumsi ada DNS/TLS publik. `tenantCode` tidak ditemukan ATAU tenant tidak `active` → `404` yang identik (jangan bocorkan keberadaan tenant). Pakai `searchPublicBlogContent` (`blog-search.ts`, Issue #539) langsung untuk search publik, jangan tulis ulang predikat visibilitasnya.
6. **Dua predikat visibilitas publik berbeda** (Issue #540, `public-blog-directory.ts`): LISTING (index/kategori/tag/search/feed/sitemap) pakai `visibility = 'public'` ketat; DETAIL (`fetchPublicBlogPostBySlug`) pakai `visibility IN ('public', 'unlisted')` — unlisted bisa diakses link langsung tapi tidak muncul di listing manapun, private tidak pernah publik sama sekali di kedua konteks. Jangan menyamakan keduanya.
7. **Rute publik = `APIRoute` `.ts`, bukan `.astro`** — supaya testable lewat `tests/integration/harness.ts`'s `invoke()`/`invokeRaw()` (pola test satu-satunya yang ada di repo ini). `invokeRaw()` (bukan `invoke()`) untuk handler yang me-return HTML/XML, bukan JSON — `invoke()` selalu `JSON.parse` dan akan throw untuk body non-JSON.
8. **`content_json` sekarang punya schema konkret** (Issue #540, sebelumnya "opaque"): `{ blocks: ContentBlock[] }`, 4 tipe (`paragraph`/`heading`/`list`/`quote`). Rendering SELALU lewat `content-block-rendering.ts`'s `renderContentJsonToHtml` (whitelist, escape semua teks) — jangan pernah `set:html`/render mentah `content_json`/`content_text` di rute mana pun.
9. **Idempotency**: posts punya scope `blog_post_publish`/`_schedule`/`_archive`/`_restore`/`_purge` (Issue #538); pola scope `blog_<resource>_<action>` yang sama dipakai untuk restore-revisi di #541 kalau perlu. Pages/terms CRUD (#539) dan seluruh rute publik (#540, GET-only, tidak mutasi apa pun) **tidak** idempotency-gated — jangan tambahkan tanpa alasan baru.
10. **Audit**: `action` memakai string literal `blog.<resource>.<verb>` (bukan verb generik singkat seperti modul lain) — `blog.post.*` (#538), `blog.page.*`/`blog.term.*` (#539) sudah konsisten; pertahankan pola ini untuk `blog.revision.*` di #541. Rute publik (#540) tidak menulis audit event (baca-saja, anonim, tidak ada `actorTenantUserId`).
11. **ABAC ownership override generik**: `content-access-policy.ts`'s `evaluateContentUpdateAccess` dipakai posts DAN pages (author boleh edit konten sendiri yang belum published, tanpa permission `update`). Kalau menambah resource baru dengan pola serupa, panggil fungsi generik ini dengan guard baru — jangan copy-paste logic `evaluatePostUpdateAccess`/`evaluatePageUpdateAccess` lagi.
12. **Error handling publik tidak boleh bocorkan stack trace**: setiap rute publik dibungkus `try/catch`, error asli di-`log()`, respons ke klien selalu string generik dari `src/lib/html/error-responses.ts`. Reuse fungsi itu untuk rute publik baru, jangan bikin pesan error ad-hoc.
13. **Multilingual** (Issue #542): kolom `locale` di posts/pages sekarang cuma satu nilai per baris (bukan JSONB per-locale). Kalau #542 butuh konten multi-locale per satu post, contoh pola yang sudah ada dan divalidasi di repo ini adalah `sql/021_awcms_mini_email_template_i18n_schema.sql` (JSONB per-locale) — pakai itu sebagai referensi, bukan mendesain skema baru dari nol.

## Belum ada — jangan asumsikan sudah dikerjakan

Belum ada rute publik untuk pages (hanya post yang punya rute publik di #540), restore-revisi, scheduled-publishing dispatcher, presentation extensions, atau admin UI. `src/modules/blog-content/README.md` §Belum tersedia berisi daftar lengkap per issue. Page lifecycle-action endpoints (`publish`/`schedule`/`archive`/`restore`/`purge` untuk pages) juga **belum ada** meski permission-nya sudah diseed sejak #537 — jangan asumsikan itu selesai hanya karena posts sudah punya lifecycle lengkap. Locale-aware negotiation untuk pengunjung publik (mis. `Accept-Language`) juga belum ada — rute publik saat ini tidak memfilter berdasarkan preferensi bahasa pengunjung.

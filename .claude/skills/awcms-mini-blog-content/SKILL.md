---
name: awcms-mini-blog-content
description: Kerjakan bagian mana pun dari epic blog_content AWCMS-Mini (Issue #537-#543, epic #536) — posts, pages, taxonomi, search, revisi/scheduled publishing, rute publik, atau UI admin blog. Gunakan saat menambah endpoint/logic ke src/modules/blog-content, mengubah schema blog, atau melanjutkan issue lanjutan epic ini. Merangkum keputusan yang sudah dibuat di Issue #537, #538, dan #539 supaya tidak diulang/dikontradiksi.
---

# AWCMS-Mini — Blog Content Module

`blog_content` (`src/modules/blog-content`) adalah **modul domain pertama
yang didaftarkan langsung di repo base ini** (epic #536, bukan di aplikasi
turunan terpisah — lihat `AGENTS.md` §Peta modul dan
`docs/adr/0009-public-tenant-scoped-routes.md`). Skill ini merangkum
keputusan Issue #537, #538, dan #539 (semuanya sudah selesai) yang
**wajib** dipakai ulang oleh Issue #540-#543, bukan didesain ulang — baca
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
| #540  | Rute publik, RSS, sitemap, SEO              | Belum                                                   |
| #541  | Revisions + scheduled publishing            | Belum                                                   |
| #542  | Template/menu/widget/media/multilingual/ads | Belum                                                   |
| #543  | Admin UI, dokumentasi akhir, hardening      | Belum                                                   |

## Yang sudah ada — pakai ulang, jangan re-derive

- **Tabel** (migration `026_awcms_mini_blog_content_schema.sql`): `awcms_mini_blog_posts`, `_pages`, `_terms`, `_post_terms`, `_revisions` (append-only), `_redirects`, `_settings` (1 row/tenant, `tenant_id` = PK). Semua `ENABLE`+`FORCE ROW LEVEL SECURITY`, tanpa `GRANT` eksplisit (migration 013's `ALTER DEFAULT PRIVILEGES` sudah meng-cover). Migration `028` (Issue #539) mengubah `search_vector` di posts/pages jadi `GENERATED ALWAYS ... STORED` (weighted title/excerpt/content_text, config `simple`) — PostgreSQL sendiri yang menjaganya sinkron, tidak ada trigger/application code.
- **Permission seed** (migration `027`): 26 permission `blog_content.<posts|pages|taxonomies|revisions|settings|seo|search>.<action>` — kalau endpoint baru butuh permission di luar daftar ini, itu berarti scope-nya salah atau butuh migration permission baru, bukan improvisasi module_key/activity_code baru. Semua permission `pages.*`/`taxonomies.*`/`search.read` yang dipakai #539 **sudah** ada dari migration ini — #539 tidak menambah migration permission baru.
- **Domain validation** (`src/modules/blog-content/domain/`): `content-validation.ts` (field inti + penolakan HTML tak aman + `validateDeleteReasonInput` bersama, dipakai ulang oleh create/update/delete post/page/term), `post-status.ts` (`isValidStatusTransition`, `canRestorePost`, `canPurgePost`), `page-type.ts` (`isPageType`), `slug-policy.ts`, `seo-validation.ts`, `taxonomy-policy.ts` (`validateTermParent`), `content-access-policy.ts` (`evaluateContentUpdateAccess` — logic ABAC ownership generik, lihat di bawah), `post-access-policy.ts`/`page-access-policy.ts` (thin wrapper resource-specific), `blog-post-validation.ts`, `blog-page-validation.ts`, `blog-term-validation.ts`. **Panggil fungsi-fungsi ini**, jangan tulis ulang regex/aturan yang sama di endpoint handler.
- **Application** (`src/modules/blog-content/application/`): `blog-post-directory.ts` (CRUD + lifecycle posts, plus konsumsi `syncPostTermAssignments`/`fetchPostTermIds`/`countExistingTerms` dari `blog-taxonomy-directory.ts` untuk `termIds`), `blog-page-directory.ts` (CRUD pages saja — **tanpa** lifecycle transition/restore/purge), `blog-taxonomy-directory.ts` (CRUD term + relasi post-term), `blog-search.ts` (`searchBlogContentAdmin`, `searchPublicBlogContent`).
- **API admin posts** (`src/pages/api/v1/blog/posts/`): CRUD + 5 lifecycle action + `termIds` di body create/update. **API admin pages** (`src/pages/api/v1/blog/pages/`): CRUD saja, tanpa lifecycle action. **API admin terms** (`src/pages/api/v1/blog/terms/`): list/create/update/delete, tanpa `GET /{id}`. **API search** (`src/pages/api/v1/blog/search/`): admin only, keyset-paginated. Baca `src/modules/blog-content/README.md` untuk pola guard/idempotency/audit lengkap tiap endpoint (termasuk nama action audit literal `blog.<resource>.<verb>`).

## Aturan lintas-issue yang wajib diikuti

1. **Slug uniqueness**: posts/pages unik per `(tenant_id, locale, slug)` selama `deleted_at IS NULL`; terms unik per `(tenant_id, taxonomy_type, slug)`. Jangan tambah constraint unik baru yang lebih longgar/ketat tanpa migration baru + update README.
2. **Tag tidak boleh punya `parent_id`** — sudah di-enforce di constraint DB (`awcms_mini_blog_terms_tag_no_parent_check`) dan aplikasi (`validateTermParent`). Endpoint create/update term wajib panggil `validateTermParent` sebelum insert/update — untuk update, gabungkan field yang dikirim dengan baris existing dulu (lihat `blog-term-validation.ts` docblock), jangan cek isolated terhadap body saja.
3. **Revisions append-only** — tidak pernah `UPDATE`/`DELETE` baris `awcms_mini_blog_revisions`. "Restore revisi" (Issue #541) = insert revisi baru berisi konten lama, lalu update baris post/page aktif dari revisi itu.
4. **`search_vector` sudah `GENERATED ALWAYS ... STORED`** sejak migration `028` (Issue #539) — jangan pernah menulis ke kolom ini secara manual (Postgres menolaknya), dan jangan menambah trigger/`recomputeSearchVector` semacamnya, itu sudah beres di level kolom.
5. **Rute publik tenant-scoped** (Issue #540) **wajib** ikuti ADR-0009: resolusi tenant lewat segmen path `tenant_code` (`/blog/{tenantCode}/...`), **bukan** subdomain/header — base ini LAN-first, tidak boleh berasumsi ada DNS/TLS publik. Pakai `searchPublicBlogContent` (`blog-search.ts`) langsung untuk search publik, jangan tulis ulang predikat visibilitasnya.
6. **Idempotency**: posts punya scope `blog_post_publish`/`_schedule`/`_archive`/`_restore`/`_purge` (Issue #538); pola scope `blog_<resource>_<action>` yang sama dipakai untuk restore-revisi di #541 kalau perlu. Pages/terms CRUD (#539) **tidak** idempotency-gated (tidak ada lifecycle action high-risk di scope-nya) — jangan tambahkan tanpa alasan baru.
7. **Audit**: `action` memakai string literal `blog.<resource>.<verb>` (bukan verb generik singkat seperti modul lain) — `blog.post.*` (#538), `blog.page.*`/`blog.term.*` (#539) sudah konsisten; pertahankan pola ini untuk `blog.revision.*` di #541.
8. **ABAC ownership override generik**: `content-access-policy.ts`'s `evaluateContentUpdateAccess` dipakai posts DAN pages (author boleh edit konten sendiri yang belum published, tanpa permission `update`). Kalau menambah resource baru dengan pola serupa, panggil fungsi generik ini dengan guard baru — jangan copy-paste logic `evaluatePostUpdateAccess`/`evaluatePageUpdateAccess` lagi.
9. **Multilingual** (Issue #542): kolom `locale` di posts/pages sekarang cuma satu nilai per baris (bukan JSONB per-locale). Kalau #542 butuh konten multi-locale per satu post, contoh pola yang sudah ada dan divalidasi di repo ini adalah `sql/021_awcms_mini_email_template_i18n_schema.sql` (JSONB per-locale) — pakai itu sebagai referensi, bukan mendesain skema baru dari nol.

## Belum ada — jangan asumsikan sudah dikerjakan

Belum ada rute publik, RSS/sitemap, restore-revisi, scheduled-publishing dispatcher, presentation extensions, atau admin UI. `src/modules/blog-content/README.md` §Belum tersedia berisi daftar lengkap per issue. Page lifecycle-action endpoints (`publish`/`schedule`/`archive`/`restore`/`purge` untuk pages) juga **belum ada** meski permission-nya sudah diseed sejak #537 — jangan asumsikan itu selesai hanya karena posts sudah punya lifecycle lengkap.

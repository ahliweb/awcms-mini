---
name: awcms-mini-blog-content
description: Kerjakan bagian mana pun dari epic blog_content AWCMS-Mini (Issue #537-#543, epic #536) — posts, pages, taxonomi, search, revisi/scheduled publishing, rute publik, atau UI admin blog. Gunakan saat menambah endpoint/logic ke src/modules/blog-content, mengubah schema blog, atau melanjutkan issue lanjutan epic ini. Merangkum keputusan yang sudah dibuat di Issue #537 dan #538 supaya tidak diulang/dikontradiksi.
---

# AWCMS-Mini — Blog Content Module

`blog_content` (`src/modules/blog-content`) adalah **modul domain pertama
yang didaftarkan langsung di repo base ini** (epic #536, bukan di aplikasi
turunan terpisah — lihat `AGENTS.md` §Peta modul dan
`docs/adr/0009-public-tenant-scoped-routes.md`). Skill ini merangkum
keputusan Issue #537 dan #538 (keduanya sudah selesai) yang **wajib**
dipakai ulang oleh Issue #539-#543, bukan didesain ulang — baca
`src/modules/blog-content/README.md` untuk detail lengkap tiap tabel dan
endpoint.

## Kapan pakai skill ini vs skill generik

Skill ini melengkapi (bukan menggantikan) `awcms-mini-new-endpoint`,
`awcms-mini-new-migration`, `awcms-mini-testing`, dll. — itu tetap dipakai
untuk cara **membangun** endpoint/migration/test. Skill ini menyediakan
konteks **domain blog_content spesifik** yang tidak jelas dari sekadar
membaca satu file migration.

## Status per issue (jangan bangun ulang yang sudah ada)

| Issue | Scope                                       | Status                                           |
| ----- | ------------------------------------------- | ------------------------------------------------ |
| #537  | Schema, domain validation, permission seed  | **Selesai** (migration 026/027)                  |
| #538  | Admin API + lifecycle actions (posts)       | **Selesai** (`/api/v1/blog/posts`, lihat README) |
| #539  | Pages, taxonomi, PostgreSQL search          | Belum                                            |
| #540  | Rute publik, RSS, sitemap, SEO              | Belum                                            |
| #541  | Revisions + scheduled publishing            | Belum                                            |
| #542  | Template/menu/widget/media/multilingual/ads | Belum                                            |
| #543  | Admin UI, dokumentasi akhir, hardening      | Belum                                            |

## Yang sudah ada — pakai ulang, jangan re-derive

- **Tabel** (migration `026_awcms_mini_blog_content_schema.sql`): `awcms_mini_blog_posts`, `_pages`, `_terms`, `_post_terms`, `_revisions` (append-only), `_redirects`, `_settings` (1 row/tenant, `tenant_id` = PK). Semua `ENABLE`+`FORCE ROW LEVEL SECURITY`, tanpa `GRANT` eksplisit (migration 013's `ALTER DEFAULT PRIVILEGES` sudah meng-cover).
- **Permission seed** (migration `027`): 26 permission `blog_content.<posts|pages|taxonomies|revisions|settings|seo|search>.<action>` — kalau endpoint baru butuh permission di luar daftar ini, itu berarti scope-nya salah atau butuh migration permission baru, bukan improvisasi module_key/activity_code baru.
- **Domain validation** (`src/modules/blog-content/domain/`): `content-validation.ts` (field inti + penolakan HTML tak aman — `validateTitleField`/`validateSlugField`/`validateContentJsonField`/dst. per-field, dipakai ulang oleh create DAN partial update), `post-status.ts` (`isValidStatusTransition`, `canRestorePost`, `canPurgePost` — satu sumber kebenaran dipakai #538 dan #541), `slug-policy.ts` (`isValidSlug`/`slugify`), `seo-validation.ts`, `taxonomy-policy.ts` (`validateTermParent`), `blog-post-validation.ts` (compose semuanya untuk create/update/schedule/soft-delete post), `post-access-policy.ts` (`evaluatePostUpdateAccess` — ABAC ownership override, lihat §Admin API posts di README). **Panggil fungsi-fungsi ini**, jangan tulis ulang regex/aturan yang sama di endpoint handler.
- **Application** (`src/modules/blog-content/application/`): `blog-post-directory.ts` sekarang berisi read+write penuh untuk posts (`createBlogPost`, `fetchBlogPostById`, `listBlogPosts`, `updateBlogPost`, `softDeleteBlogPost`, `transitionBlogPostStatus`, `restoreBlogPost`, `purgeBlogPost`) — dipakai langsung oleh `/api/v1/blog/posts/*`. `blog-taxonomy-directory.ts` masih placeholder read-only untuk Issue #539.
- **API admin posts** (`src/pages/api/v1/blog/posts/`): CRUD + 5 lifecycle action (`submit-review`, `publish`, `schedule`, `archive`, `restore`, `purge`). Baca `src/modules/blog-content/README.md` §Admin API — Blog Posts sebelum menambah endpoint baru di modul ini (pola guard/idempotency/audit yang harus diikuti konsisten, termasuk nama action audit literal `blog.post.*`).

## Aturan lintas-issue yang wajib diikuti

1. **Slug uniqueness**: posts/pages unik per `(tenant_id, locale, slug)` selama `deleted_at IS NULL`; terms unik per `(tenant_id, taxonomy_type, slug)`. Jangan tambah constraint unik baru yang lebih longgar/ketat tanpa migration baru + update README.
2. **Tag tidak boleh punya `parent_id`** — sudah di-enforce di constraint DB (`awcms_mini_blog_terms_tag_no_parent_check`) dan aplikasi (`validateTermParent`). Endpoint create/update term wajib panggil `validateTermParent` sebelum insert/update.
3. **Revisions append-only** — tidak pernah `UPDATE`/`DELETE` baris `awcms_mini_blog_revisions`. "Restore revisi" (Issue #541) = insert revisi baru berisi konten lama, lalu update baris post/page aktif dari revisi itu.
4. **`search_vector` belum dipopulasikan** — kolom+index GIN sudah ada di posts/pages (Issue #537), tapi trigger/maintenance-nya Issue #539. Jangan asumsikan kolom ini sudah terisi sebelum #539 selesai.
5. **Rute publik tenant-scoped** (Issue #540) **wajib** ikuti ADR-0009: resolusi tenant lewat segmen path `tenant_code` (`/blog/{tenantCode}/...`), **bukan** subdomain/header — base ini LAN-first, tidak boleh berasumsi ada DNS/TLS publik.
6. **Idempotency**: posts sudah punya scope `blog_post_publish`/`_schedule`/`_archive`/`_restore`/`_purge` (Issue #538) — pola yang sama harus dipakai ulang untuk pages (#539) dan restore-revisi (#541), dengan scope string baru mengikuti pola `blog_<resource>_<action>`. `create`/`update` tetap tidak wajib (direkomendasikan saja, per doc issue #538).
7. **Audit**: `action` memakai string literal `blog.post.<verb>` (bukan verb generik singkat seperti modul lain) — pertahankan pola ini untuk `blog.page.*`/`blog.term.*`/`blog.revision.*` di issue berikutnya, jangan campur dengan gaya verb pendek.
8. **Multilingual** (Issue #542): kolom `locale` di posts/pages sekarang cuma satu nilai per baris (bukan JSONB per-locale). Kalau #542 butuh konten multi-locale per satu post, contoh pola yang sudah ada dan divalidasi di repo ini adalah `sql/021_awcms_mini_email_template_i18n_schema.sql` (JSONB per-locale) — pakai itu sebagai referensi, bukan mendesain skema baru dari nol.

## Belum ada — jangan asumsikan sudah dikerjakan

Belum ada endpoint pages/taxonomies/search, rute publik, restore-revisi, scheduled-publishing dispatcher, presentation extensions, atau admin UI. `src/modules/blog-content/README.md` §Belum tersedia berisi daftar lengkap per issue. `search_vector` di posts/pages sudah punya kolom+index GIN (#537) tapi **belum dipopulasikan** (trigger-nya #539) — jangan asumsikan query full-text sudah bisa dipakai.

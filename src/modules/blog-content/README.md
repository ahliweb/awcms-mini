# Blog Content

Implementasi Issue #537 (epic #536 — `blog_content`, `docs/adr/0009-public-tenant-scoped-routes.md`). **Modul domain pertama yang didaftarkan langsung di repo base ini** — sebelumnya `AGENTS.md` §Peta modul hanya mendaftarkan modul base generik; lihat catatan di sana untuk konteks.

## Scope Issue #537 (foundation only)

Hanya fondasi: module descriptor, domain validation, application placeholder read-only, dan schema database. **Tidak ada** endpoint admin/publik, OpenAPI/AsyncAPI, atau UI — itu Issue #538-#543 (lihat §Belum tersedia).

## Tabel (migration `026_awcms_mini_blog_content_schema.sql`)

Tujuh tabel persis sesuai doc issue #537 §Database Tables, semuanya tenant-scoped (`ENABLE` + `FORCE ROW LEVEL SECURITY`, satu policy `tenant_isolation` per tabel):

1. **`awcms_mini_blog_posts`** — `status`: `draft → review → scheduled → published → archived` (`domain/post-status.ts` `isValidStatusTransition`), `visibility`: `public | private | unlisted`. Slug unik per `(tenant_id, locale)` selama `deleted_at IS NULL` (partial unique index). `search_vector tsvector` + index GIN sudah ada di sini, tapi **belum dipopulasikan** — trigger/maintenance-nya Issue #539.
2. **`awcms_mini_blog_pages`** — struktur core sama seperti posts, plus `page_type` (`standard | landing | legal | system`), `parent_page_id` (self-FK), `menu_order`.
3. **`awcms_mini_blog_terms`** — kategori (`taxonomy_type = 'category'`, boleh `parent_id`) dan tag (`taxonomy_type = 'tag'`, `CHECK` menolak `parent_id` — lihat juga `domain/taxonomy-policy.ts` untuk cek pre-insert di level aplikasi). Slug unik per `(tenant_id, taxonomy_type)`.
4. **`awcms_mini_blog_post_terms`** — relasi many-to-many post↔term, tetap membawa `tenant_id` sendiri (bukan hanya lewat FK) supaya RLS bisa langsung mengisolasi baris join ini, konvensi yang sama seperti tabel relasi lain di base ini.
5. **`awcms_mini_blog_revisions`** — **append-only**, tidak pernah di-`UPDATE` aplikasi (pola sama seperti `awcms_mini_workflow_decisions`/`awcms_mini_audit_events`). "Restore revisi" berarti membuat revisi baru berisi konten lama, bukan menimpa baris manapun — jalur kode restore-nya sendiri Issue #541.
6. **`awcms_mini_blog_redirects`** — soft-deletable (bukan append-only), unik per `(tenant_id, from_path)` selama aktif.
7. **`awcms_mini_blog_settings`** — satu baris per tenant, `tenant_id` sendiri jadi primary key (pola sama seperti `awcms_mini_tenant_settings`, migration 002), bukan soft-deletable (dikonfigurasi, bukan dihapus).

Tidak ada `GRANT` eksplisit ke `awcms_mini_app` di migration 026 — migration 013 sudah memasang `ALTER DEFAULT PRIVILEGES` yang otomatis meng-grant tabel baru apa pun yang dibuat role pemilik (dipakai ulang oleh migration 025 untuk alasan yang sama).

## Permission seed (migration `027_awcms_mini_blog_content_permissions.sql`)

26 permission persis sesuai doc issue #537 §Permission Seed (`blog_content.posts.*`, `.pages.*`, `.taxonomies.*`, `.revisions.*`, `.settings.*`, `.seo.configure`, `.search.read`). Tidak ada role grant implisit — hanya assignable lewat Access & Users yang sudah ada.

## Domain validation (`domain/`)

- `content-validation.ts` — `validateBlogContentCore`: field inti yang dipakai bersama post & page (`title`, `slug`, `excerpt`, `contentJson`, `contentText`, `locale`).
- `post-status.ts` — enum status/visibility + `isValidStatusTransition` (satu sumber kebenaran dipakai ulang oleh endpoint lifecycle Issue #538 dan scheduled-publishing Issue #541).
- `slug-policy.ts` — `isValidSlug` (format) + `slugify` (derivasi dari title; pemanggil tetap wajib cek keunikan sendiri).
- `seo-validation.ts` — `validateSeoFields` (`seoTitle` ≤70 char, `metaDescription` ≤160 char, `canonicalUrl` harus URL http(s) absolut).
- `taxonomy-policy.ts` — `validateTermParent` (tag tidak boleh punya parent, term tidak boleh jadi parent dirinya sendiri) — pre-check aplikasi sebelum constraint DB `awcms_mini_blog_terms_tag_no_parent_check` tersentuh.

## Application placeholders (`application/`)

`blog-post-directory.ts` (`fetchBlogPostById`, `listBlogPostsByStatus`) dan `blog-taxonomy-directory.ts` (`fetchBlogTermsByTaxonomyType`) — query read-only tenant-scoped (filter `tenant_id` eksplisit + RLS, defense-in-depth sama seperti `identity-access/application/user-directory.ts`). Belum dipanggil endpoint manapun; disediakan supaya Issue #538/#539 langsung memakai ulang, bukan menulis query baru dari nol.

## Belum tersedia (backlog eksplisit, bukan kelalaian)

- Admin API (`POST/PATCH/DELETE /api/v1/blog/posts`, lifecycle actions) — Issue #538.
- Halaman, taksonomi, dan PostgreSQL full-text search sungguhan (trigger `search_vector`) — Issue #539.
- Rute publik, RSS, sitemap, SEO rendering — Issue #540 (lihat ADR-0009 untuk resolusi tenant tanpa sesi via `/blog/{tenantCode}/...`).
- Endpoint restore revisi dan scheduled-publishing dispatcher — Issue #541.
- Template, menu, widget, media/gallery, multilingual, theme mode, ads — Issue #542.
- Admin UI, dokumentasi akhir, hardening — Issue #543.
- OpenAPI/AsyncAPI belum diperbarui — tidak relevan sampai ada endpoint sungguhan (Issue #538 yang pertama menambahkannya).

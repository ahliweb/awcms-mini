# Blog Content

Implementasi Issue #537 dan #538 (epic #536 — `blog_content`, `docs/adr/0009-public-tenant-scoped-routes.md`). **Modul domain pertama yang didaftarkan langsung di repo base ini** — sebelumnya `AGENTS.md` §Peta modul hanya mendaftarkan modul base generik; lihat catatan di sana untuk konteks.

## Scope Issue #537 (foundation) vs Issue #538 (posts admin API)

Issue #537: module descriptor, domain validation, application placeholder read-only, dan schema database (migration 026/027) — lihat §Tabel dan §Permission seed.

Issue #538: API admin CRUD + lifecycle untuk blog post di `/api/v1/blog/posts` (lihat §Admin API — Blog Posts). Pages/taksonomi/search (#539), rute publik (#540), revisi/scheduled publishing (#541), presentation extensions (#542), dan admin UI (#543) masih backlog — lihat §Belum tersedia.

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

## Application (`application/`)

- `blog-post-directory.ts` — dulu (Issue #537) hanya placeholder read-only; Issue #538 melengkapinya dengan seluruh mutation post (`createBlogPost`, `updateBlogPost`, `softDeleteBlogPost`, `transitionBlogPostStatus`, `restoreBlogPost`, `purgeBlogPost`) di file yang sama — konvensi "satu directory, baca+tulis" yang sama seperti `email/application/email-template-directory.ts`, bukan dipecah jadi file service terpisah. `version` (kolom integer di schema #537) di-increment tiap `updateBlogPost`/`transitionBlogPostStatus` sukses — penanda perubahan monoton saja, **belum** ada optimistic-concurrency check (If-Match/expected-version) yang membacanya.
- `blog-taxonomy-directory.ts` (`fetchBlogTermsByTaxonomyType`) — masih placeholder read-only, dipakai ulang oleh Issue #539.

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

Doc issue #538 §ABAC Rules menuntut dua hal sekaligus dari **satu** permission `blog_content.posts.update`: "Editor/Admin dengan permission boleh edit semua post tenant" **dan** "Author boleh edit draft sendiri walau belum published" (tanpa permission itu). `domain/post-access-policy.ts`'s `evaluatePostUpdateAccess` mengekspresikan ini sebagai OR: role permission (jalur "Editor/Admin") ATAU (pemanggil = `authorTenantUserId` DAN `status !== 'published'`) (jalur "Author"). Fungsi ini **sengaja tidak** ditaruh di `identity-access/domain/access-control.ts`'s `evaluateAccess` generik — itu evaluator lintas-modul yang deny-biased (ADR-0004 "default deny, deny overrides allow"); override ALLOW berbasis kepemilikan resource adalah business logic spesifik `blog_content`, disusun di atas `evaluateAccess` (memanggilnya dulu, baru fallback ke ownership check kalau satu-satunya alasan deny adalah `default_deny`), bukan primitive lintas-modul baru seperti `self_approval_deny` yang sudah ada.

Dipakai oleh `PATCH /{id}` dan `POST /{id}/submit-review` (keduanya map ke permission `update`); endpoint lain (`publish`/`schedule`/`archive`/`restore`/`purge`) TIDAK punya ownership override — cek permission murni via `authorizeInTransaction`, sesuai literal doc issue #538: "Author may not publish unless granted `blog_content.posts.publish`".

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

## Belum tersedia (backlog eksplisit, bukan kelalaian)

- Halaman, taksonomi, dan PostgreSQL full-text search sungguhan (trigger `search_vector`) — Issue #539.
- Rute publik, RSS, sitemap, SEO rendering — Issue #540 (lihat ADR-0009 untuk resolusi tenant tanpa sesi via `/blog/{tenantCode}/...`).
- Endpoint restore revisi dan scheduled-publishing dispatcher — Issue #541.
- Template, menu, widget, media/gallery, multilingual, theme mode, ads — Issue #542.
- Admin UI, dokumentasi akhir, hardening — Issue #543.
- Optimistic-concurrency check yang membaca kolom `version` — kolom sudah di-increment tiap write, tapi belum ada endpoint yang menolak write berdasarkan `version` mismatch.

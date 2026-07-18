import { defineModule } from "../_shared/module-contract";

export const blogContentModule = defineModule({
  key: "blog_content",
  name: "Blog Content",
  version: "0.9.0",
  status: "active",
  description:
    "Tenant-scoped blog/content management (epic #536). Issue #537 laid the schema/permission foundation. Issue #538 added the blog post admin API (CRUD + lifecycle actions at /api/v1/blog/posts). Issue #539 added page/taxonomy CRUD, post-term relations, and PostgreSQL full-text search. Issue #540 added public (anonymous, no session) routes under /blog/{tenantCode}/... per ADR-0009: blog index, post detail, category/tag archives, search, RSS feed, and sitemap — every one enforcing the public visibility predicate (published + public, not deleted, published_at in the past) and safe content rendering (whitelist block renderer, no raw HTML). Issue #541 added append-only revision history for posts/pages (a significant title/contentJson/contentText change on PATCH snapshots one), revision list/detail/restore at /api/v1/blog/posts/{id}/revisions (restore requires explicit permission + Idempotency-Key, and itself appends a new revision — never overwrites one), the `bun run blog:publish:scheduled` job (idempotent, publishes due `status='scheduled'` posts per tenant), and the AsyncAPI domain-event contract for the module's full post/term/revision lifecycle (documented-contract-only, structured-logger-producer convention, same as every other module's events). Issue #542 added presentation/monetization extensions per its own Scope Control (does not rebuild the base media library, tenant system, RBAC/ABAC, audit, or theme engine): templates (/api/v1/blog/templates, whitelisted layout shape), hierarchical menus (/api/v1/blog/menus, one level of nesting, internal post/page or safe-URL items), position-based widgets (/api/v1/blog/widgets), advertisements with placement targeting and scheduling (/api/v1/blog/ads), a per-tenant blog theme override (/api/v1/blog/theme, falling back to `awcms_mini_tenants.default_theme`), an optional `translation_group_id` linking locale-variants of one post, and a new whitelisted `gallery` content_json block type for public image/video display (no new media table — reuses the existing safe-rendering convention). Issue #543 (final hardening) added the admin UI (dashboard, posts, pages, categories/tags, templates/widgets/menus/ads, settings — all under /admin/blog, reusing the existing AdminLayout shell and design tokens, no new UI framework), the blog settings API (/api/v1/blog/settings, backed by `awcms_mini_blog_settings` since migration 026 but unwired until now — blog title/description/RSS-enabled/sitemap-enabled live in that table's catch-all `settings` jsonb column, everything else in its own typed column), RSS/sitemap now respect the new enabled flags, and this descriptor's own `permissions`/`navigation` arrays (previously undeclared — every permission below already existed in the database via migrations 027/030, but the module catalog had no code-side declaration to sync/report against). No longer `experimental`: the full epic's acceptance criteria are met and it registers a working admin surface. First domain module registered directly in this base repo (see ADR-0009). Issue #564 (epic #555, not #536) added this descriptor's `settings.defaults` — see the `settings` field below for the four new keys and, importantly, why `rssEnabled`/`sitemapEnabled` are deliberately NOT among them despite appearing in the issue's own example JSON (`application/public-route-settings.ts`'s header comment has the full reasoning: they already live in, and stay in, `awcms_mini_blog_settings`). Issue #641 (epic `news_portal`) added automatic internal tag linking: a pure render-time transform (`domain/internal-tag-linking.ts`, Bun `HTMLRewriter`-based, never mutating stored content) that links matched tag names in a published post's rendered body to the tag's canonical archive URL, gated by a deployment-wide config (`BLOG_AUTO_INTERNAL_TAG_LINKS_*`), a per-tenant policy (`awcms_mini_blog_internal_tag_link_settings`, its own dedicated table/endpoint — see that migration's header for why it is NOT folded into `awcms_mini_blog_settings`), and a per-post opt-out column (`auto_internal_tag_links_disabled`), plus a preview endpoint (`GET /api/v1/blog/posts/{id}/internal-links/preview`).",
  // `module_management` + `logging` declared for Issue #845 (epic #818): both
  // are real value imports this module already makes — `application/
  // public-news-tenant-resolution.ts`/`public-route-settings.ts` call
  // `module_management`'s tenant-module/settings helpers, and
  // `application/blog-scheduled-publish.ts` calls `logging`'s
  // `recordAuditEvent`. Declaring them keeps `modules:dag:check` acyclic
  // (both are foundation modules that never depend back on `blog_content`).
  dependencies: [
    "tenant_admin",
    "identity_access",
    "module_management",
    "logging"
  ],
  type: "domain",
  // Issue #681 (epic #679, platform-hardening) — this module PROVIDES the
  // `public_content` capability (`_shared/ports/public-content-port.ts`,
  // implemented by `application/public-content-port-adapter.ts`) that
  // `news_portal`'s homepage section composer (Issue #637) consumes, and
  // CONSUMES `news_portal`'s `news_media` capability
  // (`_shared/ports/news-media-port.ts`) for R2-only-mode media reference
  // validation (Issue #636). Neither direction is a `dependencies` edge —
  // see that field's own comment above and `news_portal/module.ts`'s
  // identical note for why (Issue #632's original reasoning still holds).
  // Issue #643 (epic `social_publishing`) additionally CONSUMES
  // `social_publishing`'s own `social_publishing` capability
  // (`_shared/ports/social-publishing-port.ts`) — the manual publish route
  // (`pages/api/v1/blog/posts/[id]/publish.ts`) and the scheduled-publish
  // worker (`application/blog-scheduled-publish.ts`, wired by
  // `scripts/blog-scheduled-publish.ts`) both call
  // `SocialPublishingPort.onArticlePublished(...)` right after a post
  // transitions to `published`, inside the SAME transaction (plain DB
  // outbox-row writes, no external call — ADR-0006 compliant). `optional:
  // true` because a deployment that never enables `social_publishing`
  // (the default) must publish articles exactly as before.
  capabilities: {
    provides: ["public_content"],
    consumes: [
      { capability: "news_media", providedBy: "news_portal", optional: true },
      {
        capability: "social_publishing",
        providedBy: "social_publishing",
        optional: true
      }
    ]
  },
  navigation: [
    {
      labelKey: "admin.layout.nav_blog",
      path: "/admin/blog",
      order: 40,
      requiredPermission: "blog_content.posts.read"
    }
  ],
  permissions: [
    { activityCode: "posts", action: "read", description: "Read blog posts" },
    {
      activityCode: "posts",
      action: "create",
      description: "Create blog posts"
    },
    {
      activityCode: "posts",
      action: "update",
      description: "Update blog posts"
    },
    {
      activityCode: "posts",
      action: "publish",
      description: "Publish blog posts"
    },
    {
      activityCode: "posts",
      action: "schedule",
      description: "Schedule blog posts for future publishing"
    },
    {
      activityCode: "posts",
      action: "archive",
      description: "Archive blog posts"
    },
    {
      activityCode: "posts",
      action: "delete",
      description: "Soft delete blog posts"
    },
    {
      activityCode: "posts",
      action: "restore",
      description: "Restore soft-deleted blog posts"
    },
    {
      activityCode: "posts",
      action: "purge",
      description: "Purge soft-deleted blog posts"
    },
    {
      activityCode: "posts",
      action: "export",
      description: "Export blog posts"
    },
    { activityCode: "pages", action: "read", description: "Read blog pages" },
    {
      activityCode: "pages",
      action: "create",
      description: "Create blog pages"
    },
    {
      activityCode: "pages",
      action: "update",
      description: "Update blog pages"
    },
    {
      activityCode: "pages",
      action: "publish",
      description: "Publish blog pages"
    },
    {
      activityCode: "pages",
      action: "archive",
      description: "Archive blog pages"
    },
    {
      activityCode: "pages",
      action: "delete",
      description: "Soft delete blog pages"
    },
    {
      activityCode: "pages",
      action: "restore",
      description: "Restore soft-deleted blog pages"
    },
    {
      activityCode: "pages",
      action: "purge",
      description: "Purge soft-deleted blog pages"
    },
    {
      activityCode: "taxonomies",
      action: "read",
      description: "Read blog categories and tags"
    },
    {
      activityCode: "taxonomies",
      action: "configure",
      description: "Create, update, or delete blog categories and tags"
    },
    {
      activityCode: "revisions",
      action: "read",
      description: "Read blog post/page revision history"
    },
    {
      activityCode: "revisions",
      action: "restore",
      description: "Restore a blog post/page revision"
    },
    {
      activityCode: "settings",
      action: "read",
      description: "Read blog module settings"
    },
    {
      activityCode: "settings",
      action: "configure",
      description: "Update blog module settings"
    },
    {
      activityCode: "seo",
      action: "configure",
      description: "Configure blog SEO metadata defaults"
    },
    {
      activityCode: "search",
      action: "read",
      description: "Search blog posts and pages"
    },
    {
      activityCode: "templates",
      action: "read",
      description: "Read blog presentation templates"
    },
    {
      activityCode: "templates",
      action: "configure",
      description: "Create, update, or delete blog presentation templates"
    },
    {
      activityCode: "menus",
      action: "read",
      description: "Read blog navigation menus"
    },
    {
      activityCode: "menus",
      action: "configure",
      description: "Create, update, or delete blog navigation menus"
    },
    {
      activityCode: "widgets",
      action: "read",
      description: "Read blog widgets"
    },
    {
      activityCode: "widgets",
      action: "configure",
      description: "Create, update, or delete blog widgets"
    },
    {
      activityCode: "ads",
      action: "read",
      description: "Read blog advertisements"
    },
    {
      activityCode: "ads",
      action: "configure",
      description: "Create, update, or delete blog advertisements"
    },
    {
      activityCode: "theme",
      action: "read",
      description: "Read blog theme mode setting"
    },
    {
      activityCode: "theme",
      action: "configure",
      description: "Update blog theme mode setting"
    },
    // Issue #641 — deliberately separate from `settings.*` (see migration
    // 050's header comment for why this policy lives in its own dedicated
    // table/endpoint rather than folded into `awcms_mini_blog_settings`).
    {
      activityCode: "internal_links",
      action: "read",
      description: "Read automatic internal tag linking settings"
    },
    {
      activityCode: "internal_links",
      action: "configure",
      description: "Configure automatic internal tag linking settings"
    },
    {
      activityCode: "internal_links",
      action: "preview",
      description:
        "Preview automatic internal tag links for a post before publishing"
    }
  ],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/blog"
  },
  // Issue #564, epic #555. Non-secret public-route-behavior preferences
  // only — read/written through Module Management's existing generic
  // framework (GET/PATCH /api/v1/tenant/modules/blog_content/settings,
  // Issue #516/epic #510), not a bespoke settings mechanism.
  //
  // DELIBERATELY DOES NOT INCLUDE `rssEnabled`/`sitemapEnabled`, even
  // though the issue's own suggested example JSON lists them alongside
  // the four keys below. Those two flags already exist, already work, and
  // stay in `awcms_mini_blog_settings` (Issue #537/#543,
  // `application/blog-settings-directory.ts`'s `fetchBlogSettings`,
  // written via `PATCH /api/v1/blog/settings`, edited at
  // `/admin/blog/settings`) — `/news/feed.xml`, `/news/sitemap-news.xml`,
  // and their `/blog/{tenantCode}` counterparts already read and enforce
  // them today. Duplicating them into this second store would create two
  // disconnected, independently-writable sources of truth for the same
  // concept: an admin could flip "RSS enabled" off in this module's
  // generic `/admin/modules/blog_content` settings panel while the feed
  // route keeps reading the OLD `awcms_mini_blog_settings` value and
  // stays enabled — a real correctness bug, not a stylistic one. See
  // `application/public-route-settings.ts`'s header comment (the function
  // that merges both stores for route-handler reads) for the full
  // reasoning, and `README.md` §Public route settings for the summary.
  settings: {
    schemaVersion: 1,
    defaults: {
      // "domain_default" = behave exactly as before this issue: /news
      // resolves the tenant per PUBLIC_TENANT_RESOLUTION_MODE (doc 18).
      // "disabled" is the one new value — every /news route then returns
      // the same generic 404 an unresolved tenant or a disabled
      // blog_content module already produces (see
      // application/public-news-tenant-resolution.ts's withNewsTenant).
      // Scoped to /news only; the legacy /blog/{tenantCode} family has
      // its own independent switch, legacyTenantRouteEnabled below.
      publicRouteMode: "domain_default",
      // Used for SELF-REFERENTIAL link generation on /news only (canonical
      // <link>, RSS/sitemap <loc>/<link>, internal cross-links) — NOT
      // physical routing. /news/** are Astro file-based static routes;
      // their actual served path cannot be retargeted per-tenant at
      // runtime without a much larger catch-all-route restructuring,
      // which is out of this issue's scope. Falls back to the
      // PUBLIC_CANONICAL_BASE_PATH env var (Issue #556), then "/news",
      // when unset or invalid. See README.md §Public route settings for
      // the full writeup of this decision and its known limitation.
      publicBasePath: "/news",
      // Default true = today's behavior unchanged: /blog/{tenantCode}
      // remains fully available (ADR-0010, skill
      // awcms-mini-tenant-domain-routing's binding rule #3 — the legacy
      // family is never removed by default). Setting this false disables
      // all 7 /blog/{tenantCode} routes (index/detail/category/tag/
      // search/feed/sitemap) with the same generic 404 shape as an
      // unknown tenant code — a tenant-chosen opt-out, not a removal of
      // the route family itself.
      legacyTenantRouteEnabled: true,
      // Human-readable label for the /news route family (e.g. "News" vs
      // "Blog") — used in generated headings/titles/RSS channel title on
      // /news only. Distinct from awcms_mini_blog_settings.blogTitle,
      // which labels the CONTENT (an SEO-facing site title), not the
      // route family itself.
      publicLabel: "News"
    }
  },
  events: {
    asyncApiPath: "asyncapi/awcms-mini-domain-events.asyncapi.yaml",
    publishes: [
      "awcms-mini.blog-content.post.created",
      "awcms-mini.blog-content.post.updated",
      "awcms-mini.blog-content.post.submitted-for-review",
      "awcms-mini.blog-content.post.published",
      "awcms-mini.blog-content.post.scheduled",
      "awcms-mini.blog-content.post.archived",
      "awcms-mini.blog-content.post.deleted",
      "awcms-mini.blog-content.post.restored",
      "awcms-mini.blog-content.post.purged",
      "awcms-mini.blog-content.revision.created",
      "awcms-mini.blog-content.term.created",
      "awcms-mini.blog-content.term.updated",
      "awcms-mini.blog-content.settings.updated",
      "awcms-mini.blog-content.template.created",
      "awcms-mini.blog-content.template.updated",
      "awcms-mini.blog-content.template.deleted",
      "awcms-mini.blog-content.menu.created",
      "awcms-mini.blog-content.menu.updated",
      "awcms-mini.blog-content.menu.deleted",
      "awcms-mini.blog-content.widget.created",
      "awcms-mini.blog-content.widget.updated",
      "awcms-mini.blog-content.widget.deleted",
      "awcms-mini.blog-content.ad.created",
      "awcms-mini.blog-content.ad.updated",
      "awcms-mini.blog-content.ad.deleted",
      "awcms-mini.blog-content.theme.updated",
      "awcms-mini.blog-content.internal-tag-linking-policy.updated"
    ]
  },
  jobs: [
    {
      command: "bun run blog:publish:scheduled",
      purpose:
        "Publish every due `status='scheduled'` blog post (scheduled_at <= now()) for every active tenant. Idempotent — a post already published, or still in the future, is a no-op on re-run.",
      recommendedSchedule: "Every 1-5 minutes via cron/systemd timer.",
      environmentNotes:
        "No external provider call — pure database transition, safe to run in any deployment profile.",
      safeInOfflineLan: true
    }
  ]
});

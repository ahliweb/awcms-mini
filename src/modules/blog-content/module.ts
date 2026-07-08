import { defineModule } from "../_shared/module-contract";

export const blogContentModule = defineModule({
  key: "blog_content",
  name: "Blog Content",
  version: "0.7.0",
  status: "active",
  description:
    "Tenant-scoped blog/content management (epic #536). Issue #537 laid the schema/permission foundation. Issue #538 added the blog post admin API (CRUD + lifecycle actions at /api/v1/blog/posts). Issue #539 added page/taxonomy CRUD, post-term relations, and PostgreSQL full-text search. Issue #540 added public (anonymous, no session) routes under /blog/{tenantCode}/... per ADR-0009: blog index, post detail, category/tag archives, search, RSS feed, and sitemap — every one enforcing the public visibility predicate (published + public, not deleted, published_at in the past) and safe content rendering (whitelist block renderer, no raw HTML). Issue #541 added append-only revision history for posts/pages (a significant title/contentJson/contentText change on PATCH snapshots one), revision list/detail/restore at /api/v1/blog/posts/{id}/revisions (restore requires explicit permission + Idempotency-Key, and itself appends a new revision — never overwrites one), the `bun run blog:publish:scheduled` job (idempotent, publishes due `status='scheduled'` posts per tenant), and the AsyncAPI domain-event contract for the module's full post/term/revision lifecycle (documented-contract-only, structured-logger-producer convention, same as every other module's events). Issue #542 added presentation/monetization extensions per its own Scope Control (does not rebuild the base media library, tenant system, RBAC/ABAC, audit, or theme engine): templates (/api/v1/blog/templates, whitelisted layout shape), hierarchical menus (/api/v1/blog/menus, one level of nesting, internal post/page or safe-URL items), position-based widgets (/api/v1/blog/widgets), advertisements with placement targeting and scheduling (/api/v1/blog/ads), a per-tenant blog theme override (/api/v1/blog/theme, falling back to `awcms_mini_tenants.default_theme`), an optional `translation_group_id` linking locale-variants of one post, and a new whitelisted `gallery` content_json block type for public image/video display (no new media table — reuses the existing safe-rendering convention). Issue #543 (final hardening) added the admin UI (dashboard, posts, pages, categories/tags, templates/widgets/menus/ads, settings — all under /admin/blog, reusing the existing AdminLayout shell and design tokens, no new UI framework), the blog settings API (/api/v1/blog/settings, backed by `awcms_mini_blog_settings` since migration 026 but unwired until now — blog title/description/RSS-enabled/sitemap-enabled live in that table's catch-all `settings` jsonb column, everything else in its own typed column), RSS/sitemap now respect the new enabled flags, and this descriptor's own `permissions`/`navigation` arrays (previously undeclared — every permission below already existed in the database via migrations 027/030, but the module catalog had no code-side declaration to sync/report against). No longer `experimental`: the full epic's acceptance criteria are met and it registers a working admin surface. First domain module registered directly in this base repo (see ADR-0009).",
  dependencies: ["tenant_admin", "identity_access"],
  type: "domain",
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
    }
  ],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/blog"
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
      "awcms-mini.blog-content.theme.updated"
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

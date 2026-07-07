import { defineModule } from "../_shared/module-contract";

export const blogContentModule = defineModule({
  key: "blog_content",
  name: "Blog Content",
  version: "0.5.0",
  status: "experimental",
  description:
    "Tenant-scoped blog/content management (epic #536). Issue #537 laid the schema/permission foundation. Issue #538 added the blog post admin API (CRUD + lifecycle actions at /api/v1/blog/posts). Issue #539 added page/taxonomy CRUD, post-term relations, and PostgreSQL full-text search. Issue #540 added public (anonymous, no session) routes under /blog/{tenantCode}/... per ADR-0009: blog index, post detail, category/tag archives, search, RSS feed, and sitemap — every one enforcing the public visibility predicate (published + public, not deleted, published_at in the past) and safe content rendering (whitelist block renderer, no raw HTML). Issue #541 added append-only revision history for posts/pages (a significant title/contentJson/contentText change on PATCH snapshots one), revision list/detail/restore at /api/v1/blog/posts/{id}/revisions (restore requires explicit permission + Idempotency-Key, and itself appends a new revision — never overwrites one), the `bun run blog:publish:scheduled` job (idempotent, publishes due `status='scheduled'` posts per tenant), and the AsyncAPI domain-event contract for the module's full post/term/revision lifecycle (documented-contract-only, structured-logger-producer convention, same as every other module's events). Presentation extensions (#542) and admin UI (#543) are still to come. First domain module registered directly in this base repo (see ADR-0009).",
  dependencies: ["tenant_admin", "identity_access"],
  type: "domain",
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
      "awcms-mini.blog-content.settings.updated"
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

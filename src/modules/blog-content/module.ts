import { defineModule } from "../_shared/module-contract";

export const blogContentModule = defineModule({
  key: "blog_content",
  name: "Blog Content",
  version: "0.4.0",
  status: "experimental",
  description:
    "Tenant-scoped blog/content management (epic #536). Issue #537 laid the schema/permission foundation. Issue #538 added the blog post admin API (CRUD + lifecycle actions at /api/v1/blog/posts). Issue #539 added page/taxonomy CRUD, post-term relations, and PostgreSQL full-text search. Issue #540 adds public (anonymous, no session) routes under /blog/{tenantCode}/... per ADR-0009: blog index, post detail, category/tag archives, search, RSS feed, and sitemap — every one enforcing the public visibility predicate (published + public, not deleted, published_at in the past) and safe content rendering (whitelist block renderer, no raw HTML). Revisions/scheduled-publishing (#541), presentation extensions (#542), and admin UI (#543) are still to come. First domain module registered directly in this base repo (see ADR-0009).",
  dependencies: ["tenant_admin", "identity_access"],
  type: "domain",
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/blog"
  }
});

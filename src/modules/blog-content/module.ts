import { defineModule } from "../_shared/module-contract";

export const blogContentModule = defineModule({
  key: "blog_content",
  name: "Blog Content",
  version: "0.3.0",
  status: "experimental",
  description:
    "Tenant-scoped blog/content management (epic #536). Issue #537 laid the schema/permission foundation (posts, pages, categories/tags, post-term relations, append-only revisions, redirects, per-tenant settings). Issue #538 added the blog post admin API (CRUD + lifecycle actions at /api/v1/blog/posts) with RBAC/ABAC, idempotency, and audit. Issue #539 adds page CRUD (/api/v1/blog/pages), category/tag CRUD (/api/v1/blog/terms), post-term relation assignment (via posts' termIds), and PostgreSQL full-text search (/api/v1/blog/search, admin; a public-safe search helper for #540 to consume). Public routes (#540), revisions/scheduled-publishing (#541), presentation extensions (#542), and admin UI (#543) are still to come. First domain module registered directly in this base repo (see ADR-0009).",
  dependencies: ["tenant_admin", "identity_access"],
  type: "domain",
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/blog"
  }
});

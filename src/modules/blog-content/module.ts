import { defineModule } from "../_shared/module-contract";

export const blogContentModule = defineModule({
  key: "blog_content",
  name: "Blog Content",
  version: "0.2.0",
  status: "experimental",
  description:
    "Tenant-scoped blog/content management (epic #536). Issue #537 laid the schema/permission foundation (posts, pages, categories/tags, post-term relations, append-only revisions, redirects, per-tenant settings). Issue #538 adds the tenant-scoped blog post admin API — CRUD plus lifecycle actions (submit-review, publish, schedule, archive, restore, purge) at /api/v1/blog/posts, guarded by RBAC/ABAC (including an author-may-edit-their-own-unpublished-draft override), Idempotency-Key on high-risk mutations, and audit events. Pages/taxonomy/search (#539), public routes (#540), revisions/scheduled-publishing (#541), presentation extensions (#542), and admin UI (#543) are still to come. First domain module registered directly in this base repo (see ADR-0009).",
  dependencies: ["tenant_admin", "identity_access"],
  type: "domain",
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/blog"
  }
});

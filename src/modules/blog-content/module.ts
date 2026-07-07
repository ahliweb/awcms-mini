import { defineModule } from "../_shared/module-contract";

export const blogContentModule = defineModule({
  key: "blog_content",
  name: "Blog Content",
  version: "0.1.0",
  status: "experimental",
  description:
    "Tenant-scoped blog/content management (Issue #537, epic #536) — foundation only: core schema for posts, pages, categories/tags, post-term relations, append-only revisions, redirects, and per-tenant blog settings, plus domain validation (slug, status/visibility lifecycle, SEO fields, taxonomy rules) and read-only application placeholders. No admin/public API, no OpenAPI/AsyncAPI contract, and no UI yet — those land in Issues #538-#543. First domain module registered directly in this base repo (see ADR-0009).",
  dependencies: ["tenant_admin", "identity_access"],
  type: "domain"
});

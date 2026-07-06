import { defineModule } from "../_shared/module-contract";

export const formDraftsModule = defineModule({
  key: "form_drafts",
  name: "Form Drafts",
  version: "1.0.0",
  status: "active",
  description:
    "Generic, domain-agnostic server-side draft store for the reusable wizard pattern (create/update/read/submit/delete a tenant-scoped JSONB payload, denylist-validated against secret-shaped fields). No domain-specific logic — a derived module owns what a draft's payload actually means.",
  dependencies: ["identity_access"],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/form-drafts"
  }
});

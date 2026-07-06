import { defineModule } from "../_shared/module-contract";

export const emailModule = defineModule({
  key: "email",
  name: "Email",
  version: "0.3.0",
  status: "active",
  description:
    "Reusable, provider-neutral email service (Issues #493-#495, #498, epic #492): message/recipient/attachment DTOs, an `EmailProvider` port, Mailketing configuration validation, the tenant-scoped schema/RLS/delivery queue (`sql/020`/`021`), the real Mailketing adapter, the claim/send/finalize dispatcher (`bun run email:dispatch`), and template management (CRUD + soft-delete/restore, per-category variable allowlists, i18n locale variants, admin preview) at `/api/v1/email/templates`. Generic infrastructure — analogous to `sync_storage`'s object-storage port — for password reset, system announcements, and workflow notifications; not a domain-specific 'send a receipt' feature (see README §Relationship to historical issue #390). No endpoint yet actually enqueues a message (Issues #496/#497).",
  dependencies: ["tenant_admin", "profile_identity"],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/email"
  }
});

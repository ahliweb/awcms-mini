import { defineModule } from "../_shared/module-contract";

export const emailModule = defineModule({
  key: "email",
  name: "Email",
  version: "0.4.0",
  status: "active",
  description:
    "Reusable, provider-neutral email service (Issues #493-#498, epic #492): message/recipient/attachment DTOs, an `EmailProvider` port, Mailketing configuration validation, the tenant-scoped schema/RLS/delivery queue (`sql/020`/`021`), the real Mailketing adapter, the claim/send/finalize dispatcher (`bun run email:dispatch`), template management (CRUD + soft-delete/restore, per-category variable allowlists, i18n locale variants, admin preview) at `/api/v1/email/templates`, password reset (`/api/v1/auth/password/{forgot,reset}`), and bulk announcement/notification workflows (`/api/v1/email/announcements`, tenant/role/explicit-user targeting, two-tier ABAC, idempotent). Generic infrastructure — analogous to `sync_storage`'s object-storage port — for password reset, system announcements, and workflow notifications; not a domain-specific 'send a receipt' feature (see README §Relationship to historical issue #390).",
  dependencies: ["tenant_admin", "profile_identity", "identity_access"],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/email"
  },
  events: {
    asyncApiPath: "asyncapi/awcms-mini-domain-events.asyncapi.yaml",
    publishes: [
      "awcms-mini.email.message.queued",
      "awcms-mini.email.message.sent",
      "awcms-mini.email.message.failed"
    ]
  }
});

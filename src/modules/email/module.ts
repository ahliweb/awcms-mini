import { defineModule } from "../_shared/module-contract";

export const emailModule = defineModule({
  key: "email",
  name: "Email",
  version: "0.2.0",
  status: "active",
  description:
    "Reusable, provider-neutral email service (Issues #493-#495, epic #492): message/recipient/attachment DTOs, an `EmailProvider` port, Mailketing configuration validation, the tenant-scoped schema/RLS/delivery queue (`sql/020`), the real Mailketing adapter, and the claim/send/finalize dispatcher (`bun run email:dispatch`). Generic infrastructure — analogous to `sync_storage`'s object-storage port — for password reset, system announcements, and workflow notifications; not a domain-specific 'send a receipt' feature (see README §Relationship to historical issue #390). No endpoints/admin UI yet (Issues #496-#499).",
  dependencies: ["tenant_admin", "profile_identity"]
});

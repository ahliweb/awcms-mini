import { defineModule } from "../_shared/module-contract";

export const emailModule = defineModule({
  key: "email",
  name: "Email",
  version: "0.1.0",
  status: "experimental",
  description:
    "Reusable, provider-neutral email service boundary (Issue #493, epic #492): message/recipient/attachment DTOs, an `EmailProvider` port, and Mailketing configuration validation. Generic infrastructure — analogous to `sync_storage`'s object-storage port — for password reset, system announcements, and workflow notifications; not a domain-specific 'send a receipt' feature (see README §Relationship to historical issue #390). Schema, the Mailketing adapter, dispatcher, and endpoints land in Issues #494-#499; `status` moves to `active` once #494's migration exists.",
  dependencies: ["tenant_admin"]
});

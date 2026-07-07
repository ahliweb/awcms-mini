import { defineModule } from "../_shared/module-contract";

export const emailModule = defineModule({
  key: "email",
  name: "Email",
  version: "0.5.0",
  status: "active",
  description:
    "Reusable, provider-neutral email service (Issues #493-#499, epic #492): message/recipient/attachment DTOs, an `EmailProvider` port, Mailketing configuration validation, the tenant-scoped schema/RLS/delivery queue (`sql/020`/`021`/`024`), the real Mailketing adapter, the claim/send/finalize dispatcher (`bun run email:dispatch`, dispatch-time suppression re-check), template management (CRUD + soft-delete/restore, per-category variable allowlists, i18n locale variants, admin preview) at `/api/v1/email/templates`, password reset (`/api/v1/auth/password/{forgot,reset}`), bulk announcement/notification workflows (`/api/v1/email/announcements`, tenant/role/explicit-user targeting, two-tier ABAC, idempotent), and admin observability/ops (`/api/v1/email/messages` queue diagnostics + cancel, `/api/v1/email/suppressions` manual suppression CRUD, `GET /api/v1/reports/email-health`, `bun run security:readiness`'s provider-config check). Generic infrastructure — analogous to `sync_storage`'s object-storage port — for password reset, system announcements, and workflow notifications; not a domain-specific 'send a receipt' feature (see README §Relationship to historical issue #390).",
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
      "awcms-mini.email.message.failed",
      "awcms-mini.email.message.suppressed",
      "awcms-mini.email.message.cancelled"
    ]
  },
  jobs: [
    {
      command: "bun run email:dispatch",
      purpose:
        "Drain the due email delivery queue (claim-lease, retry/backoff, circuit breaker) for every active tenant.",
      recommendedSchedule: "Every 1-2 minutes via cron/systemd timer.",
      environmentNotes:
        'No-op when EMAIL_ENABLED is not "true" — safe to schedule regardless of deployment profile (e.g. offline/LAN).',
      safeInOfflineLan: true
    },
    {
      command: "bun run email:provider:health",
      purpose:
        "Live network check against the configured email provider's health endpoint.",
      recommendedSchedule:
        "On-demand — operators run manually or from a deployment smoke-test step, not on a recurring schedule.",
      environmentNotes:
        'Exits 0 (no-op) when EMAIL_ENABLED is not "true". Requires real network egress to the provider — not run in CI.',
      safeInOfflineLan: false
    },
    {
      command: "bun run email:templates:seed-defaults",
      purpose:
        "Seed the default system email templates for one tenant (idempotent — skips any template_key that already has an active row).",
      recommendedSchedule:
        "On-demand — once per tenant, typically right after tenant setup.",
      environmentNotes:
        "Requires --tenant=<tenantId> --actor=<tenantUserId> arguments.",
      safeInOfflineLan: true
    }
  ]
});

import { defineModule } from "../_shared/module-contract";

export const socialPublishingModule = defineModule({
  key: "social_publishing",
  name: "Social Publishing",
  version: "0.1.0",
  status: "active",
  description:
    "Provider-neutral social auto-posting outbox and connector foundation (Issue #643, epic `social_publishing` #643-#647). Full-online-only feature — see `domain/social-publishing-config.ts`'s `SOCIAL_PUBLISHING_ENABLED`/`SOCIAL_PUBLISHING_PROFILE` deployment gate (mirrors `AUTH_ONLINE_SECURITY_ENABLED`/`AUTH_ONLINE_SECURITY_PROFILE`'s established pattern), never applies to offline/LAN profiles. Adds account connections (`awcms_mini_social_accounts`, tokens stored only as opaque `token_reference` pointers into external secret storage — never plain-text), publish rules (`awcms_mini_social_publish_rules`, one per account/trigger-event, optional approval gate), caption templates (`awcms_mini_social_publish_templates`), an idempotent outbox (`awcms_mini_social_publish_jobs`, one row per article/account/action via a deterministic idempotency key), an append-only per-attempt audit trail (`awcms_mini_social_publish_attempts`), and a per-tenant auto-posting master switch (`awcms_mini_social_publishing_settings`). This issue ships ZERO real provider adapters — no Meta/LinkedIn/Telegram HTTP call exists anywhere in this module; `domain/social-provider-adapter.ts` defines the pluggable interface and `infrastructure/social-provider-registry.ts` starts with an EMPTY registry that issues #644 (Meta), #645 (LinkedIn), and #646 (Telegram) populate from their own composition root. Job creation (`application/create-social-publish-jobs.ts`) is invoked by `blog_content`'s publish route/scheduled-publish worker via the `SocialPublishingPort` (`_shared/ports/social-publishing-port.ts`) right after an ELIGIBLE (public + published, never draft/private/archived/review/soft-deleted) article publishes — plain DB outbox-row writes inside the SAME transaction (ADR-0006 compliant: no external call happens there). The actual provider call happens later, entirely outside any DB transaction, via `application/social-publish-dispatch.ts` (`bun run social-publishing:dispatch`) — a claim/call/finalize outbox dispatcher with per-provider circuit breaker, timeout, and exponential retry/backoff to a terminal `failed` state, mirroring `sync-storage/application/object-dispatch.ts`'s established shape. See `.claude/skills/awcms-mini-social-publishing/SKILL.md` for full design rationale.",
  dependencies: ["tenant_admin", "identity_access"],
  type: "domain",
  // Consumes `blog_content`'s `public_content` capability is NOT declared
  // here — the composition root (route/script) already has the published
  // article's fields in hand and passes them directly into
  // `SocialPublishingPort.onArticlePublished(...)`; this module never needs
  // to re-fetch post data itself. It DOES provide the `social_publishing`
  // capability `blog_content` consumes (see `blog-content/module.ts`'s own
  // `capabilities.consumes` entry) and consumes `news_portal`'s `news_media`
  // capability (to resolve a verified R2 image URL for the job snapshot) —
  // both `optional: true` mirroring the existing `news_media`/
  // `public_content` port precedent from Issue #681.
  capabilities: {
    provides: ["social_publishing"],
    consumes: [
      { capability: "news_media", providedBy: "news_portal", optional: true }
    ]
  },
  events: {
    asyncApiPath: "asyncapi/awcms-mini-domain-events.asyncapi.yaml",
    publishes: [
      "awcms-mini.social-publishing.account.connected",
      "awcms-mini.social-publishing.account.disconnected",
      "awcms-mini.social-publishing.account.needs-reauth",
      "awcms-mini.social-publishing.account.verified",
      "awcms-mini.social-publishing.account.verification-failed",
      "awcms-mini.social-publishing.rule.created",
      "awcms-mini.social-publishing.rule.updated",
      "awcms-mini.social-publishing.rule.deleted",
      "awcms-mini.social-publishing.job.created",
      "awcms-mini.social-publishing.job.approved",
      "awcms-mini.social-publishing.job.cancelled",
      "awcms-mini.social-publishing.job.retry-requested",
      "awcms-mini.social-publishing.job.published",
      "awcms-mini.social-publishing.job.publish-failed",
      "awcms-mini.social-publishing.job.publish-failed-terminal",
      "awcms-mini.social-publishing.job.rate-limited",
      "awcms-mini.social-publishing.job.needs-reauth"
    ]
  },
  navigation: [
    {
      labelKey: "admin.layout.nav_social_publishing_accounts",
      path: "/admin/social-publishing/accounts",
      order: 90,
      requiredPermission: "social_publishing.accounts.read"
    },
    {
      labelKey: "admin.layout.nav_social_publishing_rules",
      path: "/admin/social-publishing/rules",
      order: 91,
      requiredPermission: "social_publishing.rules.read"
    },
    {
      labelKey: "admin.layout.nav_social_publishing_jobs",
      path: "/admin/social-publishing/jobs",
      order: 92,
      requiredPermission: "social_publishing.jobs.read"
    }
  ],
  permissions: [
    {
      activityCode: "accounts",
      action: "read",
      description: "Read connected social publishing accounts"
    },
    {
      activityCode: "accounts",
      action: "connect",
      description:
        "Connect or reconnect/reauthorize a social publishing account"
    },
    {
      activityCode: "accounts",
      action: "disconnect",
      description: "Disconnect a social publishing account"
    },
    {
      activityCode: "accounts",
      action: "verify",
      description:
        "Verify a connected social publishing account/channel can be posted to before enabling auto-posting"
    },
    {
      activityCode: "rules",
      action: "read",
      description: "Read social publishing rules and templates"
    },
    {
      activityCode: "rules",
      action: "configure",
      description:
        "Create, update, or delete social publishing rules and templates"
    },
    {
      activityCode: "jobs",
      action: "read",
      description: "Read social publishing jobs and their attempts"
    },
    {
      activityCode: "jobs",
      action: "approve",
      description: "Approve a social publishing job pending external posting"
    },
    {
      activityCode: "jobs",
      action: "cancel",
      description: "Cancel a social publishing job"
    },
    {
      activityCode: "jobs",
      action: "retry",
      description:
        "Retry a failed/rate-limited/needs-reauth social publishing job"
    },
    {
      activityCode: "logs",
      action: "read",
      description: "Read social publishing audit/attempt logs"
    }
  ],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/social-publishing"
  },
  jobs: [
    {
      command: "bun run social-publishing:dispatch",
      purpose:
        "Dispatch due awcms_mini_social_publish_jobs rows to their registered provider adapter (claim/call/finalize outbox pattern, circuit breaker + timeout + retry/backoff). A no-op when social_publishing is deployment-disabled or a job's provider has no registered adapter (foundation issue ships zero real adapters).",
      recommendedSchedule: "Every 1-2 minutes via cron/systemd timer.",
      environmentNotes:
        'No-op when SOCIAL_PUBLISHING_ENABLED is not "true" or SOCIAL_PUBLISHING_PROFILE is not "full_online". Requires real network egress to social platform APIs once a real adapter is registered (#644/#645/#646) — not a pure database operation.',
      safeInOfflineLan: false
    }
  ]
});

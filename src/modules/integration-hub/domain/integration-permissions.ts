/**
 * Single source of truth for `integration_hub`'s permission catalog (Issue
 * #754) — same "module declares its own list once, `module.ts` + the
 * migration + every route handler reuse it" convention `data-lifecycle/
 * domain/data-lifecycle-permissions.ts` already established. The migration
 * (`sql/072_awcms_mini_integration_hub_permissions.sql`) is a verbatim,
 * hand-kept-in-sync copy (SQL cannot import TypeScript) — any change here
 * MUST be mirrored there.
 */
export type IntegrationHubPermissionDescriptor = {
  activityCode: string;
  action: string;
  description: string;
};

export const INTEGRATION_HUB_PERMISSIONS: readonly IntegrationHubPermissionDescriptor[] =
  [
    {
      activityCode: "endpoints",
      action: "read",
      description:
        "Read inbound webhook endpoint configuration (secret pointers only, never resolved secret values)"
    },
    {
      activityCode: "endpoints",
      action: "create",
      description: "Register a new inbound webhook endpoint"
    },
    {
      activityCode: "endpoints",
      action: "delete",
      description: "Soft-delete an inbound webhook endpoint"
    },
    {
      activityCode: "endpoints",
      action: "configure",
      description: "Rotate an inbound webhook endpoint secret"
    },
    {
      activityCode: "endpoints",
      action: "enable",
      description: "Resume a paused inbound webhook endpoint"
    },
    {
      activityCode: "endpoints",
      action: "disable",
      description: "Pause an inbound webhook endpoint"
    },
    {
      activityCode: "subscriptions",
      action: "read",
      description: "Read outbound event subscriptions"
    },
    {
      activityCode: "subscriptions",
      action: "create",
      description: "Register a new outbound event subscription"
    },
    {
      activityCode: "subscriptions",
      action: "delete",
      description: "Soft-delete an outbound event subscription"
    },
    {
      activityCode: "subscriptions",
      action: "enable",
      description: "Resume a paused outbound event subscription"
    },
    {
      activityCode: "subscriptions",
      action: "disable",
      description: "Pause an outbound event subscription"
    },
    {
      activityCode: "deliveries",
      action: "read",
      description:
        "Read inbound/outbound delivery status and attempt history, including dead-lettered deliveries"
    },
    {
      activityCode: "deliveries",
      action: "replay",
      description:
        "Replay a failed/dead-lettered outbound delivery to a subscription"
    },
    {
      activityCode: "health",
      action: "read",
      description: "Read adapter up/down/degraded health state"
    },
    {
      activityCode: "adapters",
      action: "read",
      description:
        "Read the static provider adapter registry (code-declared metadata only)"
    }
  ];

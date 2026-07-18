import { defineModule } from "../_shared/module-contract";

export const profileIdentityModule = defineModule({
  key: "profile_identity",
  name: "Profile Identity",
  version: "1.1.0",
  status: "active",
  description:
    "Canonical person/organization party lifecycle (Issue #748, epic #738 platform-evolution Wave 2, completing the Issue #680/#679 foundation): full CRUD/list/search/archive/restore, effective-dated typed identifiers with provenance/verification/masking, effective-dated addresses/communication channels, generic (non-hardcoded) party-to-party relationships and authorized-representative records, deterministic+heuristic duplicate-candidate detection, and an approval-gated, idempotent, concurrency-safe merge workflow with immutable merge history. `dependencies: [\"tenant_admin\"]` was already correct (Issue #680, epic #679) — the registry-wide 3-cycle that issue fixed came entirely from `tenant_admin` ALSO listing `profile_identity`/`identity_access` as its own dependencies (removed there), not from this module's own array. Issue #845 (epic #818) then added `logging` (`application/*-directory.ts` + `merge-workflow.ts` call `logging`'s `recordAuditEvent`, a real value import; acyclic because `logging` depends only on `tenant_admin`). Issue #845 also handled a SECOND previously-undeclared edge here — `merge-workflow.ts`'s `appendDomainEvent` call into `domain_event_runtime` — but that one is DELIBERATELY not declared: `domain_event_runtime` depends on `identity_access`, which depends on this module, so `profile_identity -> domain_event_runtime` would close a real 3-cycle (`profile_identity -> domain_event_runtime -> identity_access -> profile_identity`). Instead the outbox append is now injected as a `DomainEventAppendPort` (`_shared/ports/domain-event-append-port.ts`), wired at the composition root (`pages/api/v1/profile-merge-requests/[id]/execute.ts`), so this Core module no longer imports the System-layer event runtime at all — the ADR-0011/#826/#848 inversion pattern.",
  dependencies: ["tenant_admin", "logging"],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/profiles"
  },
  events: {
    asyncApiPath: "asyncapi/awcms-mini-domain-events.asyncapi.yaml",
    publishes: ["awcms-mini.profile-identity.profile.merged"]
  },
  capabilities: {
    // Issue #748 — lets a future domain module resolve a party
    // existence/summary/merge-mapping/public-safe projection without
    // importing profile_identity's tables/application/domain code
    // directly (ADR-0011). See `_shared/ports/party-directory-port.ts`.
    provides: ["party_directory"]
  },
  navigation: [
    {
      labelKey: "admin.layout.nav_profile_identity_parties",
      path: "/admin/profile-identity",
      order: 30,
      requiredPermission: "profile_identity.profile_management.read"
    },
    {
      labelKey: "admin.layout.nav_profile_identity_merge_requests",
      path: "/admin/profile-identity/merge-requests",
      order: 31,
      requiredPermission: "profile_identity.profile_merge.read"
    }
  ],
  permissions: [
    {
      activityCode: "profile_management",
      action: "read",
      description: "Read profile records"
    },
    {
      activityCode: "profile_management",
      action: "create",
      description: "Create profile records"
    },
    {
      activityCode: "profile_management",
      action: "update",
      description: "Update profile records"
    },
    {
      activityCode: "profile_management",
      action: "delete",
      description: "Soft delete profile records"
    },
    {
      activityCode: "profile_management",
      action: "restore",
      description: "Restore soft-deleted profile records"
    },
    {
      activityCode: "profile_management",
      action: "purge",
      description: "Permanently purge a soft-deleted profile record"
    },
    {
      activityCode: "profile_merge",
      action: "read",
      description: "Read profile merge requests"
    },
    {
      activityCode: "profile_merge",
      action: "create",
      description: "Create a profile merge request"
    },
    {
      activityCode: "profile_merge",
      action: "approve",
      description: "Approve profile merge requests"
    },
    {
      activityCode: "profile_merge",
      action: "merge",
      description: "Execute an approved profile merge request"
    },
    {
      activityCode: "identifiers",
      action: "read",
      description: "Read profile identifiers (masked by default)"
    },
    {
      activityCode: "identifiers",
      action: "create",
      description: "Add a profile identifier"
    },
    {
      activityCode: "identifiers",
      action: "update",
      description: "Update a profile identifier (verification, validity window)"
    },
    {
      activityCode: "identifiers",
      action: "delete",
      description: "Soft delete a profile identifier"
    },
    {
      activityCode: "addresses",
      action: "read",
      description: "Read profile addresses"
    },
    {
      activityCode: "addresses",
      action: "create",
      description: "Add a profile address"
    },
    {
      activityCode: "addresses",
      action: "update",
      description: "Update a profile address"
    },
    {
      activityCode: "addresses",
      action: "delete",
      description: "Soft delete a profile address"
    },
    {
      activityCode: "channels",
      action: "read",
      description: "Read profile communication channels"
    },
    {
      activityCode: "channels",
      action: "create",
      description: "Add a profile communication channel"
    },
    {
      activityCode: "channels",
      action: "update",
      description: "Update a profile communication channel"
    },
    {
      activityCode: "channels",
      action: "delete",
      description: "Soft delete a profile communication channel"
    },
    {
      activityCode: "relationships",
      action: "read",
      description: "Read party-to-party relationships"
    },
    {
      activityCode: "relationships",
      action: "create",
      description: "Create a party-to-party relationship"
    },
    {
      activityCode: "relationships",
      action: "delete",
      description: "End an active party-to-party relationship"
    },
    {
      activityCode: "duplicate_candidates",
      action: "read",
      description: "Read duplicate-candidate records"
    },
    {
      activityCode: "duplicate_candidates",
      action: "analyze",
      description: "Trigger an on-demand duplicate-candidate scan"
    },
    {
      activityCode: "duplicate_candidates",
      action: "update",
      description:
        "Review a duplicate candidate (confirm or mark false positive)"
    }
  ]
});

export type TenantContext = {
  tenantId: string;
  tenantUserId: string;
  identityId: string;
  profileId?: string;
  defaultOfficeId?: string;
  roles: string[];
  correlationId?: string;
  requestId?: string;
};

export type AccessAction =
  | "read"
  | "create"
  | "update"
  | "delete"
  | "post"
  | "cancel"
  | "approve"
  | "export"
  | "send"
  | "configure"
  | "analyze"
  | "assign"
  | "restore"
  | "purge"
  | "retry"
  | "sync"
  | "enable"
  | "disable"
  | "check"
  | "publish"
  | "schedule"
  | "archive"
  // Issue #562 (tenant_domain): migration 032 seeded
  // `tenant_domain.domains.verify`/`.set_primary` back in Issue #557, but
  // no consumer added the actions to this union until the API landed —
  // same "seed permission first, add the action when a real endpoint
  // needs it" pattern `restore`/`purge`/`retry` already established (see
  // `identity-access/README.md`). Neither is added to
  // `HIGH_RISK_ACTIONS` below: `verify` only flips status based on fields
  // already on the row (no destructive/irreversible effect, same
  // reasoning as `retry`), and `set_primary` reassigns a routing flag
  // that can always be reassigned again — not destructive like
  // delete/purge. Both endpoints still require `Idempotency-Key` and are
  // explicitly audited regardless of this classification, matching
  // `retry`'s documented precedent (`isHighRiskAction` is metadata, not a
  // gate on idempotency/audit requirements).
  | "verify"
  | "set_primary"
  // Issue #643 (social_publishing): `accounts.connect`/`accounts.disconnect`
  // — connecting/reconnecting a social account writes a `token_reference`
  // (secret-storage pointer) and disconnecting clears it; both classified
  // `HIGH_RISK_ACTIONS` below since they change credential-bearing state,
  // matching `configure`'s classification rather than `verify`'s.
  | "connect"
  | "disconnect"
  // Issue #641 (blog_content): `GET /api/v1/blog/posts/{id}/internal-links/
  // preview` needed a permission distinct from `posts.read`/`internal_links.
  // read` (an editor may be allowed to preview which terms would be
  // auto-linked without also getting broad internal-link *configuration*
  // access) — same "seed permission first, add the action when a real
  // endpoint needs it" precedent as `verify`/`set_primary` above. Read-only,
  // not added to `HIGH_RISK_ACTIONS`.
  | "preview"
  // Issue #742 (domain_event_runtime): migration 056 seeds
  // `domain_event_runtime.deliveries.replay`/`.consumers.manage`, first
  // consumers `POST /api/v1/domain-events/deliveries/{id}/replay` and
  // `POST /api/v1/domain-events/consumers/{name}/{pause,resume}` in this
  // issue. Neither added to `HIGH_RISK_ACTIONS` — `replay` re-attempts a
  // delivery whose side effect is required to be idempotent by event ID
  // (same non-destructive reasoning as `retry`), and `manage` (pause/
  // resume) only flips a per-tenant boolean that can always be flipped
  // back (same reasoning as `enable`/`disable`), neither deletes or
  // irreversibly changes data. Both endpoints still require
  // `Idempotency-Key` (replay) and are explicitly audited regardless of
  // this classification.
  | "replay"
  | "manage";

export type AccessRequest = {
  moduleKey: string;
  activityCode: string;
  action: AccessAction;
  resourceType?: string;
  resourceId?: string;
  resourceAttributes?: Record<string, unknown>;
  environmentAttributes?: Record<string, unknown>;
};

export type AccessDecision = {
  allowed: boolean;
  reason: string;
  decisionId?: string;
  matchedPolicy?: string;
};

const HIGH_RISK_ACTIONS: ReadonlySet<AccessAction> = new Set([
  "delete",
  "approve",
  "export",
  "assign",
  "configure",
  "restore",
  "purge",
  "connect",
  "disconnect"
]);

export function isHighRiskAction(action: AccessAction): boolean {
  return HIGH_RISK_ACTIONS.has(action);
}

export function permissionKey(
  moduleKey: string,
  activityCode: string,
  action: string
): string {
  return `${moduleKey}.${activityCode}.${action}`;
}

/**
 * Default deny, deny overrides allow (ADR-0004). ABAC checks run before the
 * RBAC permission lookup so a matching deny always wins regardless of role.
 */
export function evaluateAccess(
  context: TenantContext,
  request: AccessRequest,
  grantedPermissionKeys: ReadonlySet<string>
): AccessDecision {
  const resourceTenantId = request.resourceAttributes?.tenantId;

  if (resourceTenantId !== undefined && resourceTenantId !== context.tenantId) {
    return {
      allowed: false,
      reason: "Resource belongs to a different tenant.",
      matchedPolicy: "tenant_isolation"
    };
  }

  const requestedBy = request.resourceAttributes?.requestedByTenantUserId;

  if (request.action === "approve" && requestedBy === context.tenantUserId) {
    return {
      allowed: false,
      reason: "Self-approval is not allowed.",
      matchedPolicy: "self_approval_deny"
    };
  }

  const key = permissionKey(
    request.moduleKey,
    request.activityCode,
    request.action
  );

  if (!grantedPermissionKeys.has(key)) {
    return {
      allowed: false,
      reason: "No role permission grants this action.",
      matchedPolicy: "default_deny"
    };
  }

  return {
    allowed: true,
    reason: "Granted via role permission.",
    matchedPolicy: "role_permission"
  };
}

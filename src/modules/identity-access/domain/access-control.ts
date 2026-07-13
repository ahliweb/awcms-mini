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
  // Issue #745 (data_lifecycle): `legal_hold.release` — ending an active
  // legal hold. Deliberately its OWN action (not reusing `cancel`/
  // `restore`/`configure`) so a role can be granted `legal_hold.create`
  // without implicitly also being able to `release` one — issue #745's
  // "default-deny release" requirement. Added to `HIGH_RISK_ACTIONS`
  // below: releasing a hold removes a data-protection safeguard that may
  // let purge/archive resume against previously-protected rows.
  | "release"
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
  | "manage"
  // Issue #747 (workflow-approval managed definitions/escalation/recovery):
  // `workflow.definition.retire` (voluntary retirement of an active
  // definition version without publishing a replacement — distinct from
  // `publish`, which retires the PREVIOUS active version only as a side
  // effect of activating a new one), `workflow.recovery.reassign`
  // (reassign a pending task's open seats to another tenant user),
  // `workflow.recovery.force_decide` (force-approve/force-reject a
  // pending task, bypassing quorum), and `workflow.delegation.revoke`
  // (revoke an effective-dated substitute assignment — security-auditor
  // finding, PR #778: previously seeded in migration 060/doc 17 but never
  // enforced by any guard). All four added to `HIGH_RISK_ACTIONS` below —
  // each is either an administrative override of a running workflow's
  // normal decision path, or a reduction of a substitute's standing.
  | "retire"
  | "reassign"
  | "force_decide"
  | "revoke"
  // Issue #748 (profile_identity): `profile_merge.merge` — executing an
  // approved profile merge request (survivor absorbs loser, entity links
  // repointed, immutable merge history written). Deliberately its own
  // action, distinct from `approve` (the earlier decision step) and
  // `update`/`delete` — merging is irreversible-by-default (the loser
  // profile is soft-deleted with `merged_into_profile_id` set, never
  // hard-deleted) and has broad blast radius across every module that
  // holds an `awcms_mini_profile_entity_links` reference, so a role
  // granted `profile_merge.approve` is NOT implicitly allowed to also
  // execute the merge itself. Added to `HIGH_RISK_ACTIONS` below.
  | "merge";

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
  "disconnect",
  "release",
  "retire",
  "reassign",
  "force_decide",
  "revoke",
  "merge"
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

  // Issue #747 security-auditor finding (PR #778): `force_decide` is an
  // administrative override that bypasses quorum entirely (workflow-
  // approval's `force-decision.ts`) — without this, a caller who filed
  // their own workflow instance AND holds `workflow.recovery.force_decide`
  // could force-approve their own request, structurally bypassing the
  // `approve`-only check above (that check is hardwired to the "approve"
  // action string, so it never fires for "force_decide"). Blocks BOTH
  // directions (force-approve and force-reject) of a caller's own
  // instance — an administrator who is also the requester should not be
  // deciding their own request at all via this path, not just the
  // approve direction.
  if (
    request.action === "force_decide" &&
    requestedBy === context.tenantUserId
  ) {
    return {
      allowed: false,
      reason: "Self-administered force-decision is not allowed.",
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

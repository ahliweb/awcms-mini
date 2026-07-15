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
  // Issue #746 (business-scope assignments/SoD): `revoke` is deliberately
  // its OWN action, distinct from `delete`/`disconnect`/`release` — a
  // business-scope assignment or a SoD conflict exception is never
  // physically deleted, only transitioned to `revoked` (append-only
  // lifecycle history, `awcms_mini_business_scope_assignment_events`).
  // High-risk: revoking removes an access grant or a standing exception,
  // same "removes a safeguard/grant" reasoning `release`'s own comment
  // above documents. Issue #747 (workflow-approval) also reuses this same
  // action for `workflow.delegation.revoke` (revoke an effective-dated
  // substitute assignment) — same generic action vocabulary shared across
  // activities throughout this codebase (e.g. "approve"), distinct
  // permission keys, no conflict.
  | "revoke"
  // `override` — reserved for a future "grant access despite a detected
  // conflict" hook distinct from the ordinary `approve` decision on an
  // exception REQUEST (see `reject` below) — not consumed by this issue's
  // own endpoints (`business_scope.exceptions.approve` reuses `approve`,
  // matching the "reuse existing approve/assign/read/create rather than
  // inventing redundant actions" precedent `workflow.approval.approve`
  // already sets for its own approve/reject decision). Declared now,
  // classified high-risk up front, so a future narrower override hook
  // never has to retroactively reclassify an already-shipped action.
  | "override"
  // `reject` — deny a pending segregation-of-duties conflict exception
  // request. Distinct from `cancel` (which this codebase already uses for
  // ending an in-progress transaction/workflow) and from `override`/
  // `approve` — rejecting an exception is the SAFE outcome (the conflict
  // stays denied), not high-risk, matching `verify`/`preview`'s
  // non-destructive reasoning above.
  | "reject"
  // Issue #747 (workflow-approval managed definitions/escalation/recovery):
  // `workflow.definition.retire` (voluntary retirement of an active
  // definition version without publishing a replacement — distinct from
  // `publish`, which retires the PREVIOUS active version only as a side
  // effect of activating a new one), `workflow.recovery.reassign`
  // (reassign a pending task's open seats to another tenant user), and
  // `workflow.recovery.force_decide` (force-approve/force-reject a
  // pending task, bypassing quorum). All three added to `HIGH_RISK_ACTIONS`
  // below — each is either an administrative override of a running
  // workflow's normal decision path, or a reduction of a substitute's
  // standing.
  | "retire"
  | "reassign"
  | "force_decide"
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
  | "merge"
  // Issue #750 (reference_data): `imports.commit`/`imports.rollback` —
  // applying a validated dry-run import batch to a value set's GLOBAL
  // baseline codes, and reverting a previously committed batch. Neither
  // reuses `create`/`restore`: `imports.create` (existing action) covers
  // the earlier, non-mutating dry-run submission step (computes a diff,
  // never touches `awcms_mini_reference_codes`), so a role granted
  // `imports.create` is NOT implicitly allowed to actually apply it — the
  // same "decision step vs execution step" separation `profile_merge.
  // approve` vs `.merge` already established above. `rollback` is
  // deliberately its own action rather than reusing `restore` (which
  // un-deprecates a SINGLE row) — rollback reverts an entire import
  // batch's cumulative effect. Both added to `HIGH_RISK_ACTIONS` below.
  | "commit"
  | "rollback"
  // Issue #751 (document_infrastructure): three more new literals (`commit`
  // above is shared/reused verbatim by this module too — a document number
  // sequence's reservation commit, a different concrete meaning under a
  // different `moduleKey`/`activityCode`, same generic action vocabulary,
  // no conflict), all added to `HIGH_RISK_ACTIONS` below. `void` — an
  // irreversible-by-default business-state transition on a document (kept
  // visible as evidence, distinct from `delete`/soft-delete of a
  // mistakenly created record — see `sql/067`'s own header). `reclassify`
  // — change a document's classification/confidentiality level,
  // security-sensitive since it can widen or narrow who is allowed to read
  // the document. `reserve` — the other numbering-integrity operation on a
  // document number sequence's reservation (`cancel` reuses the existing
  // base literal below, deliberately NOT added to `HIGH_RISK_ACTIONS` to
  // avoid reclassifying every OTHER module's already-shipped `cancel`
  // action; this module's own reservation-cancel route still requires
  // `Idempotency-Key` unconditionally at the route layer regardless).
  | "void"
  | "reclassify"
  | "reserve"
  // Issue #753 (reporting projections): `reporting.projections.rebuild` —
  // trigger or resume a full projection rebuild (reset + bounded re-scan
  // of the authoritative source table(s)). Distinct from `analyze`
  // (reconciliation, read-only) and from `export`/`configure` (the
  // export surface) — a rebuild is a real, resource-costly recomputation
  // with its own permission so a role that can read/reconcile a
  // projection is not implicitly allowed to also force a rebuild of it.
  // Added to `HIGH_RISK_ACTIONS` below. (`commit` is NOT re-declared here
  // — it's already a union member above, added by issue #750's
  // reference_data addition; reporting's own commit-shaped action, if it
  // ever needs one, reuses that same literal, same convention `cancel`
  // already established for document_infrastructure just above.)
  | "rebuild";

export type AccessRequest = {
  moduleKey: string;
  activityCode: string;
  action: AccessAction;
  resourceType?: string;
  resourceId?: string;
  /**
   * Issue #746 — `resourceAttributes.requiredScopeType`/
   * `.requiredScopeId` (both `string`, set together) are an ADDITIVE
   * convention: when present, `evaluateAccess` also requires the caller
   * to hold a resolved business-scope fact covering exactly that
   * `(scopeType, scopeId)` pair (see `businessScopeFacts` param below),
   * denying otherwise. Absent (the default for every pre-existing
   * `AccessRequest` call site) means "no business-scope constraint on
   * this request" — behavior is completely unchanged for every endpoint
   * that does not opt in.
   *
   * NOT the same as `resourceAttributes.sodScopeType`/`.sodScopeId`
   * (`application/high-risk-sod-guard.ts`) — that pair tells SoD conflict
   * detection which scope the SUBJECT's conflicting permission should be
   * matched against for a `"same_scope_only"` rule, an entirely different
   * question from "does the ACTOR hold a scope fact", answered by a
   * different mechanism outside this pure function. Deliberately separate
   * keys so the two are never accidentally conflated at a call site.
   */
  resourceAttributes?: Record<string, unknown>;
  environmentAttributes?: Record<string, unknown>;
};

/**
 * One resolved-and-verified business-scope fact for the acting subject —
 * always produced ahead of time by a caller via
 * `BusinessScopeHierarchyPort`/`business-scope-facts.ts` (I/O), never
 * resolved inside this file (`evaluateAccess` stays pure, no I/O, matching
 * every other ABAC decision in this module).
 */
export type BusinessScopeFact = {
  scopeType: string;
  scopeId: string;
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
  // Issue #746: revoking a business-scope assignment/SoD exception removes
  // an access grant or a standing safeguard override. Issue #747 also
  // relies on this same set entry for `workflow.delegation.revoke`.
  "revoke",
  // Issue #746: reserved override hook (see AccessAction's own comment) —
  // classified high-risk up front even though no endpoint consumes it yet.
  "override",
  "retire",
  "reassign",
  "force_decide",
  "merge",
  // Issue #750 (reference_data) — see the `AccessAction` union's own
  // comment above for why neither reuses an existing action.
  "commit",
  "rollback",
  // Issue #751 (document_infrastructure): see `AccessAction`'s own comment
  // above for why `void`/`reclassify`/`reserve` are here (and why `commit`
  // is already covered by the entry above, shared with reference_data) but
  // the pre-existing shared `cancel` literal is deliberately NOT added.
  "void",
  "reclassify",
  "reserve",
  // Issue #752 (data_exchange): `imports.post` — executing the asynchronous
  // idempotent commit of a staged import batch, the FIRST real consumer of
  // the pre-existing `"post"` action (reserved since the initial union for
  // exactly this "finalize a staged transaction" shape). High-risk: commit
  // is the sole point where staged rows are actually applied to an owning
  // module's real tables — same "irreversible-by-default, broad blast
  // radius" reasoning as `merge`'s own comment above. `commit` itself is
  // already in this set via the entry above, shared with
  // reference_data/document_infrastructure — not re-added here.
  "post",
  // Issue #753 — see the `AccessAction` union's own comment above.
  "rebuild"
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
  grantedPermissionKeys: ReadonlySet<string>,
  businessScopeFacts?: readonly BusinessScopeFact[]
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

  // Issue #746 — additive business-scope constraint. Only evaluated when a
  // caller opts a request into it via `requiredScopeType`/`requiredScopeId`
  // (see `AccessRequest`'s own doc comment); every pre-existing call site
  // that never sets these two fields is completely unaffected. Default-deny
  // when the fact set is missing/empty or does not contain a match for the
  // required scope — "unresolved scope ... default to deny for high-risk
  // actions" (issue #746 security requirement), applied here even for
  // non-high-risk actions that explicitly opt in, since declaring a
  // required scope at all is itself an explicit request for this guarantee.
  const requiredScopeType = request.resourceAttributes?.requiredScopeType;
  const requiredScopeId = request.resourceAttributes?.requiredScopeId;

  if (
    typeof requiredScopeType === "string" &&
    typeof requiredScopeId === "string"
  ) {
    const covered = (businessScopeFacts ?? []).some(
      (fact) =>
        fact.scopeType === requiredScopeType && fact.scopeId === requiredScopeId
    );

    if (!covered) {
      return {
        allowed: false,
        reason:
          "Required business scope is not resolved or not assigned to this subject.",
        matchedPolicy: "business_scope_unresolved"
      };
    }
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

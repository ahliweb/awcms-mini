/**
 * SoD conflict enforcement at the REAL universal authorization chokepoint
 * (Issue #746, epic #738 platform-evolution Wave 2). Called from
 * `access-guard.ts`'s `authorizeInTransaction` — the one function every
 * guarded endpoint in this codebase already calls through — for every
 * `isHighRiskAction` decision, satisfying the acceptance criterion "conflict
 * evaluation for ... high-risk authorization decisions" against the REAL
 * production entrypoint, not a narrower/duplicated mechanism.
 *
 * DELIBERATE SCOPE DECISION (documented here since it is the single most
 * important design call in this issue): this check reasons ONLY about
 * permissions the subject holds via an ACTIVE
 * `awcms_mini_business_scope_assignment` (`business-scope-facts.ts`'s
 * `resolveSoDAssignmentFacts`) — NEVER the subject's ordinary RBAC role
 * grant (`auth-context.ts`'s `fetchGrantedPermissionKeys`, what ordinary
 * ABAC already checked earlier in the SAME `authorizeInTransaction` call).
 * Two reasons, both load-bearing:
 *
 * 1. **Zero-regression-by-construction.** Business-scope assignments are a
 *    BRAND NEW table this issue introduces — no tenant has a single row in
 *    it on the day this ships. Every existing tenant's already-provisioned
 *    roles (which very plausibly grant a broad admin/owner role BOTH
 *    members of a newly-declared conflicting pair, e.g.
 *    `data_lifecycle.legal_hold.create` AND `.release` on the same "manage
 *    everything" role) would otherwise start being retroactively DENIED the
 *    moment this feature ships, if this check consulted ordinary RBAC
 *    grants directly — a severe, silent production regression for a
 *    feature nobody asked to enforce yet. Scoping to business-scope-
 *    assignment-granted permissions instead makes this genuinely a NO-OP
 *    for 100% of existing traffic until a tenant explicitly starts using
 *    the new assignment feature — the conflict can only ever fire for
 *    permissions this issue's OWN new mechanism granted.
 * 2. **Bounded cost.** A cheap, code-defined `Set` membership check (see
 *    `SOD_RELEVANT_PERMISSION_KEYS` below) short-circuits BEFORE any query
 *    for the ~99% of requests whose permission key does not appear in any
 *    registered `SoDRuleDescriptor` at all (true for virtually every one of
 *    the hundreds of existing endpoints today, since only 3 rule fixtures
 *    exist) — so extending the universal chokepoint costs nothing
 *    measurable for endpoints this feature does not touch.
 *
 * This means "conflict evaluation for high-risk authorization decisions"
 * is real and wired at the true chokepoint, but its blast radius today is
 * exactly the surface this issue itself creates (business-scope
 * assignments) — a deliberately narrower interpretation than "re-evaluate
 * every pre-existing RBAC role combination", justified by the regression
 * risk above. See `identity-access/README.md` for the same reasoning in
 * prose, and `tests/integration/business-scope-sod-chokepoint.integration.
 * test.ts` for the real-endpoint proof this is actually wired (not just
 * unit-tested against the pure `detectSoDConflicts` function).
 */
import { listModules } from "../../index";
import { recordCounter } from "../../../lib/observability/metrics-port";
import type { AccessRequest, TenantContext } from "../domain/access-control";
import { permissionKey } from "../domain/access-control";
import {
  detectSoDConflicts,
  type RequestedScope
} from "../domain/sod-conflict-evaluation";
import { collectSoDRuleDescriptors } from "../domain/sod-rule-registry";
import { resolveSoDAssignmentFacts } from "./business-scope-facts";
import { recordSoDConflictEvaluation } from "./sod-conflict-evaluation-log";
import { findValidSoDConflictException } from "./sod-exception-service";

const SOD_RULES = collectSoDRuleDescriptors(listModules());

/** Every permission key that appears in ANY registered rule's `conflictingPermissionKeys` — the cheap short-circuit set (see file header §2). */
const SOD_RELEVANT_PERMISSION_KEYS = new Set(
  SOD_RULES.flatMap((rule) => rule.conflictingPermissionKeys)
);

export type HighRiskSoDCheckResult =
  { blocked: false } | { blocked: true; reason: string };

/**
 * Deliberately a DIFFERENT `resourceAttributes` key pair
 * (`sodScopeType`/`sodScopeId`) than `evaluateAccess`'s own
 * `requiredScopeType`/`requiredScopeId` (`access-control.ts`) — the two
 * mechanisms answer different questions and must not be conflated: the
 * ordinary ABAC pair asks "does the ACTOR possess a resolved business-scope
 * fact for X" (denies when absent, a gate on the actor's OWN facts), while
 * this pair only tells the SoD conflict check WHICH scope the SUBJECT's
 * conflicting permission (if any) should be matched against for a
 * `"same_scope_only"` rule — the actor and subject are frequently different
 * people (e.g. an administrator revoking someone else's assignment), and
 * setting `requiredScopeType` here would incorrectly require the ACTOR
 * themselves to hold a scope fact just to perform an ordinary
 * RBAC-permission-gated revoke.
 */
function extractRequestedScope(guard: AccessRequest): RequestedScope | null {
  const scopeType = guard.resourceAttributes?.sodScopeType;
  const scopeId = guard.resourceAttributes?.sodScopeId;

  if (typeof scopeType === "string" && typeof scopeId === "string") {
    return { scopeType, scopeId };
  }
  return null;
}

/**
 * Called by `access-guard.ts`'s `authorizeInTransaction` immediately after
 * an ordinary ABAC decision has ALREADY allowed a high-risk action — this
 * function can only additionally DENY (deny-overrides-allow, never
 * upgrades a deny to an allow), consistent with `evaluateAccess`'s own
 * default-deny chain.
 */
export async function checkHighRiskSoDConflicts(
  tx: Bun.SQL,
  tenantId: string,
  context: TenantContext,
  guard: AccessRequest,
  now: Date
): Promise<HighRiskSoDCheckResult> {
  const requestedPermissionKey = permissionKey(
    guard.moduleKey,
    guard.activityCode,
    guard.action
  );

  if (!SOD_RELEVANT_PERMISSION_KEYS.has(requestedPermissionKey)) {
    return { blocked: false };
  }

  const requestedScope = extractRequestedScope(guard);
  const subjectFacts = await resolveSoDAssignmentFacts(
    tx,
    tenantId,
    context.tenantUserId,
    now,
    null
  );
  const matches = detectSoDConflicts(
    SOD_RULES,
    requestedPermissionKey,
    requestedScope,
    subjectFacts
  );

  if (matches.length === 0) {
    return { blocked: false };
  }

  let blocked = false;
  let blockReason = "";

  for (const match of matches) {
    const exception = match.indeterminate
      ? null
      : await findValidSoDConflictException(
          tx,
          tenantId,
          match.rule.ruleKey,
          context.tenantUserId,
          now,
          requestedScope
        );

    const resolvedVia = match.indeterminate
      ? "denied"
      : exception
        ? "exception"
        : "denied";

    const decisionReason = match.indeterminate
      ? `Conflict with "${match.conflictingPermissionKey}" could not be scope-resolved for a same-scope-only rule — default-deny.`
      : exception
        ? `Conflict with "${match.conflictingPermissionKey}" covered by an approved exception.`
        : `Conflict with "${match.conflictingPermissionKey}" — no approved exception on file.`;

    await recordSoDConflictEvaluation(tx, tenantId, {
      ruleKey: match.rule.ruleKey,
      subjectTenantUserId: context.tenantUserId,
      triggerContext: "high_risk_decision",
      conflictDetected: true,
      resolvedVia,
      decisionReason,
      metadata: { requestedPermissionKey }
    });

    recordCounter("sod_conflicts_detected_total", {
      ruleKey: match.rule.ruleKey,
      resolvedVia
    });

    if (resolvedVia === "denied") {
      blocked = true;
      blockReason = `Segregation-of-duties conflict (rule "${match.rule.ruleKey}"): ${decisionReason}`;
    }
  }

  return blocked ? { blocked: true, reason: blockReason } : { blocked: false };
}

/**
 * SoD conflict enforcement at the real `authorizeInTransaction` chokepoint
 * (Issue #746, epic #738 platform-evolution Wave 2). Called from
 * `access-guard.ts`'s `authorizeInTransaction` for every `isHighRiskAction`
 * decision, satisfying the acceptance criterion "conflict evaluation for
 * ... high-risk authorization decisions" against a real, widely-shared
 * production entrypoint, not a narrower/duplicated mechanism.
 *
 * **Scope of this claim (reviewer finding on PR #776 — do not overstate).**
 * "Every guarded endpoint" is NOT literally true: `authorizeInTransaction`
 * is used by 124 route files, but 13 route files call
 * `evaluateAccess()`/`isHighRiskAction()` directly instead (pre-existing,
 * not introduced by this issue) — including 3 high-risk ones this PR does
 * not touch: `src/pages/api/v1/profiles/[id].ts` (delete),
 * `.../profiles/[id]/restore.ts`, `.../profiles/[id]/purge.ts`, plus
 * `.../workflows/tasks/[id]/decisions.ts` (approve, with its own
 * hand-rolled self-approval guard living OUTSIDE `access-guard.ts`). No
 * current `SoDRuleDescriptor` fixture references any permission key those
 * four endpoints gate, so there is no active gap today — but a FUTURE SoD
 * rule targeting one of them would silently not be enforced here. Accurate
 * claim: this is wired at the chokepoint every endpoint using
 * `access-guard.ts`'s `authorizeInTransaction` already shares — migrating
 * the 13 direct-`evaluateAccess` callers onto that shared guard is a
 * plausible follow-up, not attempted in this issue.
 *
 * **Corrected scope (security-auditor finding on PR #776).** An earlier
 * version of this file reasoned ONLY about permissions the subject holds
 * via an ACTIVE `awcms_mini_business_scope_assignment`, deliberately
 * EXCLUDING the subject's ordinary RBAC role grant
 * (`auth-context.ts`'s `fetchGrantedPermissionKeys`) — reasoned at the time
 * as "zero-regression-by-construction" since the new table starts empty.
 * That reasoning was wrong: it made the check permanently blind to the
 * realistic, common case — a tenant granting an ordinary role (e.g. the
 * setup wizard's "owner" role, which grants every permission) that already
 * holds BOTH halves of a registered conflict (e.g.
 * `data_lifecycle.legal_hold.create` AND `.release`, registered
 * `severity: "critical"`) — that subject could create and immediately
 * release their own legal hold with ZERO enforcement and no evaluation log
 * entry, for as long as they never happened to also receive a
 * business-scope assignment. `business-scope-facts.ts`'s
 * `resolveSoDAssignmentFacts` now merges BOTH sources (business-scope
 * assignment facts, carrying their own real scope, AND ordinary RBAC
 * facts, `scopeType`/`scopeId: null` since an ordinary grant is not
 * confined to any scope) — see that file's own header for the full
 * rationale. This means a tenant whose EXISTING role composition already
 * holds both halves of a registered conflict is now genuinely affected the
 * moment this ships (a previously-silent conflict starts being detected
 * and denied) — the correct, intended behavior for a rule registered as a
 * real SoD conflict, not a regression to avoid.
 *
 * The one part of the original reasoning that remains valid: **bounded
 * cost**. A cheap, code-defined `Set` membership check (see
 * `SOD_RELEVANT_PERMISSION_KEYS` below) still short-circuits BEFORE any
 * query for the ~99% of requests whose permission key does not appear in
 * any registered `SoDRuleDescriptor` at all (true for virtually every one
 * of the hundreds of existing endpoints today, since only 3 rule fixtures
 * exist) — extending the shared `authorizeInTransaction` chokepoint still
 * costs nothing measurable for endpoints this feature does not touch; only the
 * per-request COST reasoning survives, not the "which facts count" scope
 * decision.
 *
 * See `identity-access/README.md` for the same reasoning in prose,
 * `tests/integration/business-scope-sod-chokepoint.integration.test.ts`
 * for the real-endpoint proof this is wired at the true chokepoint (not
 * just unit-tested against the pure `detectSoDConflicts` function), and
 * `tests/integration/business-scope-assignments.integration.test.ts`'s
 * "ordinary RBAC alone" test for the proof this now catches a conflict
 * held ENTIRELY through ordinary role grants, with no business-scope
 * assignment involved at all.
 *
 * **Hierarchy-aware `same_scope_only` matching at THIS chokepoint too
 * (Issue #802, closing the residual gap Issue #794/PR #800 explicitly left
 * open here).** PR #800 made `same_scope_only` matching hierarchy-aware
 * only for `business-scope-assignment-service.ts`'s `createBusinessScopeAssignment`
 * — this chokepoint kept doing exact `(scopeType, scopeId)` equality only,
 * because threading a real hierarchy port (`organization_structure`'s
 * adapter, needed to resolve `organization_unit`/`legal_entity` scopes) in
 * here directly would mean this shared `application` file — imported by
 * `access-guard.ts`, itself the chokepoint for a large and growing number
 * of unrelated route files (re-grep `authorizeInTransaction` callers for
 * the current count) — importing an Optional module's code from Core, which
 * `business-scope-hierarchy-port-adapter.ts`'s own header and `module.ts`'s
 * `capabilities.consumes` entry both document as forbidden (ADR-0013 §1);
 * only a route (a real composition root) may choose which adapter to wire
 * in for a given tenant.
 *
 * The fix threads an OPTIONAL `hierarchyPort` parameter through
 * `checkHighRiskSoDConflicts`/`authorizeInTransaction` instead of a
 * required one: when omitted (every caller today except one —
 * `extractRequestedScope` returns `null` unless a caller populates
 * `resourceAttributes.sodScopeType`/`sodScopeId`, and only
 * `.../business-scope/assignments/[id]/revoke.ts` does), behavior is
 * byte-for-byte identical to before this issue — no new query, no new
 * import, no risk of regressing any of the chokepoint's other callers.
 * Only `revoke.ts` — the one caller that already sets
 * `sodScopeType`/`sodScopeId` and is therefore the only real instance of
 * this gap today (verified: it is the sole caller of this chokepoint that
 * supplies a `requestedScope` at all) — now composes and passes the real
 * `BusinessScopeHierarchyPort` (same composition
 * `business-scope/assignments/index.ts` already uses for the #794 path,
 * factored into `business-scope-hierarchy-port-composition.ts` so both
 * routes share one composition root instead of duplicating it), resolving
 * this scope's ancestors/descendants to populate `RequestedScope.relatedScopes`
 * the same way #794 already does for the create path. See the "Issue #802
 * adversarial" test in
 * `tests/integration/business-scope-organization-structure-wiring.integration.test.ts`
 * for the adversarial proof: an actor holding `.create` at a parent
 * `organization_unit` can no longer `.revoke` an assignment at a
 * descendant unit without tripping
 * `business_scope_assignment_scope_maker_checker` through THIS chokepoint.
 */
import { listModules } from "../../index";
import { recordCounter } from "../../../lib/observability/metrics-port";
import type { BusinessScopeHierarchyPort } from "../../_shared/ports/business-scope-hierarchy-port";
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
 *
 * `hierarchyPort` (Issue #802) is OPTIONAL and looked up LAZILY — only
 * queried when both (a) `requestedScope` was actually supplied (true for
 * exactly one caller today, `revoke.ts`) and (b) the cheap
 * `SOD_RELEVANT_PERMISSION_KEYS` short-circuit above already passed — so
 * every other caller of this chokepoint pays zero extra cost and sees zero
 * behavior change, whether or not it ever passes a `hierarchyPort` at all.
 */
export async function checkHighRiskSoDConflicts(
  tx: Bun.SQL,
  tenantId: string,
  context: TenantContext,
  guard: AccessRequest,
  now: Date,
  hierarchyPort?: BusinessScopeHierarchyPort
): Promise<HighRiskSoDCheckResult> {
  const requestedPermissionKey = permissionKey(
    guard.moduleKey,
    guard.activityCode,
    guard.action
  );

  if (!SOD_RELEVANT_PERMISSION_KEYS.has(requestedPermissionKey)) {
    return { blocked: false };
  }

  const extractedScope = extractRequestedScope(guard);
  // Hierarchy-aware `same_scope_only` matching (Issue #802) — reuses the
  // same `RequestedScope.relatedScopes` mechanism #794/PR #800 introduced
  // for `createBusinessScopeAssignment`. `resolution.resolved === false`
  // (unknown scope type, deleted scope, wrong tenant, or no `hierarchyPort`
  // supplied at all) leaves `requestedScope` as exact-match-only, exactly
  // today's pre-#802 behavior — never a crash, never a wider grant.
  let requestedScope = extractedScope;
  if (extractedScope && hierarchyPort) {
    const resolution = await hierarchyPort.resolveScope(
      tx,
      tenantId,
      extractedScope.scopeType,
      extractedScope.scopeId
    );
    if (resolution.resolved) {
      requestedScope = {
        ...extractedScope,
        relatedScopes: [
          ...resolution.ancestorScopes,
          ...resolution.descendantScopes
        ]
      };
    }
  }

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

/**
 * Pure tenant-lifecycle policy tests (Issue #873) — the state machine, the
 * server-derived restriction matrix, the access decision, and the fail-closed
 * request parsers. No database. Proves the transition graph + restriction
 * matrix WITHOUT the DB trigger so the two layers can be cross-checked.
 */
import { describe, expect, test } from "bun:test";
import {
  ALLOW_ALL,
  DENY_ALL,
  deriveRestrictions,
  isLegalTransition,
  isLifecycleState,
  isRestorableState,
  isSchedulableFrom,
  isWriteAction,
  LIFECYCLE_STATES,
  lifecycleAccessDecision,
  type LifecycleState
} from "../../src/modules/_shared/tenant-lifecycle-policy";
import {
  parseRestoreBody,
  parseTransitionBody
} from "../../src/modules/tenant-lifecycle/application/request-parsing";
import {
  validateTransition,
  validateRestore
} from "../../src/modules/tenant-lifecycle/domain/request-validation";

describe("tenant_lifecycle state machine (Issue #873)", () => {
  test("a same-state write is legal; a genuine transition must be whitelisted", () => {
    for (const state of LIFECYCLE_STATES) {
      expect(isLegalTransition(state, state)).toBe(true);
    }
    // Representative legal transitions (mirror sql/089).
    expect(isLegalTransition("trial", "active")).toBe(true);
    expect(isLegalTransition("active", "suspended")).toBe(true);
    expect(isLegalTransition("grace", "suspended")).toBe(true);
    expect(isLegalTransition("suspended", "restoring")).toBe(true);
    expect(isLegalTransition("restoring", "active")).toBe(true);
    expect(isLegalTransition("canceled", "restoring")).toBe(true);
  });

  test("illegal transitions are rejected", () => {
    // canceled may ONLY go to restoring (never straight to active).
    expect(isLegalTransition("canceled", "active")).toBe(false);
    // suspended cannot jump straight to active (must go via restoring).
    expect(isLegalTransition("suspended", "active")).toBe(false);
    // provisioning cannot jump to grace/suspended directly.
    expect(isLegalTransition("provisioning", "grace")).toBe(false);
    // past_due cannot go to renewal_due.
    expect(isLegalTransition("past_due", "renewal_due")).toBe(false);
  });

  test("only suspended/canceled/blocked are restorable", () => {
    expect(isRestorableState("suspended")).toBe(true);
    expect(isRestorableState("canceled")).toBe(true);
    expect(isRestorableState("blocked")).toBe(true);
    expect(isRestorableState("active")).toBe(false);
    expect(isRestorableState("trial")).toBe(false);
  });

  test("only operational states are schedulable from", () => {
    expect(isSchedulableFrom("trial")).toBe(true);
    expect(isSchedulableFrom("grace")).toBe(true);
    expect(isSchedulableFrom("active")).toBe(true);
    expect(isSchedulableFrom("suspended")).toBe(false);
    expect(isSchedulableFrom("canceled")).toBe(false);
  });

  test("isLifecycleState is a total, closed guard", () => {
    expect(isLifecycleState("active")).toBe(true);
    expect(isLifecycleState("frozen")).toBe(false);
    expect(isLifecycleState(42)).toBe(false);
  });
});

describe("tenant_lifecycle restriction matrix (Issue #873)", () => {
  test("operational states allow everything", () => {
    for (const state of [
      "trial",
      "active",
      "renewal_due",
      "grace"
    ] as LifecycleState[]) {
      const p = deriveRestrictions(state);
      expect(p.adminAccessAllowed).toBe(true);
      expect(p.writesAllowed).toBe(true);
      expect(p.publicSiteAllowed).toBe(true);
    }
  });

  test("past_due is read-only but still public/visible", () => {
    const p = deriveRestrictions("past_due");
    expect(p.adminAccessAllowed).toBe(true);
    expect(p.writesAllowed).toBe(false);
    expect(p.publicSiteAllowed).toBe(true);
    expect(p.entitlementActive).toBe(false);
  });

  test("suspended/canceled/blocked lock access but keep export + owner recovery", () => {
    for (const state of [
      "suspended",
      "canceled",
      "blocked"
    ] as LifecycleState[]) {
      const p = deriveRestrictions(state);
      expect(p.adminAccessAllowed).toBe(false);
      expect(p.writesAllowed).toBe(false);
      expect(p.publicSiteAllowed).toBe(false);
      expect(p.backgroundJobsAllowed).toBe(false);
      expect(p.providerDispatchAllowed).toBe(false);
      // Data export + owner recovery stay ON (data is preserved, recoverable).
      expect(p.dataExportAllowed).toBe(true);
      expect(p.ownerRecoveryAllowed).toBe(true);
    }
  });

  test("publicSiteAllowed and backgroundJobsAllowed agree for every state (single tenant.status projection)", () => {
    for (const state of LIFECYCLE_STATES) {
      const p = deriveRestrictions(state);
      expect(p.publicSiteAllowed).toBe(p.backgroundJobsAllowed);
    }
  });

  test("access decision: suspended denies all; past_due denies writes only", () => {
    // suspended (adminAccessAllowed=false) → deny read AND write.
    expect(
      lifecycleAccessDecision(deriveRestrictions("suspended"), false)
    ).toEqual({
      allowed: false,
      reason: "suspended"
    });
    expect(
      lifecycleAccessDecision(deriveRestrictions("suspended"), true)
    ).toEqual({
      allowed: false,
      reason: "suspended"
    });
    // past_due: read allowed, write denied.
    expect(
      lifecycleAccessDecision(deriveRestrictions("past_due"), false)
    ).toEqual({
      allowed: true
    });
    expect(
      lifecycleAccessDecision(deriveRestrictions("past_due"), true)
    ).toEqual({
      allowed: false,
      reason: "read_only"
    });
    // active: everything allowed.
    expect(lifecycleAccessDecision(deriveRestrictions("active"), true)).toEqual(
      {
        allowed: true
      }
    );
  });

  test("ALLOW_ALL is permissive, DENY_ALL is fully restrictive", () => {
    expect(ALLOW_ALL.adminAccessAllowed).toBe(true);
    expect(DENY_ALL.adminAccessAllowed).toBe(false);
    expect(DENY_ALL.dataExportAllowed).toBe(false);
  });

  test("isWriteAction: reads exempt, everything else a write (fail-closed)", () => {
    expect(isWriteAction("read")).toBe(false);
    expect(isWriteAction("check")).toBe(false);
    expect(isWriteAction("update")).toBe(true);
    expect(isWriteAction("post")).toBe(true);
    // An unknown action is treated as a write (never silently exempt).
    expect(isWriteAction("frobnicate")).toBe(true);
  });
});

describe("tenant_lifecycle fail-closed parsing/validation (Issue #873)", () => {
  test("transition: absent source defaults to operator; present verbatim", () => {
    expect(parseTransitionBody({ toState: "active", reason: "x" }).source).toBe(
      "operator"
    );
    expect(
      parseTransitionBody({ toState: "active", reason: "x", source: "billing" })
        .source
    ).toBe("billing");
  });

  test("transition: expectedVersion is tri-state (absent -> null, present verbatim)", () => {
    expect(
      parseTransitionBody({ toState: "active", reason: "x" }).expectedVersion
    ).toBe(null);
    expect(
      parseTransitionBody({
        toState: "active",
        reason: "x",
        expectedVersion: 3
      }).expectedVersion
    ).toBe(3);
  });

  test("transition validation requires a known state + mandatory reason", () => {
    expect(
      validateTransition({
        toState: "active",
        reason: "ok",
        source: "operator",
        expectedVersion: null
      })
    ).toEqual([]);
    // empty reason rejected.
    expect(
      validateTransition({
        toState: "active",
        reason: "  ",
        source: "operator",
        expectedVersion: null
      }).some((e) => e.field === "reason")
    ).toBe(true);
    // unknown state rejected.
    expect(
      validateTransition({
        toState: "frozen",
        reason: "ok",
        source: "operator",
        expectedVersion: null
      }).some((e) => e.field === "toState")
    ).toBe(true);
    // wrong-typed expectedVersion rejected (never coerced).
    expect(
      validateTransition({
        toState: "active",
        reason: "ok",
        source: "operator",
        expectedVersion: "3" as unknown as number
      }).some((e) => e.field === "expectedVersion")
    ).toBe(true);
  });

  test("restore: confirmUnresolved absent -> false (safe default), present verbatim", () => {
    expect(parseRestoreBody({ reason: "x" }).confirmUnresolved).toBe(false);
    expect(
      parseRestoreBody({ reason: "x", confirmUnresolved: true })
        .confirmUnresolved
    ).toBe(true);
    // wrong type is rejected by the validator, never coerced.
    expect(
      validateRestore({
        reason: "x",
        confirmUnresolved: "yes" as unknown as boolean,
        expectedVersion: null
      }).some((e) => e.field === "confirmUnresolved")
    ).toBe(true);
  });
});

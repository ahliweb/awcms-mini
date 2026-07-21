/**
 * Control-plane security model — unit gate (Issue #879, epic #868 SaaS
 * control plane, Wave 2, ADR-0022 §5/§6/§8). Each block is a MUTATION detector
 * (remove the control it proves and this suite goes red).
 *
 *   1. The RLS platform-claim static scanner (`scripts/rls-platform-claim-
 *      check.ts`) — ADR-0022 §6 High-1 "no soft super-tenant". ALLOWLIST +
 *      state-machine (FIX MEDIUM-4): adversarial fixtures for EACH documented
 *      bypass (OR-extension, second permissive policy, function wrapper,
 *      SECURITY DEFINER body, `;`-in-string truncation, DISABLE/NO FORCE RLS,
 *      ALTER ROLE BYPASSRLS) must all fail the gate; a clean predicate passes.
 *   2. The control-plane step-up policy registry + RUNTIME decision
 *      (`_shared/control-plane-step-up-registry.ts`) — ADR-0022 §5/§8 (FIX
 *      MEDIUM-3). Proves the mandatory action classes are classified, drift is
 *      caught, and `evaluateStepUp` fail-closes on missing/stale assurance.
 *   3. The control-plane SoD maker/checker rules — proves each rule is
 *      registered with its exact pair, the CHECKER action is high-risk (the
 *      chokepoint fires), the MAKER side is actually detected by
 *      `detectSoDConflicts` (not merely paired on paper), and the SoD registry
 *      existence gate catches a rule pointing at a non-existent permission.
 */
import { describe, expect, test } from "bun:test";

import {
  FORBIDDEN_PREDICATE_TOKENS,
  isCanonicalTenantPredicate,
  scanSqlForPlatformClaim
} from "../../scripts/rls-platform-claim-check";
import { collectSeededPermissionKeysFromSql } from "../../scripts/lib/seeded-permission-keys";
import {
  CONTROL_PLANE_STEP_UP_POLICIES,
  evaluateStepUp,
  isStepUpRequired,
  validateStepUpPolicyRegistry
} from "../../src/modules/_shared/control-plane-step-up-registry";
import type { StepUpActionClass } from "../../src/modules/_shared/control-plane-step-up-registry";
import { listModules } from "../../src/modules";
import {
  collectSoDRuleDescriptors,
  validateSoDRuleRegistry
} from "../../src/modules/identity-access/domain/sod-rule-registry";
import { detectSoDConflicts } from "../../src/modules/identity-access/domain/sod-conflict-evaluation";
import { isHighRiskAction } from "../../src/modules/identity-access/domain/access-control";
import type { AccessAction } from "../../src/modules/identity-access/domain/access-control";

const CLEAN_TENANT_POLICY = `
CREATE POLICY awcms_mini_demo_tenant_isolation
  ON awcms_mini_demo
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
`;

describe("RLS platform-claim static scanner (ADR-0022 §6 High-1) — allowlist", () => {
  test("a clean tenant-id-only policy passes", () => {
    expect(scanSqlForPlatformClaim(CLEAN_TENANT_POLICY, "demo.sql")).toEqual(
      []
    );
  });

  test("the whole real sql/ directory passes (no regression / false positive)", () => {
    // Imported lazily to reuse the exported directory scanner without a DB.
    const {
      scanSqlDirectory
    } = require("../../scripts/rls-platform-claim-check");
    const path = require("node:path");
    const violations = scanSqlDirectory(path.join(process.cwd(), "sql"));
    expect(violations).toEqual([]);
  });

  test("comments that merely mention platform-claim are NOT flagged", () => {
    const sql = `
      -- The operator role is NOT BYPASSRLS and never adds an OR is_platform
      -- clause. This comment mentions has_platform_claim() only in prose.
      ${CLEAN_TENANT_POLICY}
    `;
    expect(scanSqlForPlatformClaim(sql, "demo.sql")).toEqual([]);
  });

  test("canonical predicate recognizer accepts whitespace/paren variants, rejects widening", () => {
    expect(
      isCanonicalTenantPredicate(
        "tenant_id = current_setting( 'app.current_tenant_id' )::uuid"
      )
    ).toBe(true);
    expect(
      isCanonicalTenantPredicate(
        "tenant_id = current_setting('app.current_tenant_id')::uuid OR true"
      )
    ).toBe(false);
  });

  test("BYPASS (a): OR is_platform widening is flagged", () => {
    const sql = `
      CREATE POLICY awcms_mini_bad_isolation ON awcms_mini_bad
        USING (tenant_id = current_setting('app.current_tenant_id')::uuid
               OR current_setting('app.is_platform') = 't');
    `;
    const v = scanSqlForPlatformClaim(sql, "bad.sql");
    expect(v.length).toBeGreaterThan(0);
    expect(v.map((x) => x.policyName)).toContain("awcms_mini_bad_isolation");
  });

  test("BYPASS (b): a SECOND, more-permissive PERMISSIVE policy on the same table is flagged", () => {
    const sql = `
      ${CLEAN_TENANT_POLICY}
      CREATE POLICY awcms_mini_demo_operator_all ON awcms_mini_demo
        AS PERMISSIVE FOR SELECT
        USING (true);
    `;
    const v = scanSqlForPlatformClaim(sql, "second.sql");
    expect(v.some((x) => x.policyName === "awcms_mini_demo_operator_all")).toBe(
      true
    );
  });

  test("BYPASS (c): a function-wrapped predicate is flagged (and its body scanned)", () => {
    const sql = `
      CREATE FUNCTION has_platform_claim() RETURNS boolean AS $$
        SELECT current_setting('app.is_platform', true) = 't';
      $$ LANGUAGE sql;
      CREATE POLICY awcms_mini_bad2 ON awcms_mini_bad2
        USING (has_platform_claim());
    `;
    const v = scanSqlForPlatformClaim(sql, "fn.sql");
    expect(v.length).toBeGreaterThan(0);
    expect(v.some((x) => x.reason.includes("function"))).toBe(true);
  });

  test("BYPASS (d): SECURITY DEFINER body token bypass is flagged when referenced by a policy", () => {
    const sql = `
      CREATE OR REPLACE FUNCTION app_is_operator() RETURNS boolean AS $$
        SELECT current_setting('app.operator', true) = 't';
      $$ LANGUAGE sql SECURITY DEFINER;
      CREATE POLICY awcms_mini_bad_def ON awcms_mini_bad_def
        USING (app_is_operator());
    `;
    const v = scanSqlForPlatformClaim(sql, "def.sql");
    expect(v.length).toBeGreaterThan(0);
  });

  test("BYPASS: a ';' inside a quoted default can NOT truncate the statement to hide a widening", () => {
    const sql = `
      CREATE POLICY awcms_mini_bad_trunc ON awcms_mini_bad_trunc
        USING (label = 'a;b' AND (tenant_id = current_setting('app.current_tenant_id')::uuid
               OR current_setting('app.super') = 't'));
    `;
    const v = scanSqlForPlatformClaim(sql, "trunc.sql");
    expect(v.length).toBeGreaterThan(0);
  });

  test("BYPASS (e): ALTER TABLE ... DISABLE / NO FORCE ROW LEVEL SECURITY is flagged", () => {
    for (const stmt of [
      "ALTER TABLE awcms_mini_demo DISABLE ROW LEVEL SECURITY;",
      "ALTER TABLE awcms_mini_demo NO FORCE ROW LEVEL SECURITY;"
    ]) {
      expect(scanSqlForPlatformClaim(stmt, "rls.sql").length).toBeGreaterThan(
        0
      );
    }
  });

  test("BYPASS (f): ALTER/CREATE ROLE ... BYPASSRLS is flagged", () => {
    for (const stmt of [
      "ALTER ROLE awcms_mini_app BYPASSRLS;",
      "CREATE ROLE sneaky WITH BYPASSRLS LOGIN;"
    ]) {
      expect(scanSqlForPlatformClaim(stmt, "role.sql").length).toBeGreaterThan(
        0
      );
    }
  });

  test("every forbidden token is individually caught in a policy predicate", () => {
    for (const token of FORBIDDEN_PREDICATE_TOKENS) {
      const sql = `CREATE POLICY awcms_mini_tok ON awcms_mini_tok USING (${token} = true);`;
      expect(
        scanSqlForPlatformClaim(sql, `${token}.sql`).length
      ).toBeGreaterThan(0);
    }
  });
});

describe("control-plane step-up policy registry + runtime (ADR-0022 §5/§8)", () => {
  test("the live registry is valid against real seeded permissions", () => {
    const result = validateStepUpPolicyRegistry(listModules());
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  test("the mandatory high-risk action classes (incl. money-out checkers) are classified", () => {
    for (const key of [
      "payment_gateway.refunds.create",
      "payment_gateway.refunds.approve",
      "subscription_billing.credits.create",
      "subscription_billing.credits.approve",
      "service_catalog.offers.approve",
      "tenant_entitlement.overrides.override",
      "tenant_lifecycle.states.restore",
      "payment_gateway.provider_accounts.configure"
    ]) {
      expect(isStepUpRequired(key)).toBe(true);
    }
  });

  test("the registry itself carries the ADR-0022 §5/§8 mandatory action classes and every policy is well-formed", () => {
    // Directly assert invariants on CONTROL_PLANE_STEP_UP_POLICIES (the source
    // of truth `validateStepUpPolicyRegistry`/`isStepUpRequired` derive from) —
    // a mutation that drops a mandatory class, or adds a policy without a
    // reason/idempotency guarantee or with an unbounded window, turns this red.
    const mandatoryClasses: StepUpActionClass[] = [
      "refund",
      "credit",
      "entitlement_override",
      "lifecycle_restore",
      "provider_configuration"
    ];
    const presentClasses = new Set(
      CONTROL_PLANE_STEP_UP_POLICIES.map((p) => p.actionClass)
    );
    for (const cls of mandatoryClasses) {
      expect(presentClasses.has(cls)).toBe(true);
    }

    // Every declared policy MUST carry the ADR-0022 §8/§9 guarantees and a
    // bounded, short assurance window (a step-up is current assurance, not a
    // login-time claim). No policy may silently relax these.
    for (const policy of CONTROL_PLANE_STEP_UP_POLICIES) {
      expect(policy.reasonRequired).toBe(true);
      expect(policy.idempotencyRequired).toBe(true);
      expect(["high", "critical"]).toContain(policy.severity);
      expect(policy.maxAssuranceAgeSeconds).toBeGreaterThan(0);
      expect(policy.maxAssuranceAgeSeconds).toBeLessThanOrEqual(3600);
    }

    // Every money-out CHECKER (refund/credit approve) MUST be classified
    // `critical` — the highest step-up tier — never downgraded.
    for (const key of [
      "payment_gateway.refunds.approve",
      "subscription_billing.credits.approve"
    ]) {
      const policy = CONTROL_PLANE_STEP_UP_POLICIES.find(
        (p) => p.permissionKey === key
      );
      expect(policy?.severity).toBe("critical");
    }
  });

  test("evaluateStepUp: a non-registered key is a no-op (ordinary endpoints unaffected)", () => {
    const now = new Date();
    expect(evaluateStepUp("blog_content.posts.read", now, now)).toEqual({
      required: false
    });
  });

  test("evaluateStepUp FAILS CLOSED on missing or stale assurance, passes when fresh", () => {
    const now = new Date("2026-07-21T12:00:00Z");
    const key = "payment_gateway.refunds.approve";

    // Missing assurance -> denied.
    const missing = evaluateStepUp(key, null, now);
    expect(missing).toMatchObject({ required: true, satisfied: false });

    // Stale (older than the 300s window) -> denied.
    const stale = new Date(now.getTime() - 301_000);
    expect(evaluateStepUp(key, stale, now)).toMatchObject({
      required: true,
      satisfied: false,
      reason: "stale_assurance"
    });

    // Fresh (within window) -> satisfied.
    const fresh = new Date(now.getTime() - 60_000);
    expect(evaluateStepUp(key, fresh, now)).toMatchObject({
      required: true,
      satisfied: true
    });
  });

  test("a policy pointing at a NON-EXISTENT permission fails validation (drift-killer)", () => {
    const result = validateStepUpPolicyRegistry(listModules(), [
      {
        permissionKey: "payment_gateway.refunds.approve_does_not_exist",
        actionClass: "refund",
        maxAssuranceAgeSeconds: 300,
        reasonRequired: true,
        idempotencyRequired: true,
        severity: "critical",
        description: "fixture pointing at a non-existent permission"
      }
    ]);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.message.includes("non-existent"))).toBe(
      true
    );
  });
});

describe("control-plane SoD maker/checker rules (ADR-0022 §5/§6)", () => {
  const modules = listModules();
  const rules = collectSoDRuleDescriptors(modules);
  const byKey = new Map(rules.map((rule) => [rule.ruleKey, rule]));

  // Every maker/checker rule this issue's fixes require, with the MAKER key,
  // the CHECKER key, and the CHECKER's action (which must be high-risk so the
  // shared chokepoint fires there).
  const MAKER_CHECKER_RULES: {
    ruleKey: string;
    maker: string;
    checker: string;
    checkerAction: AccessAction;
  }[] = [
    {
      ruleKey: "payment_gateway.refund_create_vs_approve",
      maker: "payment_gateway.refunds.create",
      checker: "payment_gateway.refunds.approve",
      checkerAction: "approve"
    },
    {
      ruleKey: "subscription_billing.credit_create_vs_approve",
      maker: "subscription_billing.credits.create",
      checker: "subscription_billing.credits.approve",
      checkerAction: "approve"
    },
    {
      ruleKey: "service_catalog.publish_vs_commercial_approve",
      maker: "service_catalog.offers.publish",
      checker: "service_catalog.offers.approve",
      checkerAction: "approve"
    },
    {
      ruleKey: "subscription_billing.invoice_create_vs_issue",
      maker: "subscription_billing.invoices.create",
      checker: "subscription_billing.invoices.issue",
      checkerAction: "issue"
    },
    {
      ruleKey: "tenant_lifecycle.restore_requester_vs_approver",
      maker: "tenant_lifecycle.states.schedule",
      checker: "tenant_lifecycle.states.restore",
      checkerAction: "restore"
    },
    {
      ruleKey: "tenant_entitlement.override_vs_audit_review",
      maker: "logging.audit_trail.read",
      checker: "tenant_entitlement.overrides.override",
      checkerAction: "override"
    },
    {
      ruleKey: "identity_access.support_request_vs_approve",
      maker: "identity_access.support_access.request",
      checker: "identity_access.support_access.approve",
      checkerAction: "approve"
    }
  ];

  test("every maker/checker rule is registered with its exact conflicting pair", () => {
    for (const { ruleKey, maker, checker } of MAKER_CHECKER_RULES) {
      const rule = byKey.get(ruleKey);
      expect(rule).toBeDefined();
      expect(rule?.conflictingPermissionKeys).toContain(maker);
      expect(rule?.conflictingPermissionKeys).toContain(checker);
    }
  });

  test("each rule's CHECKER action is high-risk so the shared chokepoint fires", () => {
    for (const { checkerAction } of MAKER_CHECKER_RULES) {
      expect(isHighRiskAction(checkerAction)).toBe(true);
    }
  });

  test("the MAKER side is actually DETECTED at the checker chokepoint (not just paired on paper)", () => {
    // Simulate a single actor who holds BOTH permissions and requests the
    // high-risk CHECKER action. `detectSoDConflicts` must surface the maker as
    // the conflicting permission — end-to-end proof (for the pure decision) for
    // EVERY rule, not only the entitlement-override one.
    for (const { checker, maker } of MAKER_CHECKER_RULES) {
      const facts = [
        { permissionKey: maker, scopeType: null, scopeId: null },
        { permissionKey: checker, scopeType: null, scopeId: null }
      ];
      const matches = detectSoDConflicts(rules, checker, null, facts);
      expect(matches.some((m) => m.conflictingPermissionKey === maker)).toBe(
        true
      );
    }
  });

  test("mutation: removing a rule makes its maker no longer detected at the checker", () => {
    // Prove the detection above is load-bearing: with the rule filtered OUT,
    // the same facts produce NO conflict for that checker key.
    for (const { ruleKey, checker, maker } of MAKER_CHECKER_RULES) {
      const withoutRule = rules.filter((r) => r.ruleKey !== ruleKey);
      const facts = [
        { permissionKey: maker, scopeType: null, scopeId: null },
        { permissionKey: checker, scopeType: null, scopeId: null }
      ];
      const matches = detectSoDConflicts(withoutRule, checker, null, facts);
      expect(matches.some((m) => m.conflictingPermissionKey === maker)).toBe(
        false
      );
    }
  });

  test("SoD registry existence gate catches a rule pointing at a non-existent permission", () => {
    const seeded = collectSeededPermissionKeysFromSql();
    // The live registry must be valid against the real seeded permissions.
    expect(validateSoDRuleRegistry(modules, seeded).valid).toBe(true);

    // A fabricated module whose rule references a typo'd permission must fail.
    const fakeModule = {
      ...modules[0]!,
      key: "identity_access",
      sodRules: [
        {
          ruleKey: "identity_access.fixture_bad",
          ownerModuleKey: "identity_access",
          description: "fixture with a typo'd permission key",
          conflictingPermissionKeys: [
            "payment_gateway.refunds.create",
            "payment_gateway.refunds.approv" // typo
          ],
          scopeApplicability: "global_within_tenant" as const,
          severity: "high" as const,
          exceptionPolicy: { allowed: false as const }
        }
      ]
    };
    const result = validateSoDRuleRegistry([fakeModule], seeded);
    expect(result.valid).toBe(false);
    expect(
      result.issues.some((i) => i.message.includes("non-existent permission"))
    ).toBe(true);
  });
});

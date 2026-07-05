import { describe, expect, test } from "bun:test";

import {
  evaluateAccess,
  isHighRiskAction,
  permissionKey,
  type TenantContext
} from "../src/modules/identity-access/domain/access-control";

const CONTEXT: TenantContext = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  tenantUserId: "22222222-2222-2222-2222-222222222222",
  identityId: "33333333-3333-3333-3333-333333333333",
  roles: ["owner"]
};

describe("permissionKey", () => {
  test("joins module, activity, and action with dots", () => {
    expect(permissionKey("tenant_admin", "office_management", "read")).toBe(
      "tenant_admin.office_management.read"
    );
  });
});

describe("isHighRiskAction", () => {
  test("classifies delete/approve/export/assign/configure as high risk", () => {
    expect(isHighRiskAction("delete")).toBe(true);
    expect(isHighRiskAction("approve")).toBe(true);
    expect(isHighRiskAction("export")).toBe(true);
    expect(isHighRiskAction("assign")).toBe(true);
    expect(isHighRiskAction("configure")).toBe(true);
  });

  test("classifies restore/purge as high risk (Issue 10.1 — soft delete lifecycle)", () => {
    expect(isHighRiskAction("restore")).toBe(true);
    expect(isHighRiskAction("purge")).toBe(true);
  });

  test("does not classify read/create/update as high risk", () => {
    expect(isHighRiskAction("read")).toBe(false);
    expect(isHighRiskAction("create")).toBe(false);
    expect(isHighRiskAction("update")).toBe(false);
  });
});

describe("evaluateAccess", () => {
  const granted = new Set([
    permissionKey("tenant_admin", "office_management", "read")
  ]);

  test("default deny: no matching permission is denied", () => {
    expect(
      evaluateAccess(
        CONTEXT,
        {
          moduleKey: "profile_identity",
          activityCode: "profile_management",
          action: "delete"
        },
        granted
      )
    ).toEqual({
      allowed: false,
      reason: "No role permission grants this action.",
      matchedPolicy: "default_deny"
    });
  });

  test("allows an action explicitly granted via role permission", () => {
    expect(
      evaluateAccess(
        CONTEXT,
        {
          moduleKey: "tenant_admin",
          activityCode: "office_management",
          action: "read"
        },
        granted
      )
    ).toEqual({
      allowed: true,
      reason: "Granted via role permission.",
      matchedPolicy: "role_permission"
    });
  });

  test("deny overrides allow: cross-tenant resource is denied even with a granted permission", () => {
    expect(
      evaluateAccess(
        CONTEXT,
        {
          moduleKey: "tenant_admin",
          activityCode: "office_management",
          action: "read",
          resourceAttributes: {
            tenantId: "99999999-9999-9999-9999-999999999999"
          }
        },
        granted
      )
    ).toEqual({
      allowed: false,
      reason: "Resource belongs to a different tenant.",
      matchedPolicy: "tenant_isolation"
    });
  });

  test("same-tenant resourceAttributes.tenantId does not trigger tenant isolation deny", () => {
    expect(
      evaluateAccess(
        CONTEXT,
        {
          moduleKey: "tenant_admin",
          activityCode: "office_management",
          action: "read",
          resourceAttributes: { tenantId: CONTEXT.tenantId }
        },
        granted
      ).allowed
    ).toBe(true);
  });

  test("deny overrides allow: self-approval is denied even with a granted permission", () => {
    const grantedWithApprove = new Set([
      ...granted,
      permissionKey("profile_identity", "profile_merge", "approve")
    ]);

    expect(
      evaluateAccess(
        CONTEXT,
        {
          moduleKey: "profile_identity",
          activityCode: "profile_merge",
          action: "approve",
          resourceAttributes: { requestedByTenantUserId: CONTEXT.tenantUserId }
        },
        grantedWithApprove
      )
    ).toEqual({
      allowed: false,
      reason: "Self-approval is not allowed.",
      matchedPolicy: "self_approval_deny"
    });
  });

  test("approving someone else's request is allowed when granted", () => {
    const grantedWithApprove = new Set([
      permissionKey("profile_identity", "profile_merge", "approve")
    ]);

    expect(
      evaluateAccess(
        CONTEXT,
        {
          moduleKey: "profile_identity",
          activityCode: "profile_merge",
          action: "approve",
          resourceAttributes: {
            requestedByTenantUserId: "44444444-4444-4444-4444-444444444444"
          }
        },
        grantedWithApprove
      ).allowed
    ).toBe(true);
  });
});

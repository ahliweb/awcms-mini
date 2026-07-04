import { describe, expect, test } from "bun:test";
import { buildAuditEvent } from "../../src/modules/_shared/audit";
import { createDomainEvent } from "../../src/modules/_shared/domain-event";
import { DEFAULT_DENY, guardAccess, accessDeniedError } from "../../src/modules/_shared/access";
import type { TenantContext } from "../../src/modules/_shared/tenant-context";
import { ApiError } from "../../src/modules/_shared/api-error";

const context: TenantContext = {
  tenantId: "123e4567-e89b-42d3-a456-426614174000",
  tenantUserId: "223e4567-e89b-42d3-a456-426614174000",
  identityId: "323e4567-e89b-42d3-a456-426614174000",
  roles: ["admin"]
};

describe("audit helper (doc 10)", () => {
  test("attributes sensitif di-redact sebelum audit", () => {
    const event = buildAuditEvent({
      tenantId: context.tenantId,
      moduleKey: "identity_access",
      action: "login",
      resourceType: "identity",
      message: "Login berhasil",
      attributes: { password: "rahasia", email: "a@b.c", nested: { apiKey: "xyz" }, okField: 1 }
    });
    expect(event.attributes.password).toBe("[REDACTED]");
    expect(event.attributes.email).toBe("[REDACTED]");
    expect((event.attributes.nested as Record<string, unknown>).apiKey).toBe("[REDACTED]");
    expect(event.attributes.okField).toBe(1);
    expect(event.severity).toBe("info");
    expect(event.occurredAt).toBeString();
  });
});

describe("domain event envelope (doc 05/10)", () => {
  test("createDomainEvent mengisi amplop lengkap", () => {
    const event = createDomainEvent({
      eventType: "tenant.created",
      tenantId: context.tenantId,
      aggregateType: "tenant",
      aggregateId: context.tenantId,
      payload: { tenantCode: "demo" },
      sourceModule: "tenant_admin"
    });
    expect(event.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.eventType).toBe("tenant.created");
    expect(event.eventVersion).toBe("1.0");
    expect(event.metadata).toEqual({ sourceModule: "tenant_admin", schemaVersion: "1.0" });
    expect(event.occurredAt).toBeString();
  });
});

describe("ABAC guard (doc 10/17)", () => {
  test("default deny: evaluator deny → ACCESS_DENIED", async () => {
    const evaluator = async () => DEFAULT_DENY;
    await expect(
      guardAccess(evaluator, context, {
        moduleKey: "tenant_admin",
        activityCode: "office_management",
        action: "read"
      })
    ).rejects.toThrow(ApiError);
  });

  test("allow → mengembalikan decision", async () => {
    const evaluator = async () => ({ allowed: true, reason: "role_allow" });
    const decision = await guardAccess(evaluator, context, {
      moduleKey: "tenant_admin",
      activityCode: "office_management",
      action: "read"
    });
    expect(decision.allowed).toBe(true);
  });

  test("accessDeniedError memakai code ACCESS_DENIED 403", () => {
    const error = accessDeniedError(DEFAULT_DENY);
    expect(error.status).toBe(403);
    expect(error.code).toBe("ACCESS_DENIED");
  });
});

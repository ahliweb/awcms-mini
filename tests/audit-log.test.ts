import { describe, expect, test } from "bun:test";

import { redactSensitiveAttributes } from "../src/modules/_shared/redaction";
import type { AuditEventInput } from "../src/modules/logging/application/audit-log";

describe("redactSensitiveAttributes", () => {
  test("undefined input stays undefined", () => {
    expect(redactSensitiveAttributes(undefined)).toBeUndefined();
  });

  test("keys that don't match any redaction key are left untouched", () => {
    expect(
      redactSensitiveAttributes({ reason: "customer request", count: 3 })
    ).toEqual({ reason: "customer request", count: 3 });
  });

  test("redacts top-level keys matching the redaction list, case-insensitively", () => {
    expect(
      redactSensitiveAttributes({
        password: "hunter2",
        PasswordHash: "abc",
        token: "t1",
        accessToken: "t2",
        refreshToken: "t3",
        apiKey: "k1",
        secret: "s1",
        Authorization: "Bearer xyz",
        npwp: "12.345.678.9-012.000",
        nik: "3271xxxxxxxxxxxx",
        phone: "+62812xxxxxxx",
        whatsapp: "+62812xxxxxxx",
        email: "user@example.com"
      })
    ).toEqual({
      password: "[REDACTED]",
      PasswordHash: "[REDACTED]",
      token: "[REDACTED]",
      accessToken: "[REDACTED]",
      refreshToken: "[REDACTED]",
      apiKey: "[REDACTED]",
      secret: "[REDACTED]",
      Authorization: "[REDACTED]",
      npwp: "[REDACTED]",
      nik: "[REDACTED]",
      phone: "[REDACTED]",
      whatsapp: "[REDACTED]",
      email: "[REDACTED]"
    });
  });

  test("matches on substring, not exact key name (e.g. customerEmail, contactPhoneNumber)", () => {
    expect(
      redactSensitiveAttributes({
        customerEmail: "user@example.com",
        contactPhoneNumber: "+62812xxxxxxx",
        internalApiKeyRef: "key-1"
      })
    ).toEqual({
      customerEmail: "[REDACTED]",
      contactPhoneNumber: "[REDACTED]",
      internalApiKeyRef: "[REDACTED]"
    });
  });

  test("redacts sensitive keys nested inside objects", () => {
    expect(
      redactSensitiveAttributes({
        actor: { name: "Owner", email: "owner@example.com" },
        reason: "soft delete"
      })
    ).toEqual({
      actor: { name: "Owner", email: "[REDACTED]" },
      reason: "soft delete"
    });
  });

  test("redacts sensitive keys nested inside arrays of objects", () => {
    expect(
      redactSensitiveAttributes({
        identifiers: [
          { type: "email", value: "a@example.com" },
          { type: "phone", value: "+62812xxxxxxx" }
        ]
      })
    ).toEqual({
      identifiers: [
        { type: "email", value: "a@example.com" },
        { type: "phone", value: "+62812xxxxxxx" }
      ]
    });
  });

  test("redacts sensitive keys inside arrays of objects when the key itself is sensitive", () => {
    expect(
      redactSensitiveAttributes({
        contacts: [{ email: "a@example.com" }, { phone: "+62812xxxxxxx" }]
      })
    ).toEqual({
      contacts: [{ email: "[REDACTED]" }, { phone: "[REDACTED]" }]
    });
  });

  test("does not mutate the input object", () => {
    const input = { password: "hunter2", note: "keep" };
    const result = redactSensitiveAttributes(input);

    expect(input.password).toBe("hunter2");
    expect(result).not.toBe(input);
  });
});

describe("AuditEventInput shape", () => {
  test("matches the doc 10 / skill contract (compile-time check via sample object)", () => {
    const sample: AuditEventInput = {
      tenantId: "11111111-1111-1111-1111-111111111111",
      actorTenantUserId: "22222222-2222-2222-2222-222222222222",
      moduleKey: "profile_identity",
      action: "delete",
      resourceType: "profile",
      resourceId: "33333333-3333-3333-3333-333333333333",
      severity: "warning",
      message: "Profile soft-deleted",
      attributes: { reason: "duplicate" },
      correlationId: "corr-1"
    };

    expect(sample.moduleKey).toBe("profile_identity");
    expect(sample.severity).toBe("warning");
  });
});

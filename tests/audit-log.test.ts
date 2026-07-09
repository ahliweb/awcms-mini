import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  findSecretShapedValues,
  findSensitiveKeys,
  redactSensitiveAttributes
} from "../src/modules/_shared/redaction";
import {
  getAuditExportHook,
  recordAuditEvent,
  setAuditExportHook,
  type AuditEventInput,
  type AuditEventRecorded
} from "../src/modules/logging/application/audit-log";

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

  test("redacts credential (Issue #516 — added for module settings rejection)", () => {
    expect(redactSensitiveAttributes({ credential: "shh" })).toEqual({
      credential: "[REDACTED]"
    });
  });
});

describe("findSensitiveKeys", () => {
  test("undefined input yields no keys", () => {
    expect(findSensitiveKeys(undefined)).toEqual([]);
  });

  test("no keys when nothing matches", () => {
    expect(findSensitiveKeys({ theme: "dark", retries: 3 })).toEqual([]);
  });

  test("finds a top-level secret-shaped key", () => {
    expect(findSensitiveKeys({ apiToken: "sk-123" })).toEqual(["apiToken"]);
  });

  test("finds a secret-shaped key nested in an object", () => {
    expect(findSensitiveKeys({ provider: { credential: "shh" } })).toEqual([
      "credential"
    ]);
  });

  test("finds a secret-shaped key nested inside an array of objects", () => {
    expect(
      findSensitiveKeys({ webhooks: [{ url: "x", secret: "shh" }] })
    ).toEqual(["secret"]);
  });
});

describe("findSecretShapedValues", () => {
  test("undefined input yields no paths", () => {
    expect(findSecretShapedValues(undefined)).toEqual([]);
  });

  test("ordinary label/URL/flag values are left alone", () => {
    expect(
      findSecretShapedValues({
        publicLabel: "Acme News",
        publicBasePath: "/news",
        enabled: true,
        webhookUrl: "https://example.com/hooks/acme"
      })
    ).toEqual([]);
  });

  test("finds a JWT-shaped value under an innocently-named key", () => {
    expect(
      findSecretShapedValues({
        // The canonical public example token from jwt.io's own debugger
        // (used verbatim in virtually every JWT tutorial) — a recognizable
        // non-secret, same convention as AWS's own "AKIA...EXAMPLE" key id
        // below, chosen so this fixture doesn't read as a real leaked token.
        publicLabel:
          "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
      })
    ).toEqual(["publicLabel"]);
  });

  test("finds a PEM private key block", () => {
    expect(
      findSecretShapedValues({
        note: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEA\n-----END PRIVATE KEY-----"
      })
    ).toEqual(["note"]);
  });

  test("finds an AWS access key id", () => {
    expect(
      findSecretShapedValues({ description: "AKIAIOSFODNN7EXAMPLE" })
    ).toEqual(["description"]);
  });

  test("finds a raw Bearer/Basic auth-header value", () => {
    expect(
      findSecretShapedValues({ title: "Bearer not-a-real-token-example-0000" })
    ).toEqual(["title"]);
  });

  test("finds a connection string with an embedded user:pass@ credential", () => {
    expect(
      findSecretShapedValues({
        webhookUrl: "postgres://admin:hunter2@db.example.com:5432/prod"
      })
    ).toEqual(["webhookUrl"]);
  });

  test("finds a secret-shaped value nested inside an object", () => {
    expect(
      findSecretShapedValues({
        provider: { note: "Bearer not-a-real-token-example-0000" }
      })
    ).toEqual(["provider.note"]);
  });

  test("finds a secret-shaped value nested inside an array of objects", () => {
    expect(
      findSecretShapedValues({
        webhooks: [
          { label: "ok" },
          { label: "Bearer not-a-real-token-example-0000" }
        ]
      })
    ).toEqual(["webhooks[1].label"]);
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

/**
 * `AuditExportHook` extension point (Issue #447). No DB is needed to test
 * the hook plumbing itself — `recordAuditEvent`'s only interaction with `tx`
 * is one tagged-template call, so a plain function standing in for
 * `Bun.SQL` is enough to exercise everything after the INSERT.
 */
describe("AuditExportHook extension point", () => {
  let originalConsoleLog: typeof console.log;

  function fakeTx(): Promise<unknown[]> {
    return Promise.resolve([]);
  }

  beforeEach(() => {
    originalConsoleLog = console.log;
    console.log = () => {};
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    setAuditExportHook(null);
  });

  test("default hook is null — zero behavior change for every deployment that never registers one", () => {
    expect(getAuditExportHook()).toBeNull();
  });

  test("a registered hook receives the already-redacted event right after the write", async () => {
    const received: AuditEventRecorded[] = [];
    setAuditExportHook((event) => {
      received.push(event);
    });

    await recordAuditEvent(fakeTx as unknown as Bun.SQL, {
      tenantId: "11111111-1111-1111-1111-111111111111",
      moduleKey: "logging",
      action: "purge",
      resourceType: "audit_event",
      severity: "warning",
      message: "Purged expired audit events.",
      attributes: { email: "user@example.com", purgedCount: 3 }
    });

    expect(received).toHaveLength(1);
    expect(received[0]!.action).toBe("purge");
    expect(received[0]!.resourceType).toBe("audit_event");
    // Redaction already applied — a hook can never see raw PII either.
    expect(received[0]!.attributes).toEqual({
      email: "[REDACTED]",
      purgedCount: 3
    });
    expect(received[0]!.recordedAt).toBeInstanceOf(Date);
  });

  test("a synchronously throwing hook never fails recordAuditEvent", async () => {
    setAuditExportHook(() => {
      throw new Error("derived app export hook exploded");
    });

    await expect(
      recordAuditEvent(fakeTx as unknown as Bun.SQL, {
        tenantId: "11111111-1111-1111-1111-111111111111",
        moduleKey: "logging",
        action: "purge",
        resourceType: "audit_event",
        message: "test"
      })
    ).resolves.toBeUndefined();
  });

  test("a rejecting async hook never fails recordAuditEvent", async () => {
    setAuditExportHook(async () => {
      throw new Error("derived app export hook rejected");
    });

    await expect(
      recordAuditEvent(fakeTx as unknown as Bun.SQL, {
        tenantId: "11111111-1111-1111-1111-111111111111",
        moduleKey: "logging",
        action: "purge",
        resourceType: "audit_event",
        message: "test"
      })
    ).resolves.toBeUndefined();
  });

  test("setAuditExportHook(null) detaches a previously registered hook", async () => {
    const received: AuditEventRecorded[] = [];
    setAuditExportHook((event) => {
      received.push(event);
    });
    setAuditExportHook(null);

    await recordAuditEvent(fakeTx as unknown as Bun.SQL, {
      tenantId: "11111111-1111-1111-1111-111111111111",
      moduleKey: "logging",
      action: "purge",
      resourceType: "audit_event",
      message: "test"
    });

    expect(received).toHaveLength(0);
    expect(getAuditExportHook()).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";

import {
  computeSyncSignature,
  isTimestampWithinSkew,
  verifySyncSignature
} from "../src/modules/sync-storage/domain/sync-hmac";
import { evaluatePushEventConflict } from "../src/modules/sync-storage/domain/sync-conflict";
import {
  validateConflictResolutionRequestBody,
  validateSyncPushRequestBody
} from "../src/modules/sync-storage/domain/sync-validation";

describe("computeSyncSignature", () => {
  test("is deterministic and depends on the secret, timestamp, and body", () => {
    const a = computeSyncSignature(
      "secret",
      "2026-07-05T00:00:00.000Z",
      '{"a":1}'
    );
    const b = computeSyncSignature(
      "secret",
      "2026-07-05T00:00:00.000Z",
      '{"a":1}'
    );
    const differentSecret = computeSyncSignature(
      "other-secret",
      "2026-07-05T00:00:00.000Z",
      '{"a":1}'
    );
    const differentBody = computeSyncSignature(
      "secret",
      "2026-07-05T00:00:00.000Z",
      '{"a":2}'
    );

    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(differentSecret);
    expect(a).not.toBe(differentBody);
  });
});

describe("verifySyncSignature", () => {
  const secret = "shared-secret";
  const timestamp = "2026-07-05T00:00:00.000Z";
  const body = '{"batchId":"b1","events":[]}';

  test("accepts a correctly computed signature", () => {
    const signature = computeSyncSignature(secret, timestamp, body);

    expect(verifySyncSignature(secret, timestamp, body, signature)).toBe(true);
  });

  test("rejects a tampered body", () => {
    const signature = computeSyncSignature(secret, timestamp, body);

    expect(
      verifySyncSignature(
        secret,
        timestamp,
        '{"batchId":"b1","events":[1]}',
        signature
      )
    ).toBe(false);
  });

  test("rejects the wrong secret", () => {
    const signature = computeSyncSignature(secret, timestamp, body);

    expect(
      verifySyncSignature("wrong-secret", timestamp, body, signature)
    ).toBe(false);
  });

  test("rejects a signature of the wrong length without throwing", () => {
    expect(verifySyncSignature(secret, timestamp, body, "abcd")).toBe(false);
  });
});

describe("isTimestampWithinSkew", () => {
  const now = new Date("2026-07-05T00:00:00.000Z");

  test("accepts a timestamp within the allowed skew", () => {
    expect(isTimestampWithinSkew("2026-07-05T00:04:00.000Z", now, 300)).toBe(
      true
    );
    expect(isTimestampWithinSkew("2026-07-04T23:56:00.000Z", now, 300)).toBe(
      true
    );
  });

  test("rejects a timestamp outside the allowed skew", () => {
    expect(isTimestampWithinSkew("2026-07-05T00:06:00.000Z", now, 300)).toBe(
      false
    );
  });

  test("rejects an unparseable timestamp", () => {
    expect(isTimestampWithinSkew("not-a-date", now, 300)).toBe(false);
  });
});

describe("validateSyncPushRequestBody", () => {
  const VALID_BODY = {
    batchId: "batch-1",
    events: [
      {
        eventType: "created",
        aggregateType: "example",
        payload: { foo: "bar" }
      }
    ]
  };

  test("accepts a valid body", () => {
    const result = validateSyncPushRequestBody(VALID_BODY);

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.batchId).toBe("batch-1");
      expect(result.value.events).toHaveLength(1);
    }
  });

  test("rejects a missing batchId", () => {
    const result = validateSyncPushRequestBody({ events: VALID_BODY.events });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContainEqual({
        field: "batchId",
        message: "batchId is required."
      });
    }
  });

  test("rejects an empty events array", () => {
    const result = validateSyncPushRequestBody({ batchId: "b1", events: [] });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContainEqual({
        field: "events",
        message: "events must be a non-empty array."
      });
    }
  });

  test("reports per-event validation errors with index", () => {
    const result = validateSyncPushRequestBody({
      batchId: "b1",
      events: [{ aggregateType: "example", payload: 1 }]
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContainEqual({
        field: "events[0].eventType",
        message: "eventType is required."
      });
    }
  });

  test("rejects a null body", () => {
    expect(validateSyncPushRequestBody(null).valid).toBe(false);
  });

  test("accepts an event with a valid baseVersion", () => {
    const result = validateSyncPushRequestBody({
      batchId: "b1",
      events: [
        {
          eventType: "updated",
          aggregateType: "example",
          aggregateId: "11111111-1111-1111-1111-111111111111",
          baseVersion: 2,
          payload: {}
        }
      ]
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.events[0]?.baseVersion).toBe(2);
    }
  });

  test("rejects a negative or non-integer baseVersion", () => {
    const negative = validateSyncPushRequestBody({
      batchId: "b1",
      events: [
        { eventType: "e", aggregateType: "a", baseVersion: -1, payload: {} }
      ]
    });
    const fractional = validateSyncPushRequestBody({
      batchId: "b1",
      events: [
        { eventType: "e", aggregateType: "a", baseVersion: 1.5, payload: {} }
      ]
    });

    expect(negative.valid).toBe(false);
    expect(fractional.valid).toBe(false);
  });
});

describe("evaluatePushEventConflict", () => {
  test("allows the first event for a fresh aggregate (version 0, no baseVersion)", () => {
    expect(evaluatePushEventConflict(0, undefined)).toEqual({
      conflict: false
    });
  });

  test("allows an event whose baseVersion matches the current version", () => {
    expect(evaluatePushEventConflict(3, 3)).toEqual({ conflict: false });
  });

  test("flags missing_base_version when the aggregate has history but no baseVersion is given", () => {
    expect(evaluatePushEventConflict(2, undefined)).toEqual({
      conflict: true,
      conflictType: "missing_base_version"
    });
  });

  test("flags version_mismatch when baseVersion is stale", () => {
    expect(evaluatePushEventConflict(3, 2)).toEqual({
      conflict: true,
      conflictType: "version_mismatch"
    });
  });

  test("flags version_mismatch even if baseVersion is ahead of the server (should not happen, but not silently accepted)", () => {
    expect(evaluatePushEventConflict(3, 4)).toEqual({
      conflict: true,
      conflictType: "version_mismatch"
    });
  });
});

describe("validateConflictResolutionRequestBody", () => {
  test("accepts a valid resolution without a note", () => {
    const result = validateConflictResolutionRequestBody({
      resolution: "accept_incoming"
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.resolution).toBe("accept_incoming");
      expect(result.value.note).toBeUndefined();
    }
  });

  test("accepts a valid resolution with a note", () => {
    const result = validateConflictResolutionRequestBody({
      resolution: "manual",
      note: "reconciled by hand"
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.note).toBe("reconciled by hand");
    }
  });

  test("rejects an unknown resolution value", () => {
    const result = validateConflictResolutionRequestBody({
      resolution: "auto_merge"
    });

    expect(result.valid).toBe(false);
  });

  test("rejects a non-string note", () => {
    const result = validateConflictResolutionRequestBody({
      resolution: "manual",
      note: 123
    });

    expect(result.valid).toBe(false);
  });

  test("rejects a null body", () => {
    expect(validateConflictResolutionRequestBody(null).valid).toBe(false);
  });
});

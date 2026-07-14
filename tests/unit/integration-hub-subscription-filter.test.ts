import { describe, expect, test } from "bun:test";
import {
  matchesSubscriptionFilter,
  validateSubscriptionFilter
} from "../../src/modules/integration-hub/domain/subscription-filter";

describe("validateSubscriptionFilter", () => {
  test("accepts an empty filter", () => {
    expect(validateSubscriptionFilter({}).ok).toBe(true);
  });

  test("accepts a bounded, flat, scalar-valued filter", () => {
    expect(
      validateSubscriptionFilter({ "body.adapterKey": "fixture_hmac_sha256" })
        .ok
    ).toBe(true);
  });

  test("rejects a non-object filter", () => {
    expect(validateSubscriptionFilter("not-an-object" as unknown).ok).toBe(
      false
    );
  });

  test("rejects an array filter", () => {
    expect(validateSubscriptionFilter([1, 2, 3] as unknown).ok).toBe(false);
  });

  test("rejects more than the max allowed keys", () => {
    const filter: Record<string, string> = {};
    for (let i = 0; i < 20; i += 1) {
      filter[`key${i}`] = "value";
    }
    expect(validateSubscriptionFilter(filter).ok).toBe(false);
  });

  test("rejects a path deeper than the max allowed depth", () => {
    expect(validateSubscriptionFilter({ "a.b.c.d.e": "value" }).ok).toBe(false);
  });

  test("rejects a non-scalar value (nested object)", () => {
    expect(
      validateSubscriptionFilter({
        path: { nested: true }
      } as unknown as Record<string, unknown>).ok
    ).toBe(false);
  });
});

describe("matchesSubscriptionFilter", () => {
  test("matches when every filter key equals the payload's value at that dotted path", () => {
    const payload = { body: { adapterKey: "fixture_hmac_sha256", size: 42 } };
    expect(
      matchesSubscriptionFilter(payload, {
        "body.adapterKey": "fixture_hmac_sha256"
      })
    ).toBe(true);
  });

  test("does not match when a filter value differs", () => {
    const payload = { body: { adapterKey: "fixture_hmac_sha256" } };
    expect(
      matchesSubscriptionFilter(payload, {
        "body.adapterKey": "generic_http_webhook"
      })
    ).toBe(false);
  });

  test("does not match when the path does not exist in the payload", () => {
    const payload = { body: {} };
    expect(
      matchesSubscriptionFilter(payload, { "body.missing": "value" })
    ).toBe(false);
  });
});

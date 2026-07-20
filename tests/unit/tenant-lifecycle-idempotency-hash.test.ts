/**
 * Unit tests for the `reason`-in-request-hash standardization (Issue #873 review
 * round, Fix 4). Every lifecycle mutation route now folds the (mandatory,
 * audited) `reason` into `computeRequestHash`. `runIdempotentLifecycleMutation`
 * compares the stored hash against the incoming one: a same-`Idempotency-Key`
 * retry with a DIFFERENT hash is a deterministic 409 `IDEMPOTENCY_CONFLICT`,
 * while an identical retry replays. Previously `initialize`/`restore`/`downgrade`
 * OMITTED `reason` from the hash, so a same-key retry with a different reason
 * would silently replay (or 409 only for the routes that did include it) — an
 * inconsistent audit provenance across the surface.
 *
 * These payloads mirror EXACTLY what each route passes to `computeRequestHash`
 * (see `src/pages/api/v1/tenant-lifecycle/tenants/[tenantId]/*.ts`). The
 * mechanism is deterministic (SHA-256 over stably key-sorted JSON), so no DB is
 * needed to prove the 409 boundary.
 */
import { describe, expect, test } from "bun:test";

import { computeRequestHash } from "../../src/modules/_shared/idempotency";

const TENANT = "00000000-0000-0000-0000-0000000000dd";

describe("lifecycle idempotency hash includes `reason` consistently (Fix 4)", () => {
  test("initialize: differing reason -> different hash (409 boundary)", () => {
    const base = (reason: string) =>
      computeRequestHash({
        tenantId: TENANT,
        initialState: "trial",
        reason,
        trialEndsAt: null,
        graceEndsAt: null
      });
    expect(base("go live")).toBe(base("go live")); // same payload replays
    expect(base("go live")).not.toBe(base("different reason")); // 409
  });

  test("restore: differing reason -> different hash (409 boundary)", () => {
    const base = (reason: string) =>
      computeRequestHash({
        tenantId: TENANT,
        action: "restore",
        reason,
        confirmUnresolved: false,
        expectedVersion: 2
      });
    expect(base("recover")).toBe(base("recover"));
    expect(base("recover")).not.toBe(base("recover harder"));
  });

  test("downgrade: differing reason -> different hash (409 boundary)", () => {
    const base = (reason: string) =>
      computeRequestHash({
        tenantId: TENANT,
        offerPlanKey: "basic",
        offerVersion: 1,
        reason,
        expectedVersion: 1
      });
    expect(base("cost")).toBe(base("cost"));
    expect(base("cost")).not.toBe(base("budget cut"));
  });

  test("transition/schedule/cancel already fold reason -> hash reflects it", () => {
    const transition = (reason: string) =>
      computeRequestHash({
        tenantId: TENANT,
        toState: "suspended",
        reason,
        source: "operator",
        expectedVersion: 1
      });
    const cancel = (reason: string) =>
      computeRequestHash({
        tenantId: TENANT,
        action: "cancel_schedule",
        reason,
        expectedVersion: 1
      });
    expect(transition("a")).not.toBe(transition("b"));
    expect(cancel("a")).not.toBe(cancel("b"));
  });
});

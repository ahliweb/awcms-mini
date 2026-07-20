/**
 * Unit tests for the neutral-ground restriction reader (Issue #873 review round,
 * Fix 2). The port JSDoc promises "a governing tenant whose state cannot be read
 * returns DENY_ALL, never throws" — so a real read error (dropped connection,
 * missing table, RLS/permission failure) MUST fail-CLOSED (governing + DENY_ALL),
 * never propagate, so a downstream consumer (#876) that trusts the contract can
 * never fall back to an unrestricted (fail-OPEN) profile on a transient fault.
 *
 * A hand-rolled fake `tx` (a tagged-template function) is enough — the reader
 * only issues one SELECT through it, so no real Postgres is required.
 */
import { describe, expect, test } from "bun:test";

import { readTenantRestrictionSnapshot } from "../../src/modules/_shared/tenant-lifecycle-restriction-read";
import {
  ALLOW_ALL,
  DENY_ALL
} from "../../src/modules/_shared/tenant-lifecycle-policy";

const TENANT = "00000000-0000-0000-0000-0000000000cc";

/** A `tx` whose query rejects, simulating a DB read error. */
function throwingTx(): Bun.SQL {
  const fn = () => Promise.reject(new Error("connection reset by peer"));
  return fn as unknown as Bun.SQL;
}

/** A `tx` returning `rows` for the single SELECT. */
function rowsTx(rows: unknown[]): Bun.SQL {
  const fn = () => Promise.resolve(rows);
  return fn as unknown as Bun.SQL;
}

describe("readTenantRestrictionSnapshot — fail-closed on read error", () => {
  test("a read error returns governing + DENY_ALL and NEVER throws", async () => {
    const snap = await readTenantRestrictionSnapshot(throwingTx(), TENANT);
    expect(snap.governing).toBe(true);
    expect(snap.state).toBeNull();
    expect(snap.version).toBeNull();
    expect(snap.profile).toEqual(DENY_ALL);
    expect(snap.profile.adminAccessAllowed).toBe(false);
    expect(snap.profile.writesAllowed).toBe(false);
    expect(snap.profile.publicSiteAllowed).toBe(false);
  });

  test("no lifecycle row -> not governing + ALLOW_ALL (offline/LAN baseline)", async () => {
    const snap = await readTenantRestrictionSnapshot(rowsTx([]), TENANT);
    expect(snap.governing).toBe(false);
    expect(snap.profile).toEqual(ALLOW_ALL);
  });

  test("an unknown/unclassifiable state -> governing + DENY_ALL", async () => {
    const snap = await readTenantRestrictionSnapshot(
      rowsTx([{ state: "not_a_real_state", version: 3 }]),
      TENANT
    );
    expect(snap.governing).toBe(true);
    expect(snap.state).toBeNull();
    expect(snap.version).toBe(3);
    expect(snap.profile).toEqual(DENY_ALL);
  });

  test("a known state -> governing + derived profile (not DENY_ALL for active)", async () => {
    const snap = await readTenantRestrictionSnapshot(
      rowsTx([{ state: "active", version: 1 }]),
      TENANT
    );
    expect(snap.governing).toBe(true);
    expect(snap.state).toBe("active");
    expect(snap.profile.adminAccessAllowed).toBe(true);
  });
});

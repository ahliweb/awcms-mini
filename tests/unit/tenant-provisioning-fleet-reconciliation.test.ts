/**
 * Unit tests for the fleet reconciliation scheduling policy (Issue #930,
 * epic #868).
 *
 * The load-bearing property is fairness across passes, not any single branch.
 * The first version of this job selected tenants by walking a stable
 * enumeration and stopping at a budget, which STARVES the tail: with a 20h
 * freshness interval on a daily schedule, every tenant the previous pass
 * touched is due again by the next tick, so the same head wins the budget
 * forever. The starvation test below reproduces that failure against the
 * rejected shape, and the rotation test proves the shipped one fixes it —
 * demonstrated, not asserted.
 */
import { describe, expect, test } from "bun:test";

import {
  classifyTenantForReconcile,
  RECONCILE_MAX_TENANTS_PER_RUN,
  RECONCILE_MIN_INTERVAL_HOURS,
  selectDueTenants,
  staleBefore
} from "../../src/modules/tenant-provisioning/application/fleet-reconciliation";

const NOW = new Date("2026-07-25T12:00:00.000Z");
const CUTOFF = staleBefore(NOW);

type FakeRequest = {
  id: string;
  status: never;
  lastReconciledAt: string | null;
};

function req(
  status: string,
  lastReconciledAt: string | null,
  id = "11111111-1111-1111-1111-111111111111"
): FakeRequest {
  return { id, status: status as never, lastReconciledAt };
}

function classify(request: FakeRequest | null, cutoff: Date = CUTOFF) {
  return classifyTenantForReconcile(request, { staleBefore: cutoff });
}

describe("fleet reconciliation — due-ness", () => {
  test("a provisioned tenant that has never been reconciled is due", () => {
    expect(classify(req("provisioned", null)).action).toBe("due");
  });

  test("a tenant with no provisioning run at all is skipped, not treated as due", () => {
    expect(classify(null)).toEqual({
      action: "skip",
      reason: "not_provisioned"
    });
  });

  test.each([
    ["requested"],
    ["running"],
    ["failed"],
    ["blocked"],
    ["canceled"],
    ["reconciling"]
  ])(
    "a request in %s is not reconcilable — the engine would reject it anyway",
    (status) => {
      expect(classify(req(status, null))).toEqual({
        action: "skip",
        reason: "not_provisioned"
      });
    }
  );

  test("reconcilability is checked BEFORE freshness, so a mid-provisioning tenant is not hidden behind a stale timestamp", () => {
    // Reconciled an hour ago, but since moved back to `running`. If freshness
    // were checked first this would report `still_fresh`, misdescribing why
    // nothing happened.
    const oneHourAgo = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    expect(classify(req("running", oneHourAgo))).toEqual({
      action: "skip",
      reason: "not_provisioned"
    });
  });

  test("a tenant reconciled inside the interval is skipped as fresh", () => {
    const recent = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    expect(classify(req("provisioned", recent))).toEqual({
      action: "skip",
      reason: "still_fresh"
    });
  });

  test("a tenant reconciled just outside the interval is due again", () => {
    const justStale = new Date(CUTOFF.getTime() - 60 * 1000).toISOString();
    expect(classify(req("provisioned", justStale)).action).toBe("due");
  });

  test("the interval is 20h, not 24h — a daily run that drifts later must not skip the tenant it did yesterday", () => {
    expect(RECONCILE_MIN_INTERVAL_HOURS).toBe(20);

    // Yesterday's pass ran 23h ago; today's tick drifted an hour later. At a
    // 24h interval this tenant would be skipped and silently fall to a 48h
    // cadence.
    const yesterday = new Date(
      NOW.getTime() - 23 * 60 * 60 * 1000
    ).toISOString();
    expect(classify(req("provisioned", yesterday)).action).toBe("due");
  });

  test("a due verdict carries its request, so the caller cannot re-derive the id from a separate check", () => {
    const request = req("provisioned", null, "abc");
    const verdict = classify(request);
    expect(verdict.action).toBe("due");
    if (verdict.action === "due") {
      expect(verdict.request.id).toBe("abc");
    }
  });
});

describe("fleet reconciliation — budget selection", () => {
  function candidate(id: string, lastReconciledAt: string | null) {
    return { id, lastReconciledAt };
  }

  test("never-reconciled tenants are selected ahead of every tenant that has been", () => {
    const { selected } = selectDueTenants(
      [
        candidate("old", "2026-07-01T00:00:00.000Z"),
        candidate("never-a", null),
        candidate("older", "2026-06-01T00:00:00.000Z"),
        candidate("never-b", null)
      ],
      2
    );
    expect(selected.map((c) => c.id).sort()).toEqual(["never-a", "never-b"]);
  });

  test("among reconciled tenants the stalest wins the budget", () => {
    const { selected, deferred } = selectDueTenants(
      [
        candidate("recent", "2026-07-20T00:00:00.000Z"),
        candidate("ancient", "2026-01-01T00:00:00.000Z"),
        candidate("middling", "2026-05-01T00:00:00.000Z")
      ],
      1
    );
    expect(selected.map((c) => c.id)).toEqual(["ancient"]);
    expect(deferred.map((c) => c.id)).toEqual(["middling", "recent"]);
  });

  test("deferred tenants are reported, not silently truncated", () => {
    const due = Array.from({ length: 5 }, (_, i) => candidate(`t${i}`, null));
    const { selected, deferred } = selectDueTenants(due, 2);
    expect(selected.length + deferred.length).toBe(5);
  });

  test("a budget larger than the due set defers nothing", () => {
    const { selected, deferred } = selectDueTenants(
      [candidate("a", null), candidate("b", null)],
      RECONCILE_MAX_TENANTS_PER_RUN
    );
    expect(selected.length).toBe(2);
    expect(deferred).toEqual([]);
  });

  test("selection does not mutate the caller's array", () => {
    const due = [
      candidate("z", "2026-07-20T00:00:00.000Z"),
      candidate("a", null)
    ];
    selectDueTenants(due, 1);
    expect(due.map((c) => c.id)).toEqual(["z", "a"]);
  });

  test("every tenant is eventually reconciled — the pass ROTATES across runs", () => {
    // Six tenants, budget of 2, three consecutive daily passes.
    const tenants = Array.from({ length: 6 }, (_, i) => ({
      id: `t${i}`,
      status: "provisioned" as never,
      lastReconciledAt: null as string | null
    }));

    for (let pass = 0; pass < 3; pass += 1) {
      const passNow = new Date(NOW.getTime() + pass * 24 * 60 * 60 * 1000);
      const cutoff = staleBefore(passNow);

      const due = tenants.filter(
        (t) =>
          classifyTenantForReconcile(t, { staleBefore: cutoff }).action ===
          "due"
      );
      const { selected } = selectDueTenants(due, 2);
      for (const t of selected) {
        t.lastReconciledAt = passNow.toISOString();
      }
    }

    // Every tenant reached within three passes, and each reconciled exactly
    // once — no tenant took a second turn while another was still waiting.
    expect(tenants.every((t) => t.lastReconciledAt !== null)).toBe(true);
    expect(new Set(tenants.map((t) => t.lastReconciledAt)).size).toBe(3);
  });

  test("the REJECTED shape — walk in enumeration order and stop at the budget — starves the tail", () => {
    // Reproduces the bug this design exists to avoid, so a future
    // simplification back to a single-phase loop fails here rather than in
    // production. Same six tenants, same budget, same daily cadence, but the
    // budget is spent in enumeration order instead of staleness order.
    const tenants = Array.from({ length: 6 }, (_, i) => ({
      id: `t${i}`,
      status: "provisioned" as never,
      lastReconciledAt: null as string | null
    }));

    for (let pass = 0; pass < 3; pass += 1) {
      const passNow = new Date(NOW.getTime() + pass * 24 * 60 * 60 * 1000);
      const cutoff = staleBefore(passNow);
      let done = 0;

      for (const t of tenants) {
        if (done >= 2) break;
        if (
          classifyTenantForReconcile(t, { staleBefore: cutoff }).action !==
          "due"
        ) {
          continue;
        }
        t.lastReconciledAt = passNow.toISOString();
        done += 1;
      }
    }

    // t0/t1 reconciled on every pass; t2..t5 never once. Not "late" — never.
    expect(
      tenants.filter((t) => t.lastReconciledAt === null).map((t) => t.id)
    ).toEqual(["t2", "t3", "t4", "t5"]);
  });
});

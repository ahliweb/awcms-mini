/**
 * Issue #743 (epic #738, platform-evolution): `scripts/work-class-registry-generate.ts`
 * generates `docs/awcms-mini/work-class-registry.generated.json` from every
 * `src/pages/api/v1/**` route that calls `withTenant(...)` and every
 * `scripts/*.ts` job that calls `getWorkerDatabaseClient()`/
 * `getSetupDatabaseClient()`. Mirrors the determinism/freshness pattern
 * `tests/unit/repo-inventory-generate.test.ts` (Issue #688) already
 * establishes for a similar generated artifact.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  WORK_CLASS_REGISTRY_PATH,
  buildWorkClassRegistryJson,
  buildWorkClassRegistrySnapshot,
  classifyJob,
  classifyRoute,
  findStaleJobRegistryEntries
} from "../../scripts/work-class-registry-generate";
import { runWorkClassRegistryCheck } from "../../scripts/work-class-registry-check";
import { JOB_WORK_CLASS_REGISTRY } from "../../src/lib/database/work-class-registry";
import type { WorkClass } from "../../src/lib/database/work-class";

const ALL_WORK_CLASSES: readonly WorkClass[] = [
  "critical_transaction",
  "interactive",
  "reporting",
  "background_sync",
  "maintenance"
];

describe("classifyRoute (pure)", () => {
  test("returns null for a route that never calls withTenant (exempted from classification)", () => {
    expect(
      classifyRoute(
        "src/pages/api/v1/health.ts",
        "export const GET = () => ok();"
      )
    ).toBeNull();
  });

  test("classifies as the documented default (interactive) when withTenant is called with no explicit workClass", () => {
    const entry = classifyRoute(
      "src/pages/api/v1/users/index.ts",
      "await withTenant(sql, tenantId, async (tx) => { return ok(); });"
    );

    expect(entry).toEqual({
      path: "src/pages/api/v1/users/index.ts",
      workClass: "interactive",
      source: "default"
    });
  });

  test("extracts an explicit workClass literal", () => {
    const entry = classifyRoute(
      "src/pages/api/v1/reports/tenant-activity.ts",
      'await withTenant(\n  sql,\n  tenantId,\n  fn,\n  { workClass: "reporting" }\n);'
    );

    expect(entry).toEqual({
      path: "src/pages/api/v1/reports/tenant-activity.ts",
      workClass: "reporting",
      source: "explicit"
    });
  });

  // Security-auditor finding, PR #770 (Issue #743): the original
  // `source.includes("withTenant(")` check was a deterministic false
  // negative for any call site written with an explicit generic type
  // argument — `withTenant<T>(...)` never contains the literal substring
  // `"withTenant("`. This is not a hypothetical: `src/pages/api/v1/media/
  // news-images/upload-sessions/index.ts` calls
  // `withTenant<CreateTxResult>(...)` today and was silently missing from
  // the committed registry as a result. These cases pin the fix
  // (`WITH_TENANT_CALL_PATTERN`) so it cannot silently regress back to a
  // plain substring check.
  test("detects a generic-typed withTenant<T>( call with no explicit workClass (regression: PR #770 security-auditor finding)", () => {
    const entry = classifyRoute(
      "src/pages/api/v1/media/news-images/upload-sessions/index.ts",
      "const txResult = await withTenant<CreateTxResult>(\n  sql,\n  tenantId,\n  async (tx) => {}\n);"
    );

    expect(entry).toEqual({
      path: "src/pages/api/v1/media/news-images/upload-sessions/index.ts",
      workClass: "interactive",
      source: "default"
    });
  });

  test("detects a generic-typed withTenant<T>( call AND still extracts an explicit workClass literal", () => {
    const entry = classifyRoute(
      "src/pages/api/v1/synthetic/generic-with-explicit-class.ts",
      'await withTenant<SomeResult>(\n  sql,\n  tenantId,\n  fn,\n  { workClass: "background_sync" }\n);'
    );

    expect(entry).toEqual({
      path: "src/pages/api/v1/synthetic/generic-with-explicit-class.ts",
      workClass: "background_sync",
      source: "explicit"
    });
  });

  test("also detects a generic-typed call with a namespaced/qualified type argument and extra whitespace", () => {
    const entry = classifyRoute(
      "src/pages/api/v1/synthetic/whitespace-generic.ts",
      "await withTenant   <   Foo.Bar   >   (sql, tenantId, fn);"
    );

    expect(entry?.workClass).toBe("interactive");
    expect(entry?.source).toBe("default");
  });
});

describe("classifyJob (pure)", () => {
  test("returns null for a script that never opens a worker/setup connection", () => {
    expect(
      classifyJob("scripts/github-snapshot-refresh.ts", "// no DB")
    ).toBeNull();
  });

  test("throws when a script opens a worker connection but has no JOB_WORK_CLASS_REGISTRY entry", () => {
    expect(() =>
      classifyJob(
        "scripts/some-brand-new-job.ts",
        "const sql = getWorkerDatabaseClient();"
      )
    ).toThrow(/JOB_WORK_CLASS_REGISTRY/);
  });

  test("returns the registered classification for a known worker job", () => {
    const entry = classifyJob(
      "scripts/audit-log-purge.ts",
      "const sql = getWorkerDatabaseClient();"
    );

    expect(entry).toEqual({
      path: "scripts/audit-log-purge.ts",
      workClass:
        JOB_WORK_CLASS_REGISTRY["scripts/audit-log-purge.ts"]!.workClass,
      source: "registry",
      rationale:
        JOB_WORK_CLASS_REGISTRY["scripts/audit-log-purge.ts"]!.rationale
    });
  });

  test("also detects getSetupDatabaseClient(", () => {
    // Synthetic path deliberately not in JOB_WORK_CLASS_REGISTRY, so this
    // only asserts detection (via the thrown, actionable error), not a
    // successful classification — the real setup caller is a ROUTE
    // (src/pages/api/v1/setup/initialize.ts), which is exempt from route
    // classification because it never calls withTenant(.
    expect(() =>
      classifyJob(
        "scripts/synthetic-setup-caller.ts",
        "getSetupDatabaseClient()"
      )
    ).toThrow(/JOB_WORK_CLASS_REGISTRY/);
  });
});

// Reviewer finding on PR #770: `work-class-registry.ts`'s header comment
// claimed a stale registry entry (a path that no longer exists, or no
// longer opens a worker/setup connection) makes the check fail — this was
// not actually implemented; `buildWorkClassRegistrySnapshot` only checked
// the opposite direction (a discovered file missing an entry, covered by
// `classifyJob`'s throw above). `findStaleJobRegistryEntries` closes that
// gap; these tests exercise it directly with a synthetic registry, without
// needing an actual stale entry to exist in the real repo.
describe("findStaleJobRegistryEntries (pure)", () => {
  test("returns empty when every registry key has a matching discovered path", () => {
    const stale = findStaleJobRegistryEntries(
      ["scripts/a.ts", "scripts/b.ts"],
      {
        "scripts/a.ts": { workClass: "maintenance", rationale: "r" },
        "scripts/b.ts": { workClass: "background_sync", rationale: "r" }
      }
    );

    expect(stale).toEqual([]);
  });

  test("flags a registry key with no matching discovered path (deleted/renamed script, or one that no longer opens a worker connection)", () => {
    const stale = findStaleJobRegistryEntries(["scripts/a.ts"], {
      "scripts/a.ts": { workClass: "maintenance", rationale: "r" },
      "scripts/deleted-job.ts": { workClass: "maintenance", rationale: "r" }
    });

    expect(stale).toEqual(["scripts/deleted-job.ts"]);
  });

  test("flags every stale key when multiple are stale", () => {
    const stale = findStaleJobRegistryEntries([], {
      "scripts/one.ts": { workClass: "maintenance", rationale: "r" },
      "scripts/two.ts": { workClass: "background_sync", rationale: "r" }
    });

    expect(stale.sort()).toEqual(["scripts/one.ts", "scripts/two.ts"]);
  });

  test("the real JOB_WORK_CLASS_REGISTRY has zero stale entries against the real discovered job set", async () => {
    const snapshot = await buildWorkClassRegistrySnapshot();
    const stale = findStaleJobRegistryEntries(
      snapshot.jobs.map((entry) => entry.path),
      JOB_WORK_CLASS_REGISTRY
    );

    expect(stale).toEqual([]);
  });
});

describe("JOB_WORK_CLASS_REGISTRY content", () => {
  test("every entry declares a valid WorkClass and a non-empty rationale", () => {
    for (const [path_, entry] of Object.entries(JOB_WORK_CLASS_REGISTRY)) {
      expect(path_.startsWith("scripts/")).toBe(true);
      expect(ALL_WORK_CLASSES).toContain(entry.workClass);
      expect(entry.rationale.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("buildWorkClassRegistrySnapshot against the real repo", () => {
  test("generating twice is deterministic (byte-identical JSON)", async () => {
    const first = await buildWorkClassRegistryJson();
    const second = await buildWorkClassRegistryJson();
    expect(second).toBe(first);
  });

  test("the committed snapshot matches what the generator produces right now (freshness)", async () => {
    const fresh = await buildWorkClassRegistryJson();
    const committed = await readFile(
      path.join(process.cwd(), WORK_CLASS_REGISTRY_PATH),
      "utf8"
    );
    expect(fresh).toBe(committed);
  });

  test("runWorkClassRegistryCheck reports no problems against the committed file", async () => {
    const problems = await runWorkClassRegistryCheck();
    expect(problems).toEqual([]);
  });

  test("discovers every route that calls withTenant, and only those", async () => {
    const snapshot = await buildWorkClassRegistrySnapshot();

    expect(snapshot.routes.length).toBeGreaterThan(100);
    for (const entry of snapshot.routes) {
      expect(entry.path.startsWith("src/pages/api/v1/")).toBe(true);
      expect(ALL_WORK_CLASSES).toContain(entry.workClass);
      expect(["explicit", "default"]).toContain(entry.source);
    }
    // Known-exempt routes (never call withTenant) must NOT appear.
    const paths = snapshot.routes.map((entry) => entry.path);
    expect(paths).not.toContain("src/pages/api/v1/health.ts");
    expect(paths).not.toContain("src/pages/api/v1/setup/initialize.ts");
    // Regression guard (security-auditor finding, PR #770): this REAL file
    // calls `withTenant<CreateTxResult>(...)` (a generic type argument) and
    // must be discovered, not silently dropped by a naive substring check.
    expect(paths).toContain(
      "src/pages/api/v1/media/news-images/upload-sessions/index.ts"
    );
  });

  test("discovers exactly the worker scripts registered in JOB_WORK_CLASS_REGISTRY", async () => {
    const snapshot = await buildWorkClassRegistrySnapshot();
    const discoveredPaths = snapshot.jobs.map((entry) => entry.path).sort();
    const registeredPaths = Object.keys(JOB_WORK_CLASS_REGISTRY).sort();

    expect(discoveredPaths).toEqual(registeredPaths);
  });

  test("routes are sorted alphabetically by path (deterministic diff-friendly ordering)", async () => {
    const snapshot = await buildWorkClassRegistrySnapshot();
    const paths = snapshot.routes.map((entry) => entry.path);
    const sorted = [...paths].sort((a, b) => a.localeCompare(b));

    expect(paths).toEqual(sorted);
  });
});

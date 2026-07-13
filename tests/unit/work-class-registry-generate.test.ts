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
  classifyRoute
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

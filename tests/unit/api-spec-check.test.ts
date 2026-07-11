/**
 * Drift-fixture tests for `scripts/api-spec-check.ts`'s route-parity and
 * public-operation-allowlist checks (Issue #685, epic #679) — proves each
 * gate actually FAILS on the drift shape it claims to catch, using
 * synthetic OpenAPI fragments / temp route directories rather than
 * mutating the real spec or `src/pages/api/v1/**`.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  checkPublicOperationAllowlist,
  checkRouteParity,
  ALLOWED_PUBLIC_OPERATIONS,
  ROUTES_DIR
} from "../../scripts/api-spec-check";

describe("checkPublicOperationAllowlist", () => {
  test("passes when the spec's public operations exactly match the allow-list", () => {
    const spec = {
      paths: Object.fromEntries(
        ALLOWED_PUBLIC_OPERATIONS.map((entry) => {
          const [method, apiPath] = entry.split(" ") as [string, string];
          return [apiPath, { [method.toLowerCase()]: { security: [] } }];
        })
      )
    };

    expect(checkPublicOperationAllowlist(spec, "spec.yaml")).toEqual([]);
  });

  // The checker validates against the real ALLOWED_PUBLIC_OPERATIONS
  // constant (not an injectable parameter), so every fixture below must
  // also stub a non-public operation for each real allow-list entry —
  // otherwise they'd all show up as spurious "no longer public" findings
  // alongside whatever drift the test actually means to isolate.
  function specWithAllowListSatisfied(extraPaths: Record<string, unknown>): {
    paths: Record<string, unknown>;
  } {
    const paths: Record<string, unknown> = { ...extraPaths };

    for (const entry of ALLOWED_PUBLIC_OPERATIONS) {
      const [method, apiPath] = entry.split(" ") as [string, string];
      paths[apiPath] = {
        ...(paths[apiPath] as Record<string, unknown> | undefined),
        [method.toLowerCase()]: { security: [] }
      };
    }

    return { paths };
  }

  test("fails when a NEW operation becomes public without an allow-list entry (drift fixture)", () => {
    const spec = specWithAllowListSatisfied({
      "/api/v1/some/new/route": { get: { security: [] } }
    });

    const problems = checkPublicOperationAllowlist(spec, "spec.yaml");
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain("GET /api/v1/some/new/route");
    expect(problems[0]!.message).toContain("not in ALLOWED_PUBLIC_OPERATIONS");
  });

  test("fails when an allow-listed operation is no longer public (stale allow-list entry)", () => {
    const spec = specWithAllowListSatisfied({});
    // Overwrite one allow-listed path so it's no longer `security: []`.
    const [firstEntry] = ALLOWED_PUBLIC_OPERATIONS;
    const [method, apiPath] = firstEntry!.split(" ") as [string, string];
    (spec.paths as Record<string, unknown>)[apiPath] = {
      [method.toLowerCase()]: { security: [{ bearerAuth: [] }] }
    };

    const problems = checkPublicOperationAllowlist(spec, "spec.yaml");
    const staleFindings = problems.filter((p) =>
      p.message.includes("no longer documented as public")
    );
    expect(staleFindings).toHaveLength(1);
    expect(staleFindings[0]!.message).toContain(firstEntry!);
  });

  test("an operation inheriting the global security requirement (no `security` key) is not flagged as public", () => {
    const spec = specWithAllowListSatisfied({
      "/api/v1/protected/thing": { get: {} }
    });

    expect(checkPublicOperationAllowlist(spec, "spec.yaml")).toEqual([]);
  });
});

describe("checkRouteParity", () => {
  async function withTempRoutes(
    files: Record<string, string>,
    run: (rootDir: string) => Promise<void>
  ): Promise<void> {
    const rootDir = await mkdtemp(path.join(tmpdir(), "route-parity-"));

    try {
      for (const [relativePath, content] of Object.entries(files)) {
        const fullPath = path.join(rootDir, ROUTES_DIR, relativePath);
        await mkdir(path.dirname(fullPath), { recursive: true });
        await writeFile(fullPath, content, "utf8");
      }

      await run(rootDir);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  }

  test("passes when every route file has a matching OpenAPI operation", async () => {
    await withTempRoutes(
      {
        "widgets/[id].ts":
          "export const GET: unknown = async () => {};\nexport const DELETE: unknown = async () => {};\n"
      },
      async (rootDir) => {
        const spec = {
          paths: {
            "/api/v1/widgets/{id}": { get: {}, delete: {} }
          }
        };

        expect(await checkRouteParity(spec, rootDir, "spec.yaml")).toEqual([]);
      }
    );
  });

  test("fails when a route file exports a method with no matching OpenAPI operation (undocumented endpoint)", async () => {
    await withTempRoutes(
      {
        "widgets/[id].ts": "export const PATCH: unknown = async () => {};\n"
      },
      async (rootDir) => {
        const spec = {
          paths: {
            "/api/v1/widgets/{id}": {}
          }
        };

        const problems = await checkRouteParity(spec, rootDir, "spec.yaml");
        expect(problems).toHaveLength(1);
        expect(problems[0]!.message).toContain("PATCH");
        expect(problems[0]!.message).toContain("no matching operation");
      }
    );
  });

  test("fails when the OpenAPI spec documents a method with no corresponding route file (stale documentation)", async () => {
    await withTempRoutes(
      {
        "widgets/[id].ts": "export const GET: unknown = async () => {};\n"
      },
      async (rootDir) => {
        const spec = {
          paths: {
            "/api/v1/widgets/{id}": { get: {}, delete: {} }
          }
        };

        const problems = await checkRouteParity(spec, rootDir, "spec.yaml");
        expect(problems).toHaveLength(1);
        expect(problems[0]!.message).toContain("DELETE");
        expect(problems[0]!.message).toContain("no route file");
      }
    );
  });

  test("treats differently-named dynamic segments as structurally equal ([id] vs {widgetId})", async () => {
    await withTempRoutes(
      {
        "widgets/[id].ts": "export const GET: unknown = async () => {};\n"
      },
      async (rootDir) => {
        const spec = {
          paths: {
            "/api/v1/widgets/{widgetId}": { get: {} }
          }
        };

        expect(await checkRouteParity(spec, rootDir, "spec.yaml")).toEqual([]);
      }
    );
  });

  test("index.ts maps to the containing directory's path with no /index suffix", async () => {
    await withTempRoutes(
      {
        "widgets/index.ts": "export const GET: unknown = async () => {};\n"
      },
      async (rootDir) => {
        const spec = {
          paths: {
            "/api/v1/widgets": { get: {} }
          }
        };

        expect(await checkRouteParity(spec, rootDir, "spec.yaml")).toEqual([]);
      }
    );
  });

  test("ignores *.test.ts files under the routes directory", async () => {
    await withTempRoutes(
      {
        "widgets/index.ts": "export const GET: unknown = async () => {};\n",
        "widgets/index.test.ts":
          "export const POST: unknown = async () => {};\n"
      },
      async (rootDir) => {
        const spec = {
          paths: {
            "/api/v1/widgets": { get: {} }
          }
        };

        expect(await checkRouteParity(spec, rootDir, "spec.yaml")).toEqual([]);
      }
    );
  });
});

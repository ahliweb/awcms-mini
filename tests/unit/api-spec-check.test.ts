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
  checkOperationIdUniqueness,
  checkPathParameters,
  checkStandardErrorSchema,
  checkOperationSecurityMetadata,
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

  test("an operation with an empty security requirement ({}) alongside a real one is treated as public (drift fixture, PR #711 review)", () => {
    // Per OpenAPI 3.x, `security: [{ bearerAuth: [] }, {}]` means "either a
    // valid bearer token OR no credentials at all" -- the empty alternative
    // makes the whole operation effectively unauthenticated, identical to
    // `security: []`. This must be caught the same way a bare `security: []`
    // is, not silently accepted because the array happens to be non-empty.
    const spec = specWithAllowListSatisfied({
      "/api/v1/some/new/route": {
        get: { security: [{ bearerAuth: [] }, {}] }
      }
    });

    const problems = checkPublicOperationAllowlist(spec, "spec.yaml");
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain("GET /api/v1/some/new/route");
    expect(problems[0]!.message).toContain("not in ALLOWED_PUBLIC_OPERATIONS");
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

// Issue #695 (epic #679): fixture tests proving each new split-hardening
// check actually fails on the drift shape it claims to catch.
describe("checkOperationIdUniqueness", () => {
  test("passes when every operationId is unique", () => {
    const spec = {
      paths: {
        "/api/v1/widgets": { get: { operationId: "listWidgets" } },
        "/api/v1/widgets/{id}": { get: { operationId: "getWidget" } }
      }
    };

    expect(checkOperationIdUniqueness(spec, "spec.yaml")).toEqual([]);
  });

  test("fails when two operations share an operationId, naming both locations (drift fixture)", () => {
    const spec = {
      paths: {
        "/api/v1/widgets": { get: { operationId: "widgetsOp" } },
        "/api/v1/widgets/{id}": { get: { operationId: "widgetsOp" } }
      }
    };

    const problems = checkOperationIdUniqueness(spec, "spec.yaml");
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain('"widgetsOp"');
    expect(problems[0]!.message).toContain("GET /api/v1/widgets");
    expect(problems[0]!.message).toContain("GET /api/v1/widgets/{id}");
  });
});

describe("checkPathParameters", () => {
  test("passes when path params exactly match declared parameters", () => {
    const spec = {
      paths: {
        "/api/v1/widgets/{id}": {
          get: {
            parameters: [
              {
                name: "id",
                in: "path",
                required: true,
                schema: { type: "string" }
              }
            ]
          }
        }
      }
    };

    expect(checkPathParameters(spec, "spec.yaml")).toEqual([]);
  });

  test("resolves $ref parameters against components.parameters", () => {
    const spec = {
      components: {
        parameters: {
          WidgetId: {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" }
          }
        }
      },
      paths: {
        "/api/v1/widgets/{id}": {
          get: { parameters: [{ $ref: "#/components/parameters/WidgetId" }] }
        }
      }
    };

    expect(checkPathParameters(spec, "spec.yaml")).toEqual([]);
  });

  test("fails when a path segment has no matching parameter declaration (drift fixture)", () => {
    const spec = {
      paths: {
        "/api/v1/widgets/{id}": { get: { parameters: [] } }
      }
    };

    const problems = checkPathParameters(spec, "spec.yaml");
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain("{id}");
    expect(problems[0]!.message).toContain("no matching parameters entry");
  });

  test("fails when a declared path parameter doesn't appear in the path template (drift fixture)", () => {
    const spec = {
      paths: {
        "/api/v1/widgets": {
          get: {
            parameters: [
              {
                name: "id",
                in: "path",
                required: true,
                schema: { type: "string" }
              }
            ]
          }
        }
      }
    };

    const problems = checkPathParameters(spec, "spec.yaml");
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain('declares path parameter "id"');
  });

  test("fails when a path parameter isn't marked required: true", () => {
    const spec = {
      paths: {
        "/api/v1/widgets/{id}": {
          get: {
            parameters: [
              {
                name: "id",
                in: "path",
                required: false,
                schema: { type: "string" }
              }
            ]
          }
        }
      }
    };

    const problems = checkPathParameters(spec, "spec.yaml");
    expect(
      problems.some((p) => p.message.includes("must declare required: true"))
    ).toBe(true);
  });
});

describe("checkStandardErrorSchema", () => {
  const componentsWithApiError = {
    responses: {
      BadRequest: {
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiError" }
          }
        }
      }
    }
  };

  test("passes when every error response resolves to ApiError via $ref to components.responses", () => {
    const spec = {
      components: componentsWithApiError,
      paths: {
        "/api/v1/widgets": {
          get: {
            responses: { "400": { $ref: "#/components/responses/BadRequest" } }
          }
        }
      }
    };

    expect(checkStandardErrorSchema(spec, "spec.yaml")).toEqual([]);
  });

  test("passes when ApiError is one alternative of a oneOf (documented status-code overload)", () => {
    const spec = {
      paths: {
        "/api/v1/auth/login": {
          post: {
            responses: {
              "401": {
                content: {
                  "application/json": {
                    schema: {
                      oneOf: [
                        { $ref: "#/components/schemas/ApiError" },
                        {
                          $ref: "#/components/schemas/LoginMfaRequiredResponse"
                        }
                      ]
                    }
                  }
                }
              }
            }
          }
        }
      }
    };

    expect(checkStandardErrorSchema(spec, "spec.yaml")).toEqual([]);
  });

  test("ignores 2xx/3xx responses", () => {
    const spec = {
      paths: {
        "/api/v1/widgets": {
          get: {
            responses: {
              "200": {
                content: { "application/json": { schema: { type: "object" } } }
              },
              "302": { description: "redirect" }
            }
          }
        }
      }
    };

    expect(checkStandardErrorSchema(spec, "spec.yaml")).toEqual([]);
  });

  test("fails when an error response uses an ad-hoc inline schema instead of ApiError (drift fixture)", () => {
    const spec = {
      paths: {
        "/api/v1/widgets": {
          get: {
            responses: {
              "400": {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { oops: { type: "string" } }
                    }
                  }
                }
              }
            }
          }
        }
      }
    };

    const problems = checkStandardErrorSchema(spec, "spec.yaml");
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain("400");
    expect(problems[0]!.message).toContain(
      "does not resolve to the shared ApiError schema"
    );
  });
});

describe("checkOperationSecurityMetadata", () => {
  test("passes when security is explicit and allow-listed as public", () => {
    const spec = {
      components: { securitySchemes: {} },
      paths: {
        [ALLOWED_PUBLIC_OPERATIONS[0]!.split(" ")[1]!]: {
          [ALLOWED_PUBLIC_OPERATIONS[0]!.split(" ")[0]!.toLowerCase()]: {
            security: []
          }
        }
      }
    };

    expect(checkOperationSecurityMetadata(spec, "spec.yaml")).toEqual([]);
  });

  test("passes when security is explicit and non-empty", () => {
    const spec = {
      components: { securitySchemes: { bearerAuth: {} } },
      paths: {
        "/api/v1/widgets": { get: { security: [{ bearerAuth: [] }] } }
      }
    };

    expect(checkOperationSecurityMetadata(spec, "spec.yaml")).toEqual([]);
  });

  // This is the gap checkPublicOperationAllowlist (Issue #685) does NOT
  // cover: that check only looks at operations with EXPLICIT
  // `security: []`. An operation with no `security` key at all inherits the
  // document's global default per the OpenAPI spec, so
  // checkPublicOperationAllowlist correctly does not flag it as "public" —
  // but this project's convention is that every operation states its
  // security stance explicitly, so checkOperationSecurityMetadata fails it
  // instead (see the same fixture asserted as a pass in
  // checkPublicOperationAllowlist's "no security key" test above).
  test("fails when security is entirely absent and not allow-listed (drift fixture)", () => {
    const spec = {
      components: { securitySchemes: {} },
      paths: {
        "/api/v1/widgets": { get: {} }
      }
    };

    const problems = checkOperationSecurityMetadata(spec, "spec.yaml");
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain("GET /api/v1/widgets");
    expect(problems[0]!.message).toContain(
      "declares no security requirement at all"
    );
  });

  test("fails when a security requirement references an undefined scheme (typo)", () => {
    const spec = {
      components: { securitySchemes: { bearerAuth: {} } },
      paths: {
        "/api/v1/widgets": { get: { security: [{ bearrAuth: [] }] } }
      }
    };

    const problems = checkOperationSecurityMetadata(spec, "spec.yaml");
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain('undefined scheme "bearrAuth"');
  });

  // Security-auditor finding, PR #711 review: `security: [{}]` (an empty
  // requirement alongside a real one) is effectively public per OpenAPI 3.x
  // semantics -- previously neither this check nor
  // checkPublicOperationAllowlist flagged it, since `.length === 0` is false
  // and the empty requirement's own key-iteration loop never runs.
  test("fails when security includes an empty requirement alternative and is not allow-listed (drift fixture)", () => {
    const spec = {
      components: { securitySchemes: { bearerAuth: {} } },
      paths: {
        "/api/v1/widgets": {
          get: { security: [{ bearerAuth: [] }, {}] }
        }
      }
    };

    const problems = checkOperationSecurityMetadata(spec, "spec.yaml");
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain("GET /api/v1/widgets");
    expect(problems[0]!.message).toContain("empty alternative");
  });

  test("passes when an empty security requirement is allow-listed as public", () => {
    const [publicMethod, publicPath] = ALLOWED_PUBLIC_OPERATIONS[0]!.split(
      " "
    ) as [string, string];

    const spec = {
      components: { securitySchemes: { bearerAuth: {} } },
      paths: {
        [publicPath]: {
          [publicMethod.toLowerCase()]: { security: [{}] }
        }
      }
    };

    expect(checkOperationSecurityMetadata(spec, "spec.yaml")).toEqual([]);
  });
});

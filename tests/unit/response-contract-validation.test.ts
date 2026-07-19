/**
 * Response-vs-published-schema contract validation (Issue #844, epic #818).
 *
 * The problem this closes: nothing in the repo ever compared a REAL response
 * body (or the data a response is built from) against the PUBLISHED OpenAPI
 * contract. `api:spec:check`/`api:docs:check` only prove the bundle is fresh
 * relative to its module sources and that generated docs match the bundle —
 * artefact-vs-artefact, never artefact-vs-reality. So an endpoint whose body
 * is derived from a hand-maintained TypeScript structure could silently
 * violate its own contract, and every gate stayed green. That is exactly what
 * happened with `sensitiveFields.naturalKeyField` (Issue #820, caught by hand
 * in review of PR #839).
 *
 * This gate validates the response an endpoint ACTUALLY emits against the
 * published bundle (`openapi/awcms-mini-public-api.openapi.yaml`) — the very
 * artefact generated clients consume, and the one that resolves the shared
 * `ApiSuccess`/`ApiMeta` envelope. It supersedes and folds in the narrow
 * `data-exchange-descriptor-contract-parity` test (Issue #844 scope: "test
 * parity sempit boleh dilebur"): its naturalKeyField-specific and
 * load-bearing assertions live on below.
 *
 * Priority target: endpoints whose body is serialized VERBATIM from a
 * hand-maintained TypeScript registry — where the schema and the code are two
 * copies of one contract with nothing tying them together. The one wired here
 * is `GET /api/v1/data-exchange/descriptors`. Adding another endpoint is one
 * entry in ENDPOINT_CASES.
 */
import { describe, expect, test } from "bun:test";

import {
  getResponseSchema,
  loadOpenApiDocument,
  validateAgainstSchema,
  type JsonSchema,
  type OpenApiDocument
} from "../../scripts/lib/openapi-response-validator";
import { ok } from "../../src/modules/_shared/api-response";
import { listModules } from "../../src/modules";
import { collectExchangeDescriptors } from "../../src/modules/data-exchange/domain/exchange-registry";

const BUNDLE_PATH = "openapi/awcms-mini-public-api.openapi.yaml";

type EndpointCase = {
  name: string;
  path: string;
  method: string;
  status: string;
  /**
   * Produce the exact body the handler returns for the happy path. We route it
   * through the real `ok()` envelope and re-parse the serialized JSON so the
   * gate sees the actual bytes on the wire, not an in-memory shortcut.
   */
  buildResponseBody: () => Promise<unknown>;
};

const ENDPOINT_CASES: EndpointCase[] = [
  {
    name: "GET /api/v1/data-exchange/descriptors",
    path: "/api/v1/data-exchange/descriptors",
    method: "GET",
    status: "200",
    buildResponseBody: async () => {
      const descriptors = collectExchangeDescriptors(listModules());
      return ok({ descriptors }).json();
    }
  },
  {
    // Issue #870 — service_catalog plan summary list (ServiceCatalogPlanSummary).
    name: "GET /api/v1/service-catalog/plans",
    path: "/api/v1/service-catalog/plans",
    method: "GET",
    status: "200",
    buildResponseBody: async () =>
      ok({
        plans: [
          {
            planKey: "starter",
            name: "Starter",
            description: null,
            planType: "subscription",
            status: "active",
            versionCount: 2,
            latestVersion: 2,
            latestVersionStatus: "published",
            hasDraft: false,
            createdAt: "2026-07-19T00:00:00.000Z",
            updatedAt: "2026-07-19T00:00:00.000Z"
          }
        ]
      }).json()
  },
  {
    // Issue #870 — the complex nested detail (ServiceCatalogPlanDetail with a
    // fully populated version incl. features/quotas/prices).
    name: "GET /api/v1/service-catalog/plans/{planKey}",
    path: "/api/v1/service-catalog/plans/{planKey}",
    method: "GET",
    status: "200",
    buildResponseBody: async () =>
      ok({
        plan: {
          planKey: "starter",
          name: "Starter",
          description: "A starter plan",
          planType: "subscription",
          status: "active",
          createdAt: "2026-07-19T00:00:00.000Z",
          updatedAt: "2026-07-19T00:00:00.000Z",
          versions: [
            {
              id: "00000000-0000-0000-0000-000000000001",
              version: 1,
              status: "published",
              currency: "IDR",
              market: null,
              trialEnabled: true,
              trialDays: 14,
              availableFrom: null,
              availableTo: null,
              notes: null,
              offerHash: "abc123",
              publishedAt: "2026-07-19T00:00:00.000Z",
              retiredAt: null,
              createdAt: "2026-07-19T00:00:00.000Z",
              updatedAt: "2026-07-19T00:00:00.000Z",
              features: [
                {
                  featureKind: "module",
                  featureKey: "blog_content",
                  enabled: true,
                  metadata: {}
                }
              ],
              quotas: [
                {
                  meterKey: "platform.api_calls",
                  isUnlimited: false,
                  limitValue: 1000,
                  unit: "requests",
                  resetPolicy: "monthly",
                  metadata: {}
                }
              ],
              prices: [
                {
                  componentKey: "base",
                  amountMinor: 9900000,
                  currency: "IDR",
                  interval: "monthly",
                  visibility: "public",
                  metadata: {}
                }
              ]
            }
          ]
        }
      }).json()
  }
];

describe("response-vs-published-schema contract validation", () => {
  const doc: OpenApiDocument = loadOpenApiDocument(BUNDLE_PATH);

  test("the published bundle actually parsed and has paths -- an empty doc would make every assertion below vacuous", () => {
    expect((doc.paths as Record<string, unknown>) ?? {}).not.toEqual({});
  });

  for (const endpoint of ENDPOINT_CASES) {
    describe(endpoint.name, () => {
      test("the real response body satisfies the published schema", async () => {
        const schema = getResponseSchema(doc, endpoint);
        const body = await endpoint.buildResponseBody();
        const problems = validateAgainstSchema(body, schema, doc);
        expect(problems).toEqual([]);
      });
    });
  }

  // ---- data-exchange descriptor specifics, folded from the narrow parity test ----

  describe("data-exchange descriptor drift guards (Issue #820 / #844)", () => {
    const schema: JsonSchema = getResponseSchema(doc, ENDPOINT_CASES[0]!);

    test("the registry actually has descriptors -- an empty list would make the checks below vacuous", () => {
      expect(collectExchangeDescriptors(listModules()).length).toBeGreaterThan(
        0
      );
    });

    test("naturalKeyField specifically is declared -- the exact key that drifted (Issue #820)", () => {
      const descriptorSchema = (
        doc.components as { schemas?: Record<string, JsonSchema> }
      ).schemas?.DataExchangeDescriptor;
      const sensitiveFields = descriptorSchema?.properties?.sensitiveFields;
      expect(sensitiveFields).toBeDefined();
      expect(Object.keys(sensitiveFields!.properties ?? {})).toContain(
        "naturalKeyField"
      );
    });

    test("LOAD-BEARING: an undeclared property on a descriptor IS reported red", async () => {
      const descriptors = collectExchangeDescriptors(listModules()) as Record<
        string,
        unknown
      >[];
      // Inject a key the published schema does not declare.
      const tampered = descriptors.map((d, i) =>
        i === 0 ? { ...d, somethingUndeclared: 1 } : d
      );
      const body = await ok({ descriptors: tampered }).json();
      const problems = validateAgainstSchema(body, schema, doc);
      expect(problems.join("\n")).toContain("somethingUndeclared");
      expect(problems.some((p) => p.includes("undeclared property"))).toBe(
        true
      );
    });

    test("LOAD-BEARING: a wrong-typed field IS reported red", async () => {
      const descriptors = collectExchangeDescriptors(listModules()) as Record<
        string,
        unknown
      >[];
      const tampered = descriptors.map((d, i) =>
        i === 0 ? { ...d, key: 12345 } : d
      );
      const body = await ok({ descriptors: tampered }).json();
      const problems = validateAgainstSchema(body, schema, doc);
      expect(problems.some((p) => p.includes("expected type string"))).toBe(
        true
      );
    });

    test("LOAD-BEARING: a missing required field IS reported red", async () => {
      const descriptors = collectExchangeDescriptors(listModules()) as Record<
        string,
        unknown
      >[];
      const tampered = descriptors.map((d, i) => {
        if (i !== 0) return d;
        const { sensitiveFields: _drop, ...rest } = d;
        return rest;
      });
      const body = await ok({ descriptors: tampered }).json();
      const problems = validateAgainstSchema(body, schema, doc);
      expect(
        problems.some(
          (p) => p.includes("sensitiveFields") && p.includes("required")
        )
      ).toBe(true);
    });
  });

  // ---- validator self-checks: prove the walker itself is not silently a no-op ----

  describe("validator self-checks", () => {
    const doc2: OpenApiDocument = {
      components: {
        schemas: {
          Thing: {
            type: "object",
            additionalProperties: false,
            required: ["id"],
            properties: {
              id: { type: "string" },
              count: { type: "integer" },
              kind: { type: "string", enum: ["a", "b"] }
            }
          }
        }
      }
    };
    const thing = { $ref: "#/components/schemas/Thing" } as JsonSchema;

    test("a valid object passes clean", () => {
      expect(
        validateAgainstSchema({ id: "x", count: 3, kind: "a" }, thing, doc2)
      ).toEqual([]);
    });

    test("undeclared key on a closed schema is caught", () => {
      const problems = validateAgainstSchema({ id: "x", nope: 1 }, thing, doc2);
      expect(problems.some((p) => p.includes("nope"))).toBe(true);
    });

    test("missing required is caught", () => {
      const problems = validateAgainstSchema({ count: 1 }, thing, doc2);
      expect(problems.some((p) => p.includes("required"))).toBe(true);
    });

    test("integer type rejects a non-integer", () => {
      const problems = validateAgainstSchema(
        { id: "x", count: 1.5 },
        thing,
        doc2
      );
      expect(problems.some((p) => p.includes("expected type integer"))).toBe(
        true
      );
    });

    test("enum violation is caught", () => {
      const problems = validateAgainstSchema(
        { id: "x", kind: "z" },
        thing,
        doc2
      );
      expect(problems.some((p) => p.includes("enum"))).toBe(true);
    });

    test("allOf merges branches (envelope pattern) instead of rejecting closed siblings", () => {
      const doc3: OpenApiDocument = {
        components: {
          schemas: {
            Envelope: {
              type: "object",
              required: ["success", "data"],
              additionalProperties: false,
              properties: {
                success: { type: "boolean" },
                data: { description: "payload" }
              }
            }
          }
        }
      };
      const schema: JsonSchema = {
        allOf: [
          { $ref: "#/components/schemas/Envelope" },
          {
            type: "object",
            additionalProperties: false,
            required: ["data"],
            properties: {
              data: {
                type: "object",
                additionalProperties: false,
                required: ["n"],
                properties: { n: { type: "integer" } }
              }
            }
          }
        ]
      };
      // `success` (from the first branch) must NOT read as undeclared under the
      // second branch -- that is precisely the ajv-strict failure we avoid.
      expect(
        validateAgainstSchema({ success: true, data: { n: 1 } }, schema, doc3)
      ).toEqual([]);
      // But a genuinely undeclared key inside the merged set still fails.
      expect(
        validateAgainstSchema(
          { success: true, data: { n: 1 }, extra: 9 },
          schema,
          doc3
        ).some((p) => p.includes("extra"))
      ).toBe(true);
    });
  });
});

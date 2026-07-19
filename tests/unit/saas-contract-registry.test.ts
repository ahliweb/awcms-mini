/**
 * Unit + mutation tests for the SINGLE SaaS contract registry (Issue #874,
 * epic #868 SaaS control plane). Covers merge/order, fail-closed membership,
 * every validation rule (each proven by a mutation that MUST make the gate
 * fail — memory `failopen-catch-hides-untested-sql`), the dummy derived-module
 * contribution (build with vs without application contributions), and the
 * generated-inventory freshness gate (stale inventory MUST fail).
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { listBaseModules, listModules } from "../../src/modules";
import type { ModuleDescriptor } from "../../src/modules/_shared/module-contract";
import {
  isKnownCommercialEventType,
  isKnownFeatureGrant,
  isKnownMeterKey,
  isKnownQuotaKey,
  isValidSaasKeyFormat,
  resolveSaasContractRegistry,
  validateSaasContractRegistry
} from "../../src/modules/_shared/saas-contract-registry";
import { exampleLoyaltyModule } from "../fixtures/derived-application-example/modules/example-loyalty/module";
import {
  SAAS_CONTRACT_INVENTORY_JSON_PATH,
  buildSaasContractInventory,
  buildSaasContractInventoryJson,
  buildSaasContractInventoryMarkdown
} from "../../scripts/saas-contract-inventory-generate";
import { runSaasContractRegistryCheck } from "../../scripts/saas-contract-registry-check";
import { ASYNCAPI_PATH } from "../../scripts/api-spec-check";

// A minimal, always-valid meter body reused across cases.
function meter(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "m.meter",
    ownerModuleKey: "m",
    description: "d",
    eventVersion: "1.0",
    valueType: "count",
    aggregation: "sum",
    correction: "none",
    classification: "informational",
    privacyClassification: "non_personal",
    bounds: { minValue: 0, maxValue: 9007199254740991 },
    ...over
  };
}

function mod(
  key: string,
  serviceCatalog: Record<string, unknown>,
  over: Partial<ModuleDescriptor> = {}
): ModuleDescriptor {
  return {
    key,
    name: key,
    version: "1.0.0",
    status: "active",
    description: "",
    dependencies: [],
    serviceCatalog,
    ...over
  } as ModuleDescriptor;
}

describe("resolveSaasContractRegistry — merge/order", () => {
  test("unions descriptors across modules; first declaration of a key wins", () => {
    const registry = resolveSaasContractRegistry([
      mod("a", {
        features: [{ key: "a.f", ownerModuleKey: "a", description: "first" }]
      }),
      mod("b", {
        features: [
          { key: "b.f", ownerModuleKey: "b", description: "b" },
          { key: "a.f", ownerModuleKey: "b", description: "second" }
        ],
        meters: [meter({ key: "b.m", ownerModuleKey: "b" })]
      })
    ]);
    expect([...registry.featureKeys].sort()).toEqual(["a.f", "b.f"]);
    expect(registry.features.get("a.f")?.description).toBe("first");
    expect(registry.meterKeys.has("b.m")).toBe(true);
    expect(registry.moduleKeys.has("a")).toBe(true);
    expect(registry.moduleKeys.has("b")).toBe(true);
  });
});

describe("membership helpers — fail closed", () => {
  const registry = resolveSaasContractRegistry([
    mod("m", {
      features: [{ key: "m.feat", ownerModuleKey: "m", description: "f" }],
      meters: [meter({ key: "m.meter", ownerModuleKey: "m" })],
      quotas: [
        {
          key: "m.quota",
          ownerModuleKey: "m",
          description: "q",
          meterKey: "m.meter",
          unit: "call",
          resetPeriod: "monthly",
          enforcement: "soft"
        }
      ],
      commercialEvents: [
        {
          eventType: "awcms-mini.m.thing.happened",
          ownerModuleKey: "m",
          eventVersion: "1.0",
          kind: "lifecycle",
          description: "e"
        }
      ]
    })
  ]);

  test("known keys resolve; unknown/malformed fail closed", () => {
    expect(isKnownFeatureGrant(registry, "feature", "m.feat")).toBe(true);
    expect(isKnownFeatureGrant(registry, "module", "m")).toBe(true);
    expect(isKnownFeatureGrant(registry, "feature", "m.meter")).toBe(false);
    expect(isKnownFeatureGrant(registry, "feature", "unknown.x")).toBe(false);
    expect(isKnownFeatureGrant(registry, "feature", "Bad Key!!")).toBe(false);
    expect(isKnownMeterKey(registry, "m.meter")).toBe(true);
    expect(isKnownMeterKey(registry, "m.feat")).toBe(false);
    expect(isKnownQuotaKey(registry, "m.quota")).toBe(true);
    expect(isKnownQuotaKey(registry, "m.meter")).toBe(false);
    expect(
      isKnownCommercialEventType(registry, "awcms-mini.m.thing.happened")
    ).toBe(true);
    expect(isKnownCommercialEventType(registry, "awcms-mini.m.nope")).toBe(
      false
    );
  });

  test("isValidSaasKeyFormat", () => {
    expect(isValidSaasKeyFormat("platform.api_calls")).toBe(true);
    expect(isValidSaasKeyFormat("a_b")).toBe(true);
    expect(isValidSaasKeyFormat("Bad")).toBe(false);
    expect(isValidSaasKeyFormat("a.")).toBe(false);
    expect(isValidSaasKeyFormat(123)).toBe(false);
    expect(isValidSaasKeyFormat("a".repeat(121))).toBe(false);
  });
});

describe("validateSaasContractRegistry — the live registry is valid", () => {
  test("listModules() validates clean", () => {
    const result = validateSaasContractRegistry(listModules());
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.featureCount).toBeGreaterThan(0);
    expect(result.meterCount).toBeGreaterThan(0);
  });
});

/**
 * Mutation tests — each takes an otherwise-VALID registry and introduces ONE
 * defect that MUST make validation fail with a message pointing at it. Without
 * this, a fail-open validator (memory `failopen-catch-hides-untested-sql`)
 * would pass a broken descriptor silently.
 */
describe("validateSaasContractRegistry — mutations must fail", () => {
  function messages(modules: ModuleDescriptor[]): string {
    const r = validateSaasContractRegistry(modules);
    expect(r.valid).toBe(false);
    return r.issues.map((i) => i.message).join(" | ");
  }

  test("duplicate feature key", () => {
    const out = messages([
      mod("a", {
        features: [{ key: "x.f", ownerModuleKey: "a", description: "d" }]
      }),
      mod("b", {
        features: [{ key: "x.f", ownerModuleKey: "b", description: "d" }]
      })
    ]);
    expect(out).toContain("declared 2 times");
  });

  test("feature/meter key collision", () => {
    const out = messages([
      mod("a", {
        features: [{ key: "x.k", ownerModuleKey: "a", description: "d" }],
        meters: [meter({ key: "x.k", ownerModuleKey: "a" })]
      })
    ]);
    expect(out).toContain("both a feature and a meter");
  });

  test("unknown owner (ownerModuleKey != declaring module)", () => {
    const out = messages([
      mod("a", {
        features: [
          { key: "a.f", ownerModuleKey: "somebody_else", description: "d" }
        ]
      })
    ]);
    expect(out).toContain("must equal the declaring module's own key");
  });

  test("unsafe unit", () => {
    const out = messages([
      mod("m", {
        meters: [meter()],
        quotas: [
          {
            key: "m.q",
            ownerModuleKey: "m",
            description: "q",
            meterKey: "m.meter",
            unit: "Bad Unit!",
            resetPeriod: "monthly",
            enforcement: "soft"
          }
        ]
      })
    ]);
    expect(out).toContain("unsafe-unit guard");
  });

  test("missing/invalid privacy classification", () => {
    const out = messages([
      mod("m", { meters: [meter({ privacyClassification: undefined })] })
    ]);
    expect(out).toContain("privacyClassification must be explicit");
  });

  test("conflicting aggregation semantics (gauge + sum)", () => {
    const out = messages([
      mod("m", { meters: [meter({ valueType: "gauge", aggregation: "sum" })] })
    ]);
    expect(out).toContain("conflicts with valueType");
  });

  test("negative lower bound without signed_delta correction", () => {
    const out = messages([
      mod("m", {
        meters: [
          meter({ correction: "none", bounds: { minValue: -1, maxValue: 10 } })
        ]
      })
    ]);
    expect(out).toContain("negative-value-abuse guard");
  });

  test("overflow maxValue", () => {
    const out = messages([
      mod("m", {
        meters: [meter({ bounds: { minValue: 0, maxValue: 9007199254740992 } })]
      })
    ]);
    expect(out).toContain("overflow guard");
  });

  test("quota references an unknown meter (dangling)", () => {
    const out = messages([
      mod("m", {
        meters: [meter()],
        quotas: [
          {
            key: "m.q",
            ownerModuleKey: "m",
            description: "q",
            meterKey: "m.nonexistent",
            unit: "call",
            resetPeriod: "monthly",
            enforcement: "soft"
          }
        ]
      })
    ]);
    expect(out).toContain("does not resolve to any known meter");
  });

  test("hard enforcement on an informational meter", () => {
    const out = messages([
      mod("m", {
        meters: [meter({ classification: "informational" })],
        quotas: [
          {
            key: "m.q",
            ownerModuleKey: "m",
            description: "q",
            meterKey: "m.meter",
            unit: "call",
            resetPeriod: "monthly",
            enforcement: "hard"
          }
        ]
      })
    ]);
    expect(out).toContain("cannot be hard-enforced");
  });

  test("deprecated thin contributesFeatureKeys is rejected", () => {
    const out = messages([mod("m", { contributesFeatureKeys: ["m.legacy"] })]);
    expect(out).toContain("contributesFeatureKeys is deprecated");
  });

  test("commercial event not listed in the module's events.publishes", () => {
    const out = messages([
      mod(
        "m",
        {
          commercialEvents: [
            {
              eventType: "awcms-mini.m.thing.happened",
              ownerModuleKey: "m",
              eventVersion: "1.0",
              kind: "lifecycle",
              description: "e"
            }
          ]
        },
        { events: { publishes: [] } }
      )
    ]);
    expect(out).toContain("is not listed in module");
  });

  test("invalid meter eventVersion", () => {
    const out = messages([
      mod("m", { meters: [meter({ eventVersion: "v1" })] })
    ]);
    expect(out).toContain("eventVersion");
  });

  // --- Issue #874 review L2: close the mutation-coverage gaps. Each case below
  // RED-verifies a specific fail-closed guard — delete the guard and the case's
  // `expect(r.valid).toBe(false)` (inside messages()) starts failing.

  test("underflow minValue below MIN_SAFE_INTEGER (even with signed_delta)", () => {
    const out = messages([
      mod("m", {
        meters: [
          meter({
            correction: "signed_delta",
            bounds: { minValue: -9007199254740992, maxValue: 10 }
          })
        ]
      })
    ]);
    expect(out).toContain("underflow guard");
  });

  test("unknown meter valueType (also proves the aggregation-compat block cannot silently skip)", () => {
    const out = messages([
      mod("m", { meters: [meter({ valueType: "nope" })] })
    ]);
    expect(out).toContain("valueType");
    expect(out).toContain("count, gauge");
  });

  test("unknown meter aggregation", () => {
    const out = messages([
      mod("m", { meters: [meter({ aggregation: "nope" })] })
    ]);
    expect(out).toContain("aggregation");
    expect(out).toContain("sum, max, last, unique_count");
  });

  test("unknown meter correction", () => {
    const out = messages([
      mod("m", { meters: [meter({ correction: "nope" })] })
    ]);
    expect(out).toContain("correction");
    expect(out).toContain("none, signed_delta");
  });

  test("unknown meter classification", () => {
    const out = messages([
      mod("m", { meters: [meter({ classification: "nope" })] })
    ]);
    expect(out).toContain("billable, informational");
  });

  test("meter with a missing description", () => {
    const out = messages([mod("m", { meters: [meter({ description: "" })] })]);
    expect(out).toContain("description is required");
  });

  test("meter with missing bounds", () => {
    const out = messages([
      mod("m", { meters: [meter({ bounds: undefined })] })
    ]);
    expect(out).toContain("bounds is required");
  });

  test("meter with minValue greater than maxValue", () => {
    const out = messages([
      mod("m", { meters: [meter({ bounds: { minValue: 10, maxValue: 5 } })] })
    ]);
    expect(out).toContain("must be <= bounds.maxValue");
  });

  test("feature with a missing description", () => {
    const out = messages([
      mod("m", { features: [{ key: "m.f", ownerModuleKey: "m" }] })
    ]);
    expect(out).toContain("description is required");
  });

  test("unknown quota resetPeriod", () => {
    const out = messages([
      mod("m", {
        meters: [meter()],
        quotas: [
          {
            key: "m.q",
            ownerModuleKey: "m",
            description: "q",
            meterKey: "m.meter",
            unit: "call",
            resetPeriod: "nope",
            enforcement: "soft"
          }
        ]
      })
    ]);
    expect(out).toContain("resetPeriod");
    expect(out).toContain("billing_cycle");
  });

  test("unknown quota enforcement", () => {
    const out = messages([
      mod("m", {
        meters: [meter()],
        quotas: [
          {
            key: "m.q",
            ownerModuleKey: "m",
            description: "q",
            meterKey: "m.meter",
            unit: "call",
            resetPeriod: "monthly",
            enforcement: "nope"
          }
        ]
      })
    ]);
    expect(out).toContain("hard, soft, advisory");
  });

  test("quota with a missing description", () => {
    const out = messages([
      mod("m", {
        meters: [meter()],
        quotas: [
          {
            key: "m.q",
            ownerModuleKey: "m",
            meterKey: "m.meter",
            unit: "call",
            resetPeriod: "monthly",
            enforcement: "soft"
          }
        ]
      })
    ]);
    expect(out).toContain("description is required");
  });

  test("unknown commercial-event kind", () => {
    const out = messages([
      mod(
        "m",
        {
          commercialEvents: [
            {
              eventType: "awcms-mini.m.thing.happened",
              ownerModuleKey: "m",
              eventVersion: "1.0",
              kind: "nope",
              description: "e"
            }
          ]
        },
        { events: { publishes: ["awcms-mini.m.thing.happened"] } }
      )
    ]);
    expect(out).toContain("lifecycle, commercial");
  });

  test("malformed commercial-event eventType (isolated from the publishes-parity guard)", () => {
    const out = messages([
      mod(
        "m",
        {
          commercialEvents: [
            {
              eventType: "Bad Type!",
              ownerModuleKey: "m",
              eventVersion: "1.0",
              kind: "lifecycle",
              description: "e"
            }
          ]
        },
        // publishes the same malformed value, so ONLY the format guard fires.
        { events: { publishes: ["Bad Type!"] } }
      )
    ]);
    expect(out).toContain("must be a dotted address");
  });

  test("commercial event owned by another module", () => {
    const out = messages([
      mod(
        "m",
        {
          commercialEvents: [
            {
              eventType: "awcms-mini.m.thing.happened",
              ownerModuleKey: "somebody_else",
              eventVersion: "1.0",
              kind: "lifecycle",
              description: "e"
            }
          ]
        },
        { events: { publishes: ["awcms-mini.m.thing.happened"] } }
      )
    ]);
    expect(out).toContain("must equal the declaring module's own key");
  });

  test("deprecated thin contributesMeterKeys is rejected", () => {
    const out = messages([mod("m", { contributesMeterKeys: ["m.legacy"] })]);
    expect(out).toContain("contributesMeterKeys is deprecated");
  });
});

describe("build with vs without application contributions (dummy derived module)", () => {
  test("base alone does not contain the fixture loyalty descriptors", () => {
    const base = resolveSaasContractRegistry(listBaseModules());
    expect(base.featureKeys.has("loyalty.points_program")).toBe(false);
    expect(base.meterKeys.has("loyalty.points_delta")).toBe(false);
    expect(base.quotaKeys.has("loyalty.points_balance_cap")).toBe(false);
  });

  test("base + the derived fixture module contributes one feature/meter/quota and stays valid", () => {
    const withApp = [...listBaseModules(), exampleLoyaltyModule];
    const registry = resolveSaasContractRegistry(withApp);
    expect(registry.featureKeys.has("loyalty.points_program")).toBe(true);
    expect(registry.meterKeys.has("loyalty.points_delta")).toBe(true);
    expect(registry.quotaKeys.has("loyalty.points_balance_cap")).toBe(true);
    // The signed-delta meter legitimately declares a negative lower bound.
    expect(registry.meters.get("loyalty.points_delta")?.bounds.minValue).toBe(
      -1000000
    );
    const result = validateSaasContractRegistry(withApp);
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

describe("generated inventory freshness", () => {
  test("committed JSON matches a fresh regeneration", async () => {
    const committed = await Bun.file(SAAS_CONTRACT_INVENTORY_JSON_PATH).text();
    expect(buildSaasContractInventoryJson(listModules())).toBe(committed);
  });

  test("inventory carries owner module, version, unit, aggregation, privacy, billable", () => {
    const inv = buildSaasContractInventory(listModules());
    const apiCalls = inv.meters.find((m) => m.key === "platform.api_calls");
    expect(apiCalls?.ownerModule).toBe("service_catalog");
    expect(apiCalls?.eventVersion).toBe("1.0");
    expect(apiCalls?.aggregation).toBe("sum");
    expect(apiCalls?.privacyClassification).toBe("non_personal");
    expect(apiCalls?.billable).toBe(true);
    const apiQuota = inv.quotas.find(
      (q) => q.key === "platform.api_call_quota"
    );
    expect(apiQuota?.unit).toBe("call");
  });

  test("MUTATION: a stale committed inventory makes the check fail", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "saas-inv-"));
    const docsDir = path.join(root, "docs/awcms-mini");
    const asyncDir = path.join(root, "asyncapi");
    await mkdir(docsDir, { recursive: true });
    await mkdir(asyncDir, { recursive: true });
    await cp(ASYNCAPI_PATH, path.join(root, ASYNCAPI_PATH));

    // Fresh MD (built against this temp root so only the JSON is stale), plus a
    // deliberately-stale JSON.
    const freshMd = await buildSaasContractInventoryMarkdown(
      listModules(),
      root
    );
    await writeFile(
      path.join(root, "docs/awcms-mini/saas-contract-registry.generated.md"),
      freshMd,
      "utf8"
    );
    await writeFile(
      path.join(root, SAAS_CONTRACT_INVENTORY_JSON_PATH),
      '{ "stale": true }\n',
      "utf8"
    );

    const problems = await runSaasContractRegistryCheck(root);
    expect(
      problems.some((p) => p.includes("does not match a fresh regeneration"))
    ).toBe(true);
  });

  test("runSaasContractRegistryCheck passes clean against the real repo", async () => {
    const problems = await runSaasContractRegistryCheck();
    expect(problems).toEqual([]);
  });
});

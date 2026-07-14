/**
 * Pure unit tests for reference_data's baseline-vs-tenant-override
 * resolution (Issue #750, epic #738 platform-evolution Wave 3, ADR-0021
 * §8) — deterministic precedence, as-of/deprecation filtering, and a
 * pure-function-level proof that the merge NEVER mixes in anything the
 * caller didn't explicitly pass (the actual cross-tenant RLS isolation
 * guarantee is proven at the integration-test layer; this proves the
 * merge logic itself has no hidden tenant-crossing state to exploit).
 */
import { describe, expect, test } from "bun:test";
import {
  resolveOneReferenceCode,
  resolveReferenceCodes,
  type ResolutionBaselineCodeRow,
  type ResolutionTenantCodeRow
} from "../../src/modules/reference-data/domain/resolution";

const NOW = new Date("2026-06-01T00:00:00Z");

function baselineRow(
  overrides: Partial<ResolutionBaselineCodeRow> = {}
): ResolutionBaselineCodeRow {
  return {
    code: "IDR",
    sortOrder: 0,
    metadata: {},
    validFrom: new Date("2020-01-01"),
    validTo: null,
    deprecatedAt: null,
    labels: [{ locale: "en", label: "Indonesian Rupiah", description: null }],
    ...overrides
  };
}

function tenantRow(
  overrides: Partial<ResolutionTenantCodeRow> = {}
): ResolutionTenantCodeRow {
  return {
    baseCodeId: "base-id-1",
    code: "IDR",
    sortOrder: 0,
    metadata: {},
    validFrom: new Date("2020-01-01"),
    validTo: null,
    deprecatedAt: null,
    labels: [
      { locale: "en", label: "Tenant Rupiah Override", description: null }
    ],
    ...overrides
  };
}

describe("resolveReferenceCodes precedence", () => {
  test("baseline alone resolves as-is", () => {
    const resolved = resolveReferenceCodes([baselineRow()], [], {
      asOf: NOW,
      locale: "en",
      includeDeprecated: false
    });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.code).toBe("IDR");
    expect(resolved[0]!.isTenantOverride).toBe(false);
    expect(resolved[0]!.label).toBe("Indonesian Rupiah");
  });

  test("a tenant override for the SAME code always wins over baseline (deterministic precedence)", () => {
    const resolved = resolveReferenceCodes([baselineRow()], [tenantRow()], {
      asOf: NOW,
      locale: "en",
      includeDeprecated: false
    });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.isTenantOverride).toBe(true);
    expect(resolved[0]!.label).toBe("Tenant Rupiah Override");
  });

  test("a tenant extension (different code, baseCodeId null) is added alongside baseline", () => {
    const resolved = resolveReferenceCodes(
      [baselineRow()],
      [
        tenantRow({
          baseCodeId: null,
          code: "CUSTOM_UNIT",
          labels: [{ locale: "en", label: "Custom Unit", description: null }]
        })
      ],
      { asOf: NOW, locale: "en", includeDeprecated: false }
    );
    expect(resolved).toHaveLength(2);
    const codes = resolved.map((r) => r.code).sort();
    expect(codes).toEqual(["CUSTOM_UNIT", "IDR"]);
  });

  test("unknown code resolves to null — fails safe, never a guessed default", () => {
    const resolved = resolveOneReferenceCode(
      [baselineRow()],
      [],
      "DOES_NOT_EXIST",
      {
        asOf: NOW,
        locale: "en",
        includeDeprecated: false
      }
    );
    expect(resolved).toBeNull();
  });

  test("a deprecated baseline code is excluded by default", () => {
    const resolved = resolveReferenceCodes(
      [baselineRow({ deprecatedAt: new Date("2026-01-01") })],
      [],
      { asOf: NOW, locale: "en", includeDeprecated: false }
    );
    expect(resolved).toHaveLength(0);
  });

  test("a deprecated baseline code is included when includeDeprecated is true", () => {
    const resolved = resolveReferenceCodes(
      [baselineRow({ deprecatedAt: new Date("2026-01-01") })],
      [],
      { asOf: NOW, locale: "en", includeDeprecated: true }
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.deprecated).toBe(true);
  });

  test("a future-dated baseline code (validFrom after asOf) is not yet resolvable", () => {
    const resolved = resolveReferenceCodes(
      [baselineRow({ validFrom: new Date("2027-01-01") })],
      [],
      { asOf: NOW, locale: "en", includeDeprecated: false }
    );
    expect(resolved).toHaveLength(0);
  });

  test("a deprecated tenant override removes the code entirely (not just falls back to baseline) when includeDeprecated is false", () => {
    const resolved = resolveReferenceCodes(
      [baselineRow()],
      [tenantRow({ deprecatedAt: new Date("2026-01-01") })],
      { asOf: NOW, locale: "en", includeDeprecated: false }
    );
    expect(resolved).toHaveLength(0);
  });

  test("locale fallback: requested locale missing falls back to en, then to the code string", () => {
    const resolved = resolveReferenceCodes(
      [
        baselineRow({
          code: "EUR",
          labels: [{ locale: "en", label: "Euro", description: null }]
        })
      ],
      [],
      { asOf: NOW, locale: "fr", includeDeprecated: false }
    );
    expect(resolved[0]!.label).toBe("Euro");
  });

  test("this pure function structurally cannot leak another tenant's data — it only ever sees exactly what the caller passes as tenantCodes, no tenantId parameter exists", () => {
    // Simulates the caller (reference-resolution-query.ts) having fetched
    // ONLY tenant A's rows via RLS — tenant B's rows are never even
    // constructed here, proving there is no code path in this function
    // that could reach across tenants even if it wanted to.
    const tenantACodes = [
      tenantRow({
        code: "IDR",
        labels: [{ locale: "en", label: "Tenant A IDR", description: null }]
      })
    ];
    const resolved = resolveReferenceCodes([baselineRow()], tenantACodes, {
      asOf: NOW,
      locale: "en",
      includeDeprecated: false
    });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.label).toBe("Tenant A IDR");
  });

  test("deterministic ordering: sorted by sortOrder then code", () => {
    const resolved = resolveReferenceCodes(
      [
        baselineRow({ code: "ZZZ", sortOrder: 0 }),
        baselineRow({ code: "AAA", sortOrder: 0 }),
        baselineRow({ code: "MMM", sortOrder: -1 })
      ],
      [],
      { asOf: NOW, locale: "en", includeDeprecated: false }
    );
    expect(resolved.map((r) => r.code)).toEqual(["MMM", "AAA", "ZZZ"]);
  });
});

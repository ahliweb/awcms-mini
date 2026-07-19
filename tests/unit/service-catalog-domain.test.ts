/**
 * `service_catalog` pure-domain tests (Issue #870, epic #868) — key registry
 * (fail-closed), plan/version validation (bounds, exact money, currency
 * match), lifecycle transitions, and the published-offer snapshot/hash.
 *
 * MUTATION-GUARD (AC): the "unknown feature key is rejected" and "unknown
 * meter key is rejected" tests are the fail-closed guard — if the validator
 * were changed to accept unknown keys, they turn red. (Editing a published
 * version is guarded end-to-end in the integration test.)
 */
import { describe, expect, test } from "bun:test";
import type { ModuleDescriptor } from "../../src/modules/_shared/module-contract";
import {
  isKnownFeatureGrant,
  isKnownMeterKey,
  isValidServiceCatalogKeyFormat,
  resolveServiceCatalogKeyRegistry
} from "../../src/modules/service-catalog/domain/key-registry";
import {
  validatePlanHeader,
  validateVersionContent,
  type PlanType,
  type PriceInterval,
  type QuotaResetPolicy,
  type VersionContentInput
} from "../../src/modules/service-catalog/domain/plan";
import {
  assertPublishable,
  assertRetirable,
  canEditDraft,
  canPublish,
  canRetire
} from "../../src/modules/service-catalog/domain/lifecycle";
import {
  buildOfferSnapshot,
  offerHashInputKeys,
  OFFER_HASH_FIELDS,
  PROJECTION_COLUMN_TO_HASH_FIELD,
  type OfferHeader
} from "../../src/modules/service-catalog/domain/offer-snapshot";
import {
  parseFeatureGrant,
  parsePrice,
  parseQuota,
  parseVersionContent
} from "../../src/modules/service-catalog/application/request-parsing";

function descriptor(
  key: string,
  serviceCatalog?: ModuleDescriptor["serviceCatalog"]
): ModuleDescriptor {
  return {
    key,
    name: key,
    version: "1.0.0",
    status: "active",
    description: "",
    dependencies: [],
    serviceCatalog
  };
}

const registry = resolveServiceCatalogKeyRegistry([
  descriptor("blog_content"),
  descriptor("service_catalog", {
    contributesFeatureKeys: ["platform.api_access"],
    contributesMeterKeys: ["platform.api_calls"]
  })
]);

function content(
  overrides: Partial<VersionContentInput> = {}
): VersionContentInput {
  return {
    currency: "IDR",
    market: null,
    trialEnabled: false,
    trialDays: null,
    availableFrom: null,
    availableTo: null,
    notes: null,
    features: [],
    quotas: [],
    prices: [],
    ...overrides
  };
}

function header(overrides: Partial<OfferHeader> = {}): OfferHeader {
  return {
    planKey: "plan_a",
    planName: "Plan A",
    planType: "subscription",
    version: 1,
    ...overrides
  };
}

describe("key registry (fail-closed)", () => {
  test("aggregates feature + meter keys from descriptors, module keys from the registry", () => {
    expect(registry.moduleKeys.has("blog_content")).toBe(true);
    expect(registry.moduleKeys.has("service_catalog")).toBe(true);
    expect(registry.featureKeys.has("platform.api_access")).toBe(true);
    expect(registry.meterKeys.has("platform.api_calls")).toBe(true);
  });

  test("module-kind grant checks the module registry; feature-kind checks feature keys", () => {
    expect(isKnownFeatureGrant(registry, "module", "blog_content")).toBe(true);
    expect(
      isKnownFeatureGrant(registry, "feature", "platform.api_access")
    ).toBe(true);
    // cross-kind mismatch: a module key is NOT a feature key and vice versa
    expect(isKnownFeatureGrant(registry, "feature", "blog_content")).toBe(
      false
    );
    expect(isKnownFeatureGrant(registry, "module", "platform.api_access")).toBe(
      false
    );
  });

  test("unknown keys fail closed", () => {
    expect(isKnownFeatureGrant(registry, "module", "does_not_exist")).toBe(
      false
    );
    expect(isKnownFeatureGrant(registry, "feature", "nope.nope")).toBe(false);
    expect(isKnownMeterKey(registry, "nope.meter")).toBe(false);
  });

  test("format gate rejects malformed keys before membership", () => {
    expect(isValidServiceCatalogKeyFormat("platform.api_access")).toBe(true);
    expect(isValidServiceCatalogKeyFormat("Bad Key")).toBe(false);
    expect(isValidServiceCatalogKeyFormat("1leading")).toBe(false);
    expect(isValidServiceCatalogKeyFormat("a".repeat(200))).toBe(false);
  });
});

describe("version content validation", () => {
  test("a minimal valid content passes", () => {
    expect(validateVersionContent(content(), registry)).toEqual([]);
  });

  test("MUTATION-GUARD: an unknown feature key is rejected (fail-closed)", () => {
    const errors = validateVersionContent(
      content({
        features: [
          {
            featureKind: "feature",
            featureKey: "totally.unknown",
            enabled: true,
            metadata: {}
          }
        ]
      }),
      registry
    );
    expect(errors.some((e) => e.field === "features[0].featureKey")).toBe(true);
  });

  test("MUTATION-GUARD: an unknown meter key is rejected (fail-closed)", () => {
    const errors = validateVersionContent(
      content({
        quotas: [
          {
            meterKey: "unknown.meter",
            isUnlimited: false,
            limitValue: 10,
            unit: "count",
            resetPolicy: "monthly",
            metadata: {}
          }
        ]
      }),
      registry
    );
    expect(errors.some((e) => e.field === "quotas[0].meterKey")).toBe(true);
  });

  test("a whole-module entitlement to a real module is accepted", () => {
    const errors = validateVersionContent(
      content({
        features: [
          {
            featureKind: "module",
            featureKey: "blog_content",
            enabled: true,
            metadata: {}
          }
        ]
      }),
      registry
    );
    expect(errors).toEqual([]);
  });

  test("a fractional (float) amount is rejected — money is exact minor units", () => {
    const errors = validateVersionContent(
      content({
        prices: [
          {
            componentKey: "base",
            amountMinor: 99.5,
            currency: "IDR",
            interval: "monthly",
            visibility: "public",
            metadata: {}
          }
        ]
      }),
      registry
    );
    expect(errors.some((e) => e.field === "prices[0].amountMinor")).toBe(true);
  });

  test("Fix 4: an amount above Number.MAX_SAFE_INTEGER is rejected (validation backs the DB CHECK)", () => {
    const errors = validateVersionContent(
      content({
        prices: [
          {
            componentKey: "base",
            amountMinor: 9007199254740992,
            currency: "IDR",
            interval: "monthly",
            visibility: "public",
            metadata: {}
          }
        ]
      }),
      registry
    );
    expect(errors.some((e) => e.field === "prices[0].amountMinor")).toBe(true);
  });

  test("Fix 4: a quota limitValue above Number.MAX_SAFE_INTEGER is rejected", () => {
    const errors = validateVersionContent(
      content({
        quotas: [
          {
            meterKey: "platform.api_calls",
            isUnlimited: false,
            limitValue: 9007199254740992,
            unit: "requests",
            resetPolicy: "monthly",
            metadata: {}
          }
        ]
      }),
      registry
    );
    expect(errors.some((e) => e.field === "quotas[0].limitValue")).toBe(true);
  });

  test("Codex-A: a price visibility outside the enum is rejected (fail-closed)", () => {
    const errors = validateVersionContent(
      content({
        prices: [
          {
            componentKey: "base",
            amountMinor: 100,
            currency: "IDR",
            interval: "monthly",
            // Cast: simulates a request whose "internl" typo the parser passes
            // through verbatim (never coerced to "public").
            visibility: "internl" as "public",
            metadata: {}
          }
        ]
      }),
      registry
    );
    expect(errors.some((e) => e.field === "prices[0].visibility")).toBe(true);
  });

  test("E1: a present-but-non-boolean feature.enabled / trialEnabled / isUnlimited is rejected (never coerced to true)", () => {
    const enabledErr = validateVersionContent(
      content({
        features: [
          {
            featureKind: "feature",
            featureKey: "platform.api_access",
            // Cast: the parser passes a present "false" string through verbatim.
            enabled: "false" as unknown as boolean,
            metadata: {}
          }
        ]
      }),
      registry
    );
    expect(enabledErr.some((e) => e.field === "features[0].enabled")).toBe(
      true
    );

    const trialErr = validateVersionContent(
      content({ trialEnabled: "true" as unknown as boolean }),
      registry
    );
    expect(trialErr.some((e) => e.field === "trialEnabled")).toBe(true);

    const unlimitedErr = validateVersionContent(
      content({
        quotas: [
          {
            meterKey: "platform.api_calls",
            isUnlimited: "false" as unknown as boolean,
            limitValue: null,
            unit: "requests",
            resetPolicy: "none",
            metadata: {}
          }
        ]
      }),
      registry
    );
    expect(unlimitedErr.some((e) => e.field === "quotas[0].isUnlimited")).toBe(
      true
    );
  });

  test("E2: a present-but-empty interval / resetPolicy / planType is rejected (never coerced to a default)", () => {
    expect(
      validateVersionContent(
        content({
          prices: [
            {
              componentKey: "base",
              amountMinor: 100,
              currency: "IDR",
              interval: "" as PriceInterval,
              visibility: "public",
              metadata: {}
            }
          ]
        }),
        registry
      ).some((e) => e.field === "prices[0].interval")
    ).toBe(true);
    expect(
      validateVersionContent(
        content({
          quotas: [
            {
              meterKey: "platform.api_calls",
              isUnlimited: false,
              limitValue: 1,
              unit: "requests",
              resetPolicy: "" as QuotaResetPolicy,
              metadata: {}
            }
          ]
        }),
        registry
      ).some((e) => e.field === "quotas[0].resetPolicy")
    ).toBe(true);
    expect(
      validatePlanHeader("k", "Name", null, "" as PlanType).some(
        (e) => e.field === "planType"
      )
    ).toBe(true);
  });

  test("a price currency that differs from the version currency is rejected", () => {
    const errors = validateVersionContent(
      content({
        prices: [
          {
            componentKey: "base",
            amountMinor: 1000,
            currency: "USD",
            interval: "monthly",
            visibility: "public",
            metadata: {}
          }
        ]
      }),
      registry
    );
    expect(errors.some((e) => e.field === "prices[0].currency")).toBe(true);
  });

  test("unlimited quota with a non-null limitValue is rejected; unlimited with null passes", () => {
    const bad = validateVersionContent(
      content({
        quotas: [
          {
            meterKey: "platform.api_calls",
            isUnlimited: true,
            limitValue: 5,
            unit: "requests",
            resetPolicy: "none",
            metadata: {}
          }
        ]
      }),
      registry
    );
    expect(bad.some((e) => e.field === "quotas[0].limitValue")).toBe(true);

    const good = validateVersionContent(
      content({
        quotas: [
          {
            meterKey: "platform.api_calls",
            isUnlimited: true,
            limitValue: null,
            unit: "requests",
            resetPolicy: "none",
            metadata: {}
          }
        ]
      }),
      registry
    );
    expect(good).toEqual([]);
  });

  test("invalid currency and availability range are rejected", () => {
    expect(
      validateVersionContent(content({ currency: "idr" }), registry).some(
        (e) => e.field === "currency"
      )
    ).toBe(true);
    expect(
      validateVersionContent(
        content({
          availableFrom: "2026-02-01T00:00:00Z",
          availableTo: "2026-01-01T00:00:00Z"
        }),
        registry
      ).some((e) => e.field === "availableTo")
    ).toBe(true);
  });

  test("plan header validation catches bad keys and names", () => {
    expect(
      validatePlanHeader("Good_Key", "Name", null, "subscription").length
    ).toBeGreaterThan(0); // uppercase rejected
    expect(
      validatePlanHeader("good_key", "", null, "subscription").some(
        (e) => e.field === "name"
      )
    ).toBe(true);
    expect(
      validatePlanHeader("good_key", "Name", null, "subscription")
    ).toEqual([]);
  });
});

describe("lifecycle transitions", () => {
  test("only draft is editable/publishable; only published is retirable", () => {
    expect(canEditDraft("draft")).toBe(true);
    expect(canEditDraft("published")).toBe(false);
    expect(canPublish("draft")).toBe(true);
    expect(canPublish("published")).toBe(false);
    expect(canRetire("published")).toBe(true);
    expect(canRetire("draft")).toBe(false);
  });

  test("assert helpers return an error for the wrong state, null for the right one", () => {
    expect(assertPublishable("draft")).toBeNull();
    expect(assertPublishable("published")?.code).toBe("NOT_DRAFT");
    expect(assertRetirable("published")).toBeNull();
    expect(assertRetirable("draft")?.code).toBe("NOT_PUBLISHED");
  });
});

describe("offer snapshot + hash", () => {
  const snapshotContent = content({
    prices: [
      {
        componentKey: "base",
        amountMinor: 9900,
        currency: "IDR",
        interval: "monthly",
        visibility: "public",
        metadata: {}
      },
      {
        componentKey: "internal_cost",
        amountMinor: 4000,
        currency: "IDR",
        interval: "monthly",
        visibility: "internal",
        metadata: {}
      }
    ],
    features: [
      {
        featureKind: "module",
        featureKey: "blog_content",
        enabled: true,
        metadata: {}
      }
    ]
  });

  test("public projection EXCLUDES internal-visibility prices (ADR-0022 §3 Medium-1)", () => {
    const snapshot = buildOfferSnapshot(header(), snapshotContent);
    expect(snapshot.publicPrices.map((p) => p.componentKey)).toEqual(["base"]);
    expect(
      snapshot.publicPrices.some((p) => p.componentKey === "internal_cost")
    ).toBe(false);
  });

  test("hash is deterministic for identical content and independent of feature/price ordering", () => {
    const a = buildOfferSnapshot(header(), snapshotContent);
    const reordered = content({
      prices: [snapshotContent.prices[1]!, snapshotContent.prices[0]!],
      features: snapshotContent.features
    });
    const b = buildOfferSnapshot(header(), reordered);
    expect(a.offerHash).toBe(b.offerHash);
  });

  test("hash changes when content changes (reproducibility)", () => {
    const a = buildOfferSnapshot(header(), snapshotContent);
    const changed = buildOfferSnapshot(
      header(),
      content({
        currency: "USD",
        prices: [],
        features: snapshotContent.features
      })
    );
    expect(a.offerHash).not.toBe(changed.offerHash);
  });

  test("Codex-B: hash CHANGES when only a price's visibility flips (same amount/currency/interval)", () => {
    const priceInternal = content({
      prices: [
        {
          componentKey: "base",
          amountMinor: 9900,
          currency: "IDR",
          interval: "monthly",
          visibility: "internal",
          metadata: {}
        }
      ],
      features: []
    });
    const pricePublic = content({
      prices: [
        {
          componentKey: "base",
          amountMinor: 9900,
          currency: "IDR",
          interval: "monthly",
          visibility: "public",
          metadata: {}
        }
      ],
      features: []
    });
    const a = buildOfferSnapshot(header(), priceInternal);
    const b = buildOfferSnapshot(header(), pricePublic);
    // The tenant-visible offer differs (public projection now includes the price),
    // so the immutable fingerprint exposed in the publish event MUST differ.
    expect(a.publicPrices).toHaveLength(0);
    expect(b.publicPrices).toHaveLength(1);
    expect(a.offerHash).not.toBe(b.offerHash);
  });

  test("B1 (no oracle): changing an INTERNAL price's amount (staying internal) leaves offerHash AND the tenant projection unchanged", () => {
    const base = (internalAmount: number) =>
      content({
        prices: [
          {
            componentKey: "pub",
            amountMinor: 5000,
            currency: "IDR",
            interval: "monthly",
            visibility: "public",
            metadata: {}
          },
          {
            componentKey: "cost",
            amountMinor: internalAmount,
            currency: "IDR",
            interval: "monthly",
            visibility: "internal",
            metadata: {}
          }
        ],
        features: []
      });
    const a = buildOfferSnapshot(header(), base(1000));
    const b = buildOfferSnapshot(header(), base(9999999));
    // The exposed hash must NOT be an oracle for the internal amount: it is
    // independent of it, and the tenant-visible projection is byte-identical.
    expect(a.offerHash).toBe(b.offerHash);
    expect(a.publicPrices).toEqual(b.publicPrices);
    expect(a.publicPrices.map((p) => p.componentKey)).toEqual(["pub"]);
  });
});

describe("Fix 1 — offer hash covers EVERY tenant-visible projection field", () => {
  test("the declared OFFER_HASH_FIELDS equals the actual canonical hash-input keys", () => {
    expect(([...OFFER_HASH_FIELDS] as string[]).sort()).toEqual(
      offerHashInputKeys().sort()
    );
  });

  test("PROJECTION_COLUMN_TO_HASH_FIELD's non-null values equal OFFER_HASH_FIELDS (every hashed field maps back from a column)", () => {
    const mapped = Object.values(PROJECTION_COLUMN_TO_HASH_FIELD).filter(
      (v): v is string => v !== null
    );
    expect(mapped.sort()).toEqual([...OFFER_HASH_FIELDS].sort());
  });

  test("changing ANY tenant-visible header/content field changes the hash (behavioral completeness)", () => {
    const baseContent = content({
      market: "id",
      trialEnabled: true,
      trialDays: 7,
      availableFrom: "2026-01-01T00:00:00.000Z",
      availableTo: "2026-12-31T00:00:00.000Z",
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
          limitValue: 100,
          unit: "requests",
          resetPolicy: "monthly",
          metadata: {}
        }
      ],
      prices: [
        {
          componentKey: "base",
          amountMinor: 1000,
          currency: "IDR",
          interval: "monthly",
          visibility: "public",
          metadata: {}
        }
      ]
    });
    const base = buildOfferSnapshot(header(), baseContent).offerHash;

    // Header fields.
    expect(
      buildOfferSnapshot(header({ planKey: "other" }), baseContent).offerHash
    ).not.toBe(base);
    expect(
      buildOfferSnapshot(header({ planName: "Other" }), baseContent).offerHash
    ).not.toBe(base);
    expect(
      buildOfferSnapshot(header({ planType: "addon" }), baseContent).offerHash
    ).not.toBe(base);
    expect(
      buildOfferSnapshot(header({ version: 2 }), baseContent).offerHash
    ).not.toBe(base);

    // Content fields.
    const mut = (o: Partial<VersionContentInput>) =>
      buildOfferSnapshot(header(), { ...baseContent, ...o }).offerHash;
    expect(mut({ currency: "USD" })).not.toBe(base);
    expect(mut({ market: "us" })).not.toBe(base);
    expect(mut({ trialEnabled: false })).not.toBe(base);
    expect(mut({ trialDays: 14 })).not.toBe(base);
    expect(mut({ availableFrom: "2026-02-01T00:00:00.000Z" })).not.toBe(base);
    expect(mut({ availableTo: "2026-11-30T00:00:00.000Z" })).not.toBe(base);
    expect(mut({ features: [] })).not.toBe(base);
    expect(mut({ quotas: [] })).not.toBe(base);
    expect(
      mut({
        prices: [
          {
            componentKey: "base",
            amountMinor: 2000,
            currency: "IDR",
            interval: "monthly",
            visibility: "public",
            metadata: {}
          }
        ]
      })
    ).not.toBe(base);
  });
});

describe("Fix 2 — fail-closed collections/objects (present-malformed rejected, never wiped)", () => {
  test("a present-but-non-array features/quotas/prices is rejected (never iterated or treated as [])", () => {
    expect(
      validateVersionContent(
        content({ features: { bad: true } as unknown as [] }),
        registry
      ).some((e) => e.field === "features")
    ).toBe(true);
    expect(
      validateVersionContent(
        content({ quotas: "nope" as unknown as [] }),
        registry
      ).some((e) => e.field === "quotas")
    ).toBe(true);
    expect(
      validateVersionContent(
        content({ prices: 42 as unknown as [] }),
        registry
      ).some((e) => e.field === "prices")
    ).toBe(true);
  });

  test("a present-but-non-object metadata is rejected", () => {
    expect(
      validateVersionContent(
        content({
          prices: [
            {
              componentKey: "base",
              amountMinor: 1,
              currency: "IDR",
              interval: "monthly",
              visibility: "public",
              metadata: [1, 2] as unknown as Record<string, unknown>
            }
          ]
        }),
        registry
      ).some((e) => e.field === "prices[0].metadata")
    ).toBe(true);
  });
});

describe("Fix 1 — nullable tri-state (absent=keep, null=clear, present-wrong-type=400)", () => {
  test("content.market: present non-string rejected; explicit null accepted", () => {
    expect(
      validateVersionContent(
        content({ market: 123 as unknown as string }),
        registry
      ).some((e) => e.field === "market")
    ).toBe(true);
    expect(
      validateVersionContent(content({ market: null }), registry).some(
        (e) => e.field === "market"
      )
    ).toBe(false);
  });

  test("content.availableFrom / availableTo: present non-string rejected; null accepted", () => {
    expect(
      validateVersionContent(
        content({ availableFrom: 123 as unknown as string }),
        registry
      ).some((e) => e.field === "availableFrom")
    ).toBe(true);
    expect(
      validateVersionContent(
        content({ availableTo: 123 as unknown as string }),
        registry
      ).some((e) => e.field === "availableTo")
    ).toBe(true);
    expect(
      validateVersionContent(
        content({ availableFrom: null, availableTo: null }),
        registry
      ).some((e) => e.field.startsWith("available"))
    ).toBe(false);
  });

  test("content.notes: present non-string rejected; null accepted", () => {
    expect(
      validateVersionContent(
        content({ notes: 5 as unknown as string }),
        registry
      ).some((e) => e.field === "notes")
    ).toBe(true);
    expect(
      validateVersionContent(content({ notes: null }), registry).some(
        (e) => e.field === "notes"
      )
    ).toBe(false);
  });

  test("content.trialDays: present non-number rejected; null accepted", () => {
    expect(
      validateVersionContent(
        content({ trialDays: "7" as unknown as number }),
        registry
      ).some((e) => e.field === "trialDays")
    ).toBe(true);
    expect(
      validateVersionContent(content({ trialDays: null }), registry).some(
        (e) => e.field === "trialDays"
      )
    ).toBe(false);
  });

  test("plan header description: present non-string rejected; null accepted", () => {
    expect(
      validatePlanHeader(
        "k",
        "Name",
        123 as unknown as string,
        "subscription"
      ).some((e) => e.field === "description")
    ).toBe(true);
    expect(
      validatePlanHeader("k", "Name", null, "subscription").some(
        (e) => e.field === "description"
      )
    ).toBe(false);
  });

  test("parser keeps a present wrong-type nullable VERBATIM (never coerced to null = silent clear); absent -> null; explicit null -> null", () => {
    // present wrong-type kept verbatim so the validator rejects it.
    expect(
      parseVersionContent({ currency: "IDR", availableTo: 123 })
        .availableTo as unknown
    ).toBe(123);
    // absent -> null default.
    expect(parseVersionContent({ currency: "IDR" }).availableTo).toBeNull();
    // explicit null -> null (clear).
    expect(
      parseVersionContent({ currency: "IDR", availableTo: null }).availableTo
    ).toBeNull();
  });
});

describe("request parsing — fail-closed enums (Issue #870 review Codex-A)", () => {
  test("parsePrice passes a present-but-invalid visibility through verbatim (not coerced to public)", () => {
    const parsed = parsePrice({
      componentKey: "base",
      amountMinor: 100,
      currency: "IDR",
      visibility: "internl"
    });
    // Verbatim — so the domain validator rejects it, instead of silently
    // treating an intended-internal price as public.
    expect(parsed.visibility as string).toBe("internl");
  });

  test("parsePrice defaults visibility to public ONLY when the field is absent", () => {
    const parsed = parsePrice({
      componentKey: "base",
      amountMinor: 100,
      currency: "IDR"
    });
    expect(parsed.visibility).toBe("public");
  });

  test("parseFeatureGrant passes a present-but-invalid featureKind through verbatim", () => {
    const parsed = parseFeatureGrant({
      featureKind: "moddule",
      featureKey: "blog_content"
    });
    expect(parsed.featureKind as string).toBe("moddule");
  });

  test("E1: parseFeatureGrant passes a present non-boolean enabled through verbatim (not coerced to true); absent defaults to true", () => {
    expect(
      parseFeatureGrant({ featureKey: "x", enabled: "false" })
        .enabled as unknown
    ).toBe("false");
    expect(parseFeatureGrant({ featureKey: "x" }).enabled).toBe(true);
  });

  test("E1: parseQuota passes a present non-boolean isUnlimited through verbatim", () => {
    expect(
      parseQuota({ meterKey: "m", isUnlimited: 0 }).isUnlimited as unknown
    ).toBe(0);
  });

  test("E2: parsePrice keeps a present empty interval (rejected downstream); absent defaults to one_time", () => {
    expect(
      parsePrice({ componentKey: "b", interval: "" }).interval as string
    ).toBe("");
    expect(parsePrice({ componentKey: "b" }).interval).toBe("one_time");
  });

  test("Fix 2: parseVersionContent keeps a present non-array collection verbatim (NOT coerced to []); absent -> []", () => {
    const malformed = parseVersionContent({
      currency: "IDR",
      prices: { not: "an array" }
    });
    // Verbatim — so the validator rejects it, instead of a silent [] that would
    // delete existing rows in the PATCH path.
    expect(Array.isArray(malformed.prices)).toBe(false);
    // Absent -> [] default (no wipe signal).
    expect(parseVersionContent({ currency: "IDR" }).prices).toEqual([]);
  });
});

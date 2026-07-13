import { describe, expect, test } from "bun:test";

import {
  hashIdentifier,
  maskIdentifier,
  normalizeIdentifier
} from "../src/modules/profile-identity/domain/identifier";
import {
  assertMergeRequestIsValid,
  assertSameTenant,
  computeFieldConflicts,
  computeRequiresApproval,
  CrossTenantMergeError,
  validateCreateMergeRequestInput,
  validateMergeDecisionInput
} from "../src/modules/profile-identity/domain/merge";
import {
  validateCreatePartyInput,
  validateUpdatePartyInput
} from "../src/modules/profile-identity/domain/party-validation";
import {
  validateCreateIdentifierInput,
  validateUpdateIdentifierInput
} from "../src/modules/profile-identity/domain/identifier-lifecycle";
import {
  validateCreateAddressInput,
  validateCreateChannelInput
} from "../src/modules/profile-identity/domain/address-channel-validation";
import {
  normalizeRelationshipType,
  validateCreateRelationshipInput,
  validateRelationshipType
} from "../src/modules/profile-identity/domain/relationship";
import {
  buildIdentifierMatchReason,
  combineMatchBasis,
  evaluateNameSimilarityMatch,
  nameSimilarityScore,
  orderProfilePair
} from "../src/modules/profile-identity/domain/duplicate-detection";
import {
  PARTY_FULL_DTO_FIELDS,
  PARTY_MASKED_ADMIN_DTO_FIELDS,
  PARTY_PUBLIC_SAFE_DTO_FIELDS,
  toPartyFullDTO,
  toPartyMaskedAdminDTO,
  toPartyPublicSafeDTO,
  type PartyRecordForProjection
} from "../src/modules/profile-identity/domain/projection";

describe("identifier normalization", () => {
  test("email is trimmed and lowercased", () => {
    expect(normalizeIdentifier("email", "  John.Doe@Example.COM ")).toBe(
      "john.doe@example.com"
    );
  });

  test("phone/whatsapp strip formatting but keep a leading +", () => {
    expect(normalizeIdentifier("phone", "0812-3456-7890")).toBe("081234567890");
    expect(normalizeIdentifier("whatsapp", "+62 812 (3456) 7890")).toBe(
      "+6281234567890"
    );
  });

  test("national_id/tax_id/external_code/other are trimmed only, case preserved", () => {
    expect(normalizeIdentifier("national_id", "  ABC-123  ")).toBe("ABC-123");
    expect(normalizeIdentifier("tax_id", "  Tax-001  ")).toBe("Tax-001");
  });
});

describe("identifier hashing", () => {
  test("is stable, prefixed, and sensitive to the input value", () => {
    const a = hashIdentifier("john.doe@example.com");
    const b = hashIdentifier("john.doe@example.com");
    const c = hashIdentifier("jane.doe@example.com");

    expect(a).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("identifier masking", () => {
  test("email keeps the first local-part character and the full domain", () => {
    expect(maskIdentifier("email", "john.doe@example.com")).toBe(
      "j*******@example.com"
    );
  });

  test("email with no local part before @ falls back to tail masking", () => {
    expect(maskIdentifier("email", "@example.com")).toBe("********.com");
  });

  test("phone/whatsapp/other keep only the last 4 characters", () => {
    expect(maskIdentifier("phone", "+6281234567890")).toBe("**********7890");
    expect(maskIdentifier("national_id", "ABC")).toBe("***");
  });
});

describe("merge request validation", () => {
  test("rejects a merge request where source equals target", () => {
    expect(() =>
      assertMergeRequestIsValid({
        sourceProfileId: "11111111-1111-1111-1111-111111111111",
        targetProfileId: "11111111-1111-1111-1111-111111111111"
      })
    ).toThrow("must not be the same profile");
  });

  test("accepts a merge request with distinct source and target", () => {
    expect(() =>
      assertMergeRequestIsValid({
        sourceProfileId: "11111111-1111-1111-1111-111111111111",
        targetProfileId: "22222222-2222-2222-2222-222222222222"
      })
    ).not.toThrow();
  });
});

describe("party validation (Issue #748)", () => {
  test("create requires profileType/displayName, defaults riskLevel to normal", () => {
    const result = validateCreatePartyInput({
      profileType: "person",
      displayName: "Jane Doe"
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.riskLevel).toBe("normal");
      expect(result.value.legalName).toBeNull();
    }
  });

  test("create rejects an invalid profileType", () => {
    const result = validateCreatePartyInput({
      profileType: "company",
      displayName: "X"
    });
    expect(result.valid).toBe(false);
  });

  test("update rejects status: merged (only merge execution may set it)", () => {
    const result = validateUpdatePartyInput({ status: "merged" });
    expect(result.valid).toBe(false);
  });

  test("update requires at least one field", () => {
    const result = validateUpdatePartyInput({});
    expect(result.valid).toBe(false);
  });

  test("update accepts status: active/inactive", () => {
    expect(validateUpdatePartyInput({ status: "inactive" }).valid).toBe(true);
  });
});

describe("identifier lifecycle validation (Issue #748)", () => {
  test("create requires identifierType/value, defaults provenance to self_reported", () => {
    const result = validateCreateIdentifierInput({
      identifierType: "email",
      value: "a@example.com"
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.provenance).toBe("self_reported");
    }
  });

  test("create rejects validUntil before validFrom", () => {
    const result = validateCreateIdentifierInput({
      identifierType: "email",
      value: "a@example.com",
      validFrom: "2026-01-02T00:00:00.000Z",
      validUntil: "2026-01-01T00:00:00.000Z"
    });
    expect(result.valid).toBe(false);
  });

  test("update requires at least one field", () => {
    expect(validateUpdateIdentifierInput({}).valid).toBe(false);
  });

  test("update accepts a verification status transition", () => {
    const result = validateUpdateIdentifierInput({
      verificationStatus: "verified"
    });
    expect(result.valid).toBe(true);
  });
});

describe("address/channel validation (Issue #748)", () => {
  test("address defaults countryCode to ID and addressType to primary", () => {
    const result = validateCreateAddressInput({});
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.countryCode).toBe("ID");
      expect(result.value.addressType).toBe("primary");
    }
  });

  test("channel requires a valid profileIdentifierId", () => {
    const result = validateCreateChannelInput({ channelType: "email" });
    expect(result.valid).toBe(false);
  });

  test("channel accepts a well-formed identifier id", () => {
    const result = validateCreateChannelInput({
      profileIdentifierId: "11111111-1111-1111-1111-111111111111",
      channelType: "email"
    });
    expect(result.valid).toBe(true);
  });
});

describe("relationship type validation — generic, no hardcoded business roles (Issue #748)", () => {
  test("normalizes to snake_case", () => {
    expect(normalizeRelationshipType("Related Party!")).toBe("related_party");
  });

  test("accepts a generic structural relationship type", () => {
    const result = validateRelationshipType("related_party");
    expect(result.valid).toBe(true);
  });

  test("rejects hardcoded business-domain role words", () => {
    for (const word of ["customer", "supplier", "employee", "donor"]) {
      const result = validateRelationshipType(word);
      expect(result.valid).toBe(false);
    }
  });

  test("full input validation rejects toProfileId equal to fromProfileId", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    const result = validateCreateRelationshipInput(
      { toProfileId: id, relationshipType: "related_party" },
      id
    );
    expect(result.valid).toBe(false);
  });

  test("full input validation accepts an authorized-representative record", () => {
    const result = validateCreateRelationshipInput(
      {
        toProfileId: "22222222-2222-2222-2222-222222222222",
        relationshipType: "authorized_representative",
        isAuthorizedRepresentative: true,
        representationScope: "sign contracts up to 50,000,000 IDR"
      },
      "11111111-1111-1111-1111-111111111111"
    );
    expect(result.valid).toBe(true);
  });
});

describe("duplicate detection heuristics (Issue #748)", () => {
  test("identical names score 1", () => {
    expect(nameSimilarityScore("Jane Doe", "Jane Doe")).toBe(1);
  });

  test("very different names score low", () => {
    expect(nameSimilarityScore("Jane Doe", "Zzyzx Qwerty")).toBeLessThan(0.3);
  });

  test("evaluateNameSimilarityMatch is null below threshold, explainable above it", () => {
    expect(evaluateNameSimilarityMatch("Jane Doe", "Zzyzx Qwerty")).toBeNull();
    const match = evaluateNameSimilarityMatch("Jane Doe", "Jane Doe");
    expect(match).not.toBeNull();
    expect(match?.reasons.length).toBeGreaterThan(0);
    expect(match?.reasons[0]?.reason).toBe("name_similarity");
  });

  test("buildIdentifierMatchReason never includes the raw identifier value", () => {
    const match = buildIdentifierMatchReason("email");
    expect(match.score).toBe(1);
    expect(JSON.stringify(match)).not.toContain("@");
  });

  test("combineMatchBasis picks heuristic_combined only when both bases match", () => {
    expect(combineMatchBasis(true, true)).toBe("heuristic_combined");
    expect(combineMatchBasis(true, false)).toBe("deterministic_identifier");
    expect(combineMatchBasis(false, true)).toBe("heuristic_name_similarity");
  });

  test("orderProfilePair is stable regardless of input order", () => {
    const a = "11111111-1111-1111-1111-111111111111";
    const c = "22222222-2222-2222-2222-222222222222";
    expect(orderProfilePair(a, c)).toEqual({ profileIdA: a, profileIdB: c });
    expect(orderProfilePair(c, a)).toEqual({ profileIdA: a, profileIdB: c });
  });
});

describe("merge domain logic (Issue #748)", () => {
  test("computeRequiresApproval is always true — every merge in this base requires approval", () => {
    expect(computeRequiresApproval()).toBe(true);
  });

  test("computeFieldConflicts surfaces only differing fields", () => {
    const source = {
      id: "a",
      profileType: "person",
      displayName: "Jane Doe",
      legalName: null,
      riskLevel: "normal",
      verificationStatus: "unverified"
    };
    const target = { ...source, id: "b", displayName: "Jane D." };

    const conflicts = computeFieldConflicts(source, target);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.field).toBe("displayName");
  });

  test("computeFieldConflicts is empty when every comparable field matches", () => {
    const snapshot = {
      id: "a",
      profileType: "person",
      displayName: "Jane Doe",
      legalName: null,
      riskLevel: "normal",
      verificationStatus: "unverified"
    };
    expect(computeFieldConflicts(snapshot, { ...snapshot, id: "b" })).toEqual(
      []
    );
  });

  test("assertSameTenant throws CrossTenantMergeError for a mismatched tenant id", () => {
    expect(() => assertSameTenant("tenant-a", "tenant-a")).not.toThrow();
    expect(() => assertSameTenant("tenant-a", "tenant-a", "tenant-b")).toThrow(
      CrossTenantMergeError
    );
  });

  test("validateCreateMergeRequestInput rejects equal source/target and requires a reason", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    expect(
      validateCreateMergeRequestInput({
        sourceProfileId: id,
        targetProfileId: id,
        reason: "x"
      }).valid
    ).toBe(false);
    expect(
      validateCreateMergeRequestInput({
        sourceProfileId: id,
        targetProfileId: "22222222-2222-2222-2222-222222222222"
      }).valid
    ).toBe(false);
  });

  test("validateMergeDecisionInput only accepts approved/rejected", () => {
    expect(validateMergeDecisionInput({ decision: "approved" }).valid).toBe(
      true
    );
    expect(validateMergeDecisionInput({ decision: "maybe" }).valid).toBe(false);
  });
});

describe("party projections — explicit allow-lists (Issue #748)", () => {
  const record: PartyRecordForProjection = {
    id: "11111111-1111-1111-1111-111111111111",
    tenantId: "22222222-2222-2222-2222-222222222222",
    profileType: "person",
    displayName: "Jane Doe",
    legalName: "Jane Legal Doe",
    status: "active",
    verificationStatus: "verified",
    riskLevel: "normal",
    mergedIntoProfileId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    createdBy: "33333333-3333-3333-3333-333333333333",
    updatedBy: "33333333-3333-3333-3333-333333333333",
    deletedAt: null,
    deletedBy: null,
    deleteReason: null,
    restoredAt: null,
    restoredBy: null
  };

  test("full DTO only ever contains its own declared allow-list keys", () => {
    const dto = toPartyFullDTO(record);
    expect(Object.keys(dto).sort()).toEqual([...PARTY_FULL_DTO_FIELDS].sort());
  });

  test("masked-admin DTO excludes tenantId and actor ids", () => {
    const dto = toPartyMaskedAdminDTO(record);
    expect(Object.keys(dto).sort()).toEqual(
      [...PARTY_MASKED_ADMIN_DTO_FIELDS].sort()
    );
    expect(dto).not.toHaveProperty("tenantId");
    expect(dto).not.toHaveProperty("createdBy");
    expect(dto).not.toHaveProperty("updatedBy");
  });

  test("public-safe DTO is an explicit 3-field allow-list for an active profile", () => {
    const dto = toPartyPublicSafeDTO(record);
    expect(dto).not.toBeNull();
    expect(Object.keys(dto!).sort()).toEqual(
      [...PARTY_PUBLIC_SAFE_DTO_FIELDS].sort()
    );
    expect(dto).not.toHaveProperty("verificationStatus");
    expect(dto).not.toHaveProperty("riskLevel");
    expect(dto).not.toHaveProperty("legalName");
  });

  test("public-safe DTO is null for a soft-deleted, merged, or inactive profile", () => {
    expect(
      toPartyPublicSafeDTO({ ...record, deletedAt: new Date() })
    ).toBeNull();
    expect(
      toPartyPublicSafeDTO({
        ...record,
        mergedIntoProfileId: "44444444-4444-4444-4444-444444444444"
      })
    ).toBeNull();
    expect(toPartyPublicSafeDTO({ ...record, status: "inactive" })).toBeNull();
  });
});

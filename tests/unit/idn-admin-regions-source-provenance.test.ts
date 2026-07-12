import { describe, expect, test } from "bun:test";

import {
  IDN_ADMIN_REGIONS_OFFICIAL_REFERENCE_CAVEAT,
  IDN_ADMIN_REGIONS_SOURCE_LICENSE,
  IDN_ADMIN_REGIONS_SOURCE_PATH,
  IDN_ADMIN_REGIONS_SOURCE_REPOSITORY,
  IDN_ADMIN_REGIONS_UPSTREAM_STATEMENT
} from "../../src/modules/idn-admin-regions/domain/source-provenance";

describe("idn_admin_regions source provenance constants (Issue #655)", () => {
  test("repository points at the exact upstream project", () => {
    expect(IDN_ADMIN_REGIONS_SOURCE_REPOSITORY).toBe(
      "https://github.com/cahyadsn/wilayah"
    );
  });

  test("source path points at the db/ folder", () => {
    expect(IDN_ADMIN_REGIONS_SOURCE_PATH).toBe(
      "https://github.com/cahyadsn/wilayah/tree/master/db"
    );
    expect(
      IDN_ADMIN_REGIONS_SOURCE_PATH.startsWith(
        IDN_ADMIN_REGIONS_SOURCE_REPOSITORY
      )
    ).toBe(true);
  });

  test("license is MIT", () => {
    expect(IDN_ADMIN_REGIONS_SOURCE_LICENSE).toBe("MIT");
  });

  test("upstream statement mentions the Kepmendagri decree", () => {
    expect(IDN_ADMIN_REGIONS_UPSTREAM_STATEMENT).toContain(
      "Kepmendagri No. 300.2.2-2430 Tahun 2025"
    );
  });

  test("official-reference caveat plainly states this is third-party, not an official Kemendagri feed", () => {
    expect(IDN_ADMIN_REGIONS_OFFICIAL_REFERENCE_CAVEAT.toLowerCase()).toContain(
      "third-party"
    );
    expect(IDN_ADMIN_REGIONS_OFFICIAL_REFERENCE_CAVEAT).toContain("Kemendagri");
    expect(IDN_ADMIN_REGIONS_OFFICIAL_REFERENCE_CAVEAT.toLowerCase()).toContain(
      "not an official"
    );
  });
});

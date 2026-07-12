/**
 * Trusted, code-only source provenance metadata for the `idn_admin_regions`
 * module (Issue #655, epic #654). A single source of truth for the
 * upstream dataset's identity — later issues (#656 vendoring, #660
 * import, #664 docs) should import these constants rather than
 * re-typing the repository URL/license/official-reference caveat in
 * multiple places, so they can never drift out of sync with each other.
 *
 * This is deliberately NOT the dataset metadata that will eventually live
 * in `awcms_mini_idn_region_datasets` (Issue #657, per-imported-dataset:
 * commit SHA, file checksum, row count, etc.) — that is per-import runtime
 * data. This file is static, repo-committed, code-level metadata about
 * WHICH upstream project AWCMS-Mini vendors from, true for every import
 * regardless of which commit/version was imported.
 */

/** Upstream GitHub repository this module's dataset is sourced from. */
export const IDN_ADMIN_REGIONS_SOURCE_REPOSITORY =
  "https://github.com/cahyadsn/wilayah";

/** Upstream folder within the repository containing the SQL dataset dumps. */
export const IDN_ADMIN_REGIONS_SOURCE_PATH =
  "https://github.com/cahyadsn/wilayah/tree/master/db";

/** Upstream repository's license — must be preserved verbatim when vendoring (Issue #656). */
export const IDN_ADMIN_REGIONS_SOURCE_LICENSE = "MIT";

/**
 * Upstream's own statement of what the dataset represents. Recorded
 * verbatim (not paraphrased) so downstream consumers can quote it
 * directly instead of re-deriving their own summary.
 */
export const IDN_ADMIN_REGIONS_UPSTREAM_STATEMENT =
  "Kode dan Data Wilayah Administrasi Pemerintahan dan Kode Pulau Indonesia sesuai Kepmendagri No. 300.2.2-2430 Tahun 2025.";

/**
 * Official-reference caveat — MUST be surfaced wherever this dataset is
 * presented to an operator/admin (README, admin UI dataset detail per
 * Issue #663, docs per Issue #664). This is a third-party community
 * packaging of the upstream statement above, not a direct/official feed
 * from Kementerian Dalam Negeri (Kemendagri) itself — AWCMS-Mini never
 * claims to be the official publisher of this data, and this dataset does
 * not replace an operator's own legal/compliance reference to the actual
 * Kemendagri decree when that matters.
 */
export const IDN_ADMIN_REGIONS_OFFICIAL_REFERENCE_CAVEAT =
  "This dataset is a third-party, community-packaged copy of Indonesia administrative region data (cahyadsn/wilayah, MIT License), not an official Kementerian Dalam Negeri (Kemendagri) API or export. It should not be treated as a substitute for an operator's own official legal/compliance reference.";

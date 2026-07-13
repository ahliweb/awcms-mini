/**
 * Party projection contracts (Issue #748). Three explicit shapes, each an
 * ALLOW-LIST (never a blocklist of what to hide) so a new internal field
 * added later does not silently leak into a narrower projection just
 * because nobody remembered to blocklist it — `tests/unit/profile-
 * identity-projection.test.ts` asserts each projector's output keys are a
 * subset of its own allow-list.
 *
 * - `PartyFullDTO` — internal use only (never serialized directly to a
 *   public/unauthenticated caller): every column this base persists on
 *   `awcms_mini_profiles`, including tenant id and soft-delete/merge
 *   lineage fields. Returned by the detail endpoint only to a caller with
 *   `profile_management.read` (any authenticated tenant user with that
 *   permission — this base does not have a narrower "full" permission
 *   tier beyond ordinary read today).
 * - `PartyMaskedAdminDTO` — the shape actually returned by the admin
 *   list/detail API: everything in `PartyFullDTO` except `tenantId` (the
 *   caller already knows their own tenant from the request context; this
 *   base does not need every DTO to re-assert it) and the raw
 *   `deletedBy`/`restoredBy`/`createdBy`/`updatedBy` actor ids (audit
 *   trail detail — available via `GET /api/v1/logs/audit`, not the
 *   party record itself).
 * - `PartyPublicSafeDTO` — an explicit allow-list of the ONLY fields a
 *   future public-facing consumer (e.g. an author byline on a public blog
 *   post, a future capability-port consumer) may ever see: `id`,
 *   `profileType`, `displayName`. No status/verification/risk/lineage
 *   field, ever — those are administrative signals, not public-safe
 *   content. A merged-away (loser) or soft-deleted profile is never
 *   projected publicly at all (`toPartyPublicSafeDTO` returns `null`).
 */
export type PartyRecordForProjection = {
  id: string;
  tenantId: string;
  profileType: string;
  displayName: string;
  legalName: string | null;
  status: string;
  verificationStatus: string;
  riskLevel: string;
  mergedIntoProfileId: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
  updatedBy: string | null;
  deletedAt: Date | null;
  deletedBy: string | null;
  deleteReason: string | null;
  restoredAt: Date | null;
  restoredBy: string | null;
};

export type PartyFullDTO = {
  id: string;
  tenantId: string;
  profileType: string;
  displayName: string;
  legalName: string | null;
  status: string;
  verificationStatus: string;
  riskLevel: string;
  mergedIntoProfileId: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
  deletedAt: string | null;
  deletedBy: string | null;
  deleteReason: string | null;
  restoredAt: string | null;
  restoredBy: string | null;
};

export const PARTY_FULL_DTO_FIELDS: readonly (keyof PartyFullDTO)[] = [
  "id",
  "tenantId",
  "profileType",
  "displayName",
  "legalName",
  "status",
  "verificationStatus",
  "riskLevel",
  "mergedIntoProfileId",
  "createdAt",
  "updatedAt",
  "createdBy",
  "updatedBy",
  "deletedAt",
  "deletedBy",
  "deleteReason",
  "restoredAt",
  "restoredBy"
];

export function toPartyFullDTO(record: PartyRecordForProjection): PartyFullDTO {
  return {
    id: record.id,
    tenantId: record.tenantId,
    profileType: record.profileType,
    displayName: record.displayName,
    legalName: record.legalName,
    status: record.status,
    verificationStatus: record.verificationStatus,
    riskLevel: record.riskLevel,
    mergedIntoProfileId: record.mergedIntoProfileId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    createdBy: record.createdBy,
    updatedBy: record.updatedBy,
    deletedAt: record.deletedAt ? record.deletedAt.toISOString() : null,
    deletedBy: record.deletedBy,
    deleteReason: record.deleteReason,
    restoredAt: record.restoredAt ? record.restoredAt.toISOString() : null,
    restoredBy: record.restoredBy
  };
}

export type PartyMaskedAdminDTO = {
  id: string;
  profileType: string;
  displayName: string;
  legalName: string | null;
  status: string;
  verificationStatus: string;
  riskLevel: string;
  mergedIntoProfileId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  deleteReason: string | null;
  restoredAt: string | null;
};

export const PARTY_MASKED_ADMIN_DTO_FIELDS: readonly (keyof PartyMaskedAdminDTO)[] =
  [
    "id",
    "profileType",
    "displayName",
    "legalName",
    "status",
    "verificationStatus",
    "riskLevel",
    "mergedIntoProfileId",
    "createdAt",
    "updatedAt",
    "deletedAt",
    "deleteReason",
    "restoredAt"
  ];

export function toPartyMaskedAdminDTO(
  record: PartyRecordForProjection
): PartyMaskedAdminDTO {
  return {
    id: record.id,
    profileType: record.profileType,
    displayName: record.displayName,
    legalName: record.legalName,
    status: record.status,
    verificationStatus: record.verificationStatus,
    riskLevel: record.riskLevel,
    mergedIntoProfileId: record.mergedIntoProfileId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    deletedAt: record.deletedAt ? record.deletedAt.toISOString() : null,
    deleteReason: record.deleteReason,
    restoredAt: record.restoredAt ? record.restoredAt.toISOString() : null
  };
}

export type PartyPublicSafeDTO = {
  id: string;
  profileType: string;
  displayName: string;
};

export const PARTY_PUBLIC_SAFE_DTO_FIELDS: readonly (keyof PartyPublicSafeDTO)[] =
  ["id", "profileType", "displayName"];

/** `null` for a soft-deleted, merged-away, or `inactive` profile — public-safe projection only ever shows a live, active party. */
export function toPartyPublicSafeDTO(
  record: PartyRecordForProjection
): PartyPublicSafeDTO | null {
  if (
    record.deletedAt !== null ||
    record.mergedIntoProfileId !== null ||
    record.status !== "active"
  ) {
    return null;
  }

  return {
    id: record.id,
    profileType: record.profileType,
    displayName: record.displayName
  };
}

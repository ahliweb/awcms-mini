import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  hashIdentifier,
  maskIdentifier,
  normalizeIdentifier
} from "../domain/identifier";
import type { CreateIdentifierInput } from "../domain/identifier-lifecycle";

const AUDIT_MODULE_KEY = "profile_identity";
const AUDIT_RESOURCE_TYPE = "profile_identifier";

/**
 * The ONLY shape this module ever returns via API/admin UI — `masked_value`
 * only, never the raw normalized value (Issue #748: "sensitive identifiers
 * ... masked in responses/logs; raw values are returned only with explicit
 * permission and necessity"). This issue does not add a raw-reveal
 * endpoint/permission (matches the pre-existing, never-wired
 * `identifier_masked_reveal` audit action already declared on
 * `awcms_mini_profile_audit_logs` back in migration 003 — a distinct
 * "reveal" capability remains a deliberately separate, not-yet-built
 * feature, not silently reintroduced here).
 */
export type IdentifierView = {
  id: string;
  profileId: string;
  identifierType: string;
  maskedValue: string;
  isPrimary: boolean;
  provenance: string;
  verificationStatus: string;
  verifiedAt: string | null;
  validFrom: string;
  validUntil: string | null;
  createdAt: string;
  updatedAt: string;
};

type IdentifierRow = {
  id: string;
  profile_id: string;
  identifier_type: string;
  masked_value: string;
  is_primary: boolean;
  provenance: string;
  verification_status: string;
  verified_at: Date | null;
  valid_from: Date;
  valid_until: Date | null;
  created_at: Date;
  updated_at: Date;
};

function toView(row: IdentifierRow): IdentifierView {
  return {
    id: row.id,
    profileId: row.profile_id,
    identifierType: row.identifier_type,
    maskedValue: row.masked_value,
    isPrimary: row.is_primary,
    provenance: row.provenance,
    verificationStatus: row.verification_status,
    verifiedAt: row.verified_at ? row.verified_at.toISOString() : null,
    validFrom: row.valid_from.toISOString(),
    validUntil: row.valid_until ? row.valid_until.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

export class DuplicateIdentifierError extends Error {
  constructor() {
    super(
      "An active identifier of this type with the same value already exists for this tenant."
    );
    this.name = "DuplicateIdentifierError";
  }
}

const POSTGRES_UNIQUE_VIOLATION = "23505";

export async function createIdentifier(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  profileId: string,
  input: CreateIdentifierInput,
  correlationId?: string
): Promise<IdentifierView> {
  const normalizedValue = normalizeIdentifier(
    input.identifierType,
    input.rawValue
  );
  const valueHash = hashIdentifier(normalizedValue);
  const maskedValue = maskIdentifier(input.identifierType, normalizedValue);

  let rows: IdentifierRow[];

  try {
    rows = (await tx`
      INSERT INTO awcms_mini_profile_identifiers
        (tenant_id, profile_id, identifier_type, normalized_value, value_hash,
         masked_value, is_primary, provenance, valid_from, valid_until)
      VALUES (
        ${tenantId}, ${profileId}, ${input.identifierType}, ${normalizedValue}, ${valueHash},
        ${maskedValue}, ${input.isPrimary}, ${input.provenance}, ${input.validFrom}, ${input.validUntil}
      )
      RETURNING id, profile_id, identifier_type, masked_value, is_primary, provenance,
        verification_status, verified_at, valid_from, valid_until, created_at, updated_at
    `) as IdentifierRow[];
  } catch (error) {
    if (
      error instanceof Bun.SQL.PostgresError &&
      String(error.errno) === POSTGRES_UNIQUE_VIOLATION
    ) {
      throw new DuplicateIdentifierError();
    }

    throw error;
  }

  const view = toView(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "identifier_added",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: view.id,
    severity: "info",
    message: `Identifier added: ${view.identifierType}.`,
    attributes: {
      identifierType: view.identifierType,
      maskedValue: view.maskedValue
    },
    correlationId
  });

  return view;
}

export async function listIdentifiers(
  tx: Bun.SQL,
  tenantId: string,
  profileId: string
): Promise<IdentifierView[]> {
  const rows = (await tx`
    SELECT id, profile_id, identifier_type, masked_value, is_primary, provenance,
      verification_status, verified_at, valid_from, valid_until, created_at, updated_at
    FROM awcms_mini_profile_identifiers
    WHERE tenant_id = ${tenantId} AND profile_id = ${profileId} AND deleted_at IS NULL
    ORDER BY created_at DESC
  `) as IdentifierRow[];

  return rows.map(toView);
}

export type UpdateIdentifierFields = {
  isPrimary?: boolean;
  verificationStatus?: "unverified" | "pending" | "verified";
  validUntil?: Date | null;
};

export async function updateIdentifier(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  profileId: string,
  identifierId: string,
  input: UpdateIdentifierFields,
  correlationId?: string
): Promise<IdentifierView | null> {
  const existingRows = (await tx`
    SELECT id, profile_id, identifier_type, masked_value, is_primary, provenance,
      verification_status, verified_at, valid_from, valid_until, created_at, updated_at
    FROM awcms_mini_profile_identifiers
    WHERE tenant_id = ${tenantId} AND profile_id = ${profileId} AND id = ${identifierId}
      AND deleted_at IS NULL
  `) as IdentifierRow[];

  const existing = existingRows[0];

  if (!existing) {
    return null;
  }

  const verificationStatus =
    input.verificationStatus ?? existing.verification_status;
  const verifiedAt =
    input.verificationStatus === "verified" ? new Date() : existing.verified_at;
  const verifiedBy =
    input.verificationStatus === "verified" ? actorTenantUserId : null;

  const rows = (await tx`
    UPDATE awcms_mini_profile_identifiers
    SET
      is_primary = ${input.isPrimary ?? existing.is_primary},
      verification_status = ${verificationStatus},
      verified_at = ${verifiedAt},
      verified_by = ${verifiedBy},
      valid_until = ${input.validUntil !== undefined ? input.validUntil : existing.valid_until},
      updated_at = now()
    WHERE tenant_id = ${tenantId} AND profile_id = ${profileId} AND id = ${identifierId}
      AND deleted_at IS NULL
    RETURNING id, profile_id, identifier_type, masked_value, is_primary, provenance,
      verification_status, verified_at, valid_from, valid_until, created_at, updated_at
  `) as IdentifierRow[];

  const view = toView(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "identifier_updated",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: view.id,
    severity: "info",
    message: "Identifier updated.",
    attributes: { fields: Object.keys(input) },
    correlationId
  });

  return view;
}

export async function softDeleteIdentifier(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  profileId: string,
  identifierId: string,
  reason: string,
  correlationId?: string
): Promise<boolean> {
  const rows = await tx`
    UPDATE awcms_mini_profile_identifiers
    SET deleted_at = now(), deleted_by = ${actorTenantUserId}, delete_reason = ${reason}
    WHERE tenant_id = ${tenantId} AND profile_id = ${profileId} AND id = ${identifierId}
      AND deleted_at IS NULL
    RETURNING id
  `;

  if (rows.length === 0) {
    return false;
  }

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "identifier_removed",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: identifierId,
    severity: "warning",
    message: "Identifier soft-deleted.",
    attributes: { reason },
    correlationId
  });

  return true;
}
